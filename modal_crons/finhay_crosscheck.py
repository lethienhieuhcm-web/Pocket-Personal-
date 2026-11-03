"""Đối chiếu giá Finhay ↔ hệ thống cho 47 mã QUOTE_UNIVERSE (TASK mục 1).

Chạy: python3 python/crosscheck.py [--no-session-guard] [--max-symbols=N] [--symbols=A,B]
                                    [--threshold-pct=1] [--threshold-vnd=500] [--dry-run]
                                    [--source=api|file] [--file=PATH] [--out-dir=DIR]
Bên hệ thống đọc GET /api/stock/quote?symbol=X (tức quotes.json mà refresher publish, đơn vị ĐỒNG).
Bên Finhay đọc /market/stock-realtime?symbols=<47> (1 lời gọi — đã đo: batch trả đủ 47 mã).
CHỈ ĐỌC: không ghi quotes.json, không đụng luồng giá realtime/chỉ số/nến (PA-3b/3c/4a).
Fail-open: mọi lỗi Finhay/hệ thống -> log rồi exit 0 (cron không crash).
Bản Node scripts/crosscheck.js là cổng song song; test 03/11 chạy cả hai, cùng số liệu.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta

import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from finhay_client import FinhayClient, FinhayError  # noqa: E402

QUOTE_UNIVERSE = (
    "FPT", "MBB", "HPG", "VCB", "VIC", "VHM", "MSN", "VNM", "GAS", "PLX",
    "BID", "CTG", "TCB", "VPB", "ACB", "STB", "SSI", "VCI", "HCM", "VND",
    "POW", "REE", "PNJ", "MWG", "FRT", "DGW", "SAB", "DGC", "GEX", "KBC",
    "PDR", "VRE", "VJC", "HDB", "EIB", "OCB", "TPB", "LPB", "SHB", "GVR",
    "BVH", "CMG", "VGI", "ACV", "BSR", "PVD", "PVS",
)

STOCK_APP_BASE = os.environ.get("STOCK_APP_BASE", "https://lethanhdong.one")
ICT = timezone(timedelta(hours=7))

ROOT = os.environ.get("FINHAY_DATA_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")

DEFAULTS = {
    "pct_alert": 1.0,        # % lệch -> ứng viên ALERT
    "abs_alert_vnd": 500,    # lệch tuyệt đối (đồng) -> ứng viên ALERT khi kèm pct > abs_pct_floor
    "abs_pct_floor": 0.3,
    "pct_warn": 0.5,
    "escalate_after": 2,     # ALERT cùng mã ở >= N lượt liên tiếp mới leo thang (trễ refresher <=5 phút)
    "session_guard": True,
    "source": "api",
    "file": None,
    "concurrency": 4,
    "timeout_s": 12.0,
    "dry_run": False,
    "max_symbols": None,
    "symbols": None,
}


def flag(*names):
    names = [n.strip("-") for n in names]
    return any(a.strip("-") in names for a in sys.argv)


def opt(name, cast=str, default=None):
    for a in sys.argv[1:]:
        if a.startswith(f"--{name}="):
            value = a.split("=", 1)[1]
            return cast(value) if cast else value
    return default


def ict_now(ts=None):
    return datetime.fromtimestamp(ts if ts is not None else time.time(), ICT)


def in_session_ict(ts=None):
    dt = ict_now(ts)
    if dt.weekday() > 4:  # 5=T7, 6=CN
        return False
    minutes = dt.hour * 60 + dt.minute
    return 9 * 60 <= minutes <= 15 * 60


def parse_iso(iso):
    if not iso:
        return None
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None


def ict_day(iso):
    dt = parse_iso(iso)
    return dt.astimezone(ICT).strftime("%Y-%m-%d") if dt else None


def age_minutes(iso, now=None):
    dt = parse_iso(iso)
    if not dt:
        return None
    return ((now if now is not None else time.time()) - dt.timestamp()) / 60.0


def fetch_system_quote(symbol, cfg):
    url = f"{STOCK_APP_BASE}/api/stock/quote?symbol={urllib.parse.quote(symbol)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "finhay-crosscheck/1.0.0"})
    with urllib.request.urlopen(req, timeout=cfg["timeout_s"]) as resp:
        j = json.loads(resp.read().decode("utf-8"))
    return {
        "symbol": symbol,
        "price": _num(j.get("close")),
        "reference": _num(j.get("reference")),
        "volume": _num(j.get("volume")),
        "updated_at": j.get("data_updated"),
        "prov_source": (j.get("_prov") or {}).get("source"),
    }


def parse_system_file(doc, symbol):
    row = (doc.get("by_symbol") or doc.get("quotes") or {}).get(symbol)
    if not row:
        return {"symbol": symbol, "price": None, "error": "missing in snapshot"}
    return {
        "symbol": symbol,
        "price": _num(row.get("close", row.get("price"))),
        "reference": _num(row.get("reference")),
        "volume": _num(row.get("volume")),
        "updated_at": row.get("updated_at") or doc.get("updated"),
        "prov_source": row.get("source") or doc.get("source") or "quotes.json",
    }


def skip_reason(row):
    if row.get("error"):
        return row["error"]
    if row["finhay_price"] is None:
        return "finhay null price"
    if row["system_price"] is None:
        return "system null price"
    fd, sd = ict_day(row["finhay_created_at"]), ict_day(row["system_updated_at"])
    if fd and sd and fd != sd:
        return f"cross-session finhay={fd} system={sd}"
    return None


def classify(row, cfg):
    if row["skip_reason"]:
        return "skip"
    pct, diff = abs(row["diff_pct"]), abs(row["diff_vnd"])
    if pct > cfg["pct_alert"] or (diff > cfg["abs_alert_vnd"] and pct > cfg["abs_pct_floor"]):
        return "alert"
    if pct > cfg["pct_warn"]:
        return "warn"
    return "ok"


def ref_flag(row):
    f, s = row["finhay_ref"], row["system_ref"]
    if f is None and s is None:
        return None
    if not s and f:
        return "system_ref_missing"
    if s and not f:
        return "finhay_ref_missing"
    if f != s:
        return "ref_mismatch"
    return None


def parse_cfg():
    cfg = dict(DEFAULTS)
    cfg["session_guard"] = not flag("no-session-guard")
    cfg["dry_run"] = flag("dry-run")
    cfg["source"] = opt("source", str, cfg["source"])
    cfg["file"] = opt("file", str, None)
    cfg["pct_alert"] = opt("threshold-pct", float, cfg["pct_alert"])
    cfg["abs_alert_vnd"] = opt("threshold-vnd", int, cfg["abs_alert_vnd"])
    cfg["pct_warn"] = opt("warn-pct", float, cfg["pct_warn"])
    cfg["max_symbols"] = opt("max-symbols", int, None)
    cfg["symbols"] = opt("symbols", str, None)
    return cfg


def run(cfg=None):
    """Doi chieu 1 luot. Tra ve doc (schema finhay.crosscheck.v1) hoac None Neu bo qua
    (ngoai gio phien / Finhay loi) — cron chi can in tom tat, khong crash."""
    cfg = cfg or parse_cfg()
    started = time.time()
    if cfg["session_guard"] and not in_session_ict(started):
        print(f"[crosscheck] ngoài giờ phiên ICT ({ict_now(started).strftime('%Y-%m-%d %H:%M:%S')}) — bỏ qua, exit 0")
        return None

    symbols = [s.strip().upper() for s in cfg["symbols"].split(",")] if cfg["symbols"] else list(QUOTE_UNIVERSE)
    if cfg["max_symbols"]:
        symbols = symbols[: cfg["max_symbols"]]

    client = FinhayClient(logger=lambda m: print("  !", m, file=sys.stderr))
    try:
        r = client.get("/market/stock-realtime", "symbols=" + ",".join(symbols))
        finhay = {x["symbol"]: x for x in (r["data"] or [])}
    except (FinhayError, OSError, ValueError) as err:
        print(f"[crosscheck] Finhay LỖI — bỏ qua lượt (fail-open): {err}")
        return None

    sys_doc = None
    if cfg["source"] == "file":
        try:
            with open(cfg["file"] or os.path.join(ROOT, "finhay", "system", "quotes.json"), encoding="utf-8") as fh:
                sys_doc = json.load(fh)
        except (OSError, ValueError) as err:
            print(f"  ! hệ thống snapshot lỗi: {err}", file=sys.stderr)

    def read_one(sym):
        try:
            return sym, (parse_system_file(sys_doc, sym) if sys_doc else fetch_system_quote(sym, cfg))
        except Exception as err:  # noqa: BLE001 - mọi lỗi phía hệ thống đều chỉ làm mất 1 mã
            return sym, {"symbol": sym, "price": None, "error": str(err)[:120]}

    with ThreadPoolExecutor(max_workers=cfg["concurrency"]) as pool:
        system = dict(pool.map(read_one, symbols))

    state_path = os.path.join(ROOT, "finhay", "crosscheck", "state.json")
    streaks = {}
    try:
        with open(state_path, encoding="utf-8") as fh:
            streaks = (json.load(fh) or {}).get("streaks", {})
    except (OSError, ValueError):
        streaks = {}

    rows = []
    for sym in symbols:
        f = finhay.get(sym) or {}
        s = system.get(sym) or {}
        fp, sp = _num(f.get("price")), _num(s.get("price"))
        row = {
            "symbol": sym,
            "finhay_price": fp,
            "system_price": sp,
            "finhay_ref": _num(f.get("reference")),
            "system_ref": _num(s.get("reference")),
            "finhay_total_volume": _num(f.get("totalVolume")),
            "system_volume": _num(s.get("volume")),
            "diff_vnd": round(fp - sp) if fp is not None and sp is not None else None,
            "diff_pct": round((fp - sp) / sp * 100, 4) if fp is not None and sp not in (None, 0) else None,
            "finhay_created_at": new_date_iso(f.get("createdAt")),
            "system_updated_at": s.get("updated_at"),
            "system_source": s.get("prov_source"),
            "finhay_age_min": round((time.time() - f["createdAt"] / 1000) / 60, 1) if f.get("createdAt") else None,
            "system_age_min": round(age_minutes(s.get("updated_at"), started), 1) if s.get("updated_at") else None,
            "error": s.get("error") if s.get("error") else (None if f else "finhay missing"),
        }
        row["skip_reason"] = skip_reason(row)
        row["level"] = classify(row, cfg)
        row["ref_flag"] = ref_flag(row)
        if row["level"] == "alert":
            streaks[sym] = streaks.get(sym, 0) + 1
        elif row["level"] != "skip":
            streaks[sym] = 0
        row["streak"] = streaks.get(sym, 0)
        row["escalated"] = row["level"] == "alert" and row["streak"] >= cfg["escalate_after"]
        rows.append(row)

    counts = {}
    for row in rows:
        counts[row["level"]] = counts.get(row["level"], 0) + 1
    compared = [r for r in rows if r["level"] != "skip"]
    alerts = [r for r in rows if r["level"] == "alert"]
    ref_flags = {}
    for row in rows:
        if row["ref_flag"]:
            ref_flags[row["ref_flag"]] = ref_flags.get(row["ref_flag"], 0) + 1
    volumes_equal = sum(1 for r in rows if r["finhay_total_volume"] is not None and r["finhay_total_volume"] == r["system_volume"])
    sys_ages = [r["system_age_min"] for r in rows if r["system_age_min"] is not None]

    doc = {
        "schema": "finhay.crosscheck.v1",
        "source": "finhay",
        "endpoint": "/market/stock-realtime?symbols=<47> + /api/stock/quote?symbol=<each>",
        "params": {k: v for k, v in cfg.items() if k not in ("dry_run",)},
        "note": "Finhay dung lam chuan doi chieu gia; KHONG phai nguon chart/realtime cua he thong.",
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fetched_at_ict": ict_now().strftime("%Y-%m-%d %H:%M:%S") + " ICT",
        "ttl_seconds": 900,
        "ok": True,
        "errors": [],
        "rows": rows,
        "summary": {
            "universe": len(symbols),
            "compared": len(compared),
            "skipped": counts.get("skip", 0),
            "counts": counts,
            "ref_flags": ref_flags,
            "volume_exact_match": volumes_equal,
            "system_feed_lag_min": round(min(sys_ages), 1) if sys_ages else None,
            "max_abs_diff_pct": max((abs(r["diff_pct"]) for r in rows if r["diff_pct"] is not None), default=0),
            "max_abs_diff_vnd": max((abs(r["diff_vnd"]) for r in rows if r["diff_vnd"] is not None), default=0),
            "alert_symbols": [r["symbol"] for r in alerts],
            "escalated_symbols": [r["symbol"] for r in alerts if r["escalated"]],
            "thresholds": {
                "pct_alert": cfg["pct_alert"], "abs_alert_vnd": cfg["abs_alert_vnd"],
                "abs_pct_floor": cfg["abs_pct_floor"], "pct_warn": cfg["pct_warn"],
                "escalate_after": cfg["escalate_after"],
            },
            "finhay_calls": client.calls,
            "elapsed_ms": int((time.time() - started) * 1000),
        },
    }

    if not cfg["dry_run"]:
        write_json(os.path.join(ROOT, "finhay", "crosscheck", "latest.json"), doc)
        write_json(state_path, {"updated_at": doc["fetched_at"], "streaks": streaks})
        append_jsonl(os.path.join(ROOT, "finhay", "crosscheck", "history", ict_now(started).strftime("%Y-%m-%d") + ".jsonl"),
                     {"at": doc["fetched_at"], **doc["summary"]})

    s = doc["summary"]
    print(
        f"[crosscheck] {doc['fetched_at_ict']} ICT compared={s['compared']} skip={s['skipped']} "
        f"ok={counts.get('ok', 0)} warn={counts.get('warn', 0)} alert={len(s['alert_symbols'])} "
        f"escalated={len(s['escalated_symbols'])} maxDiff={s['max_abs_diff_pct']}%/{s['max_abs_diff_vnd']}d "
        f"volExact={s['volume_exact_match']}/{s['universe']} refFlags={json.dumps(s['ref_flags'])} "
        f"sysLag={s['system_feed_lag_min']}min finhayCalls={s['finhay_calls']} in {s['elapsed_ms']}ms"
    )
    for row in alerts[:10]:
        print(f"  ALERT {row['symbol']} finhay={row['finhay_price']} system={row['system_price']} "
              f"diff={row['diff_vnd']}d ({row['diff_pct']}%) streak={row['streak']}")
    return doc


def main():
    """CLI: luon exit 0 (fail-open) — Modal cron / crontab khong duoc crash vi 1 luot loi."""
    run()
    return 0


def new_date_iso(ms):
    if not ms:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + "Z"


def _num(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if isinstance(value, float) else value
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def write_json(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def append_jsonl(path, line):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(line, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # noqa: BLE001 - fail-open cho cron
        print(f"[crosscheck] FATAL (fail-open, exit 0): {str(err)[:300]}", file=sys.stderr)
        try:
            append_jsonl(os.path.join(ROOT, "finhay", "crosscheck", "errors.jsonl"),
                         {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "error": str(err)[:300]})
        except OSError:
            pass
        sys.exit(0)
