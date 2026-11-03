"""Transform modal_crons/app.py (main b34f469) into a plain-Python cron
runner for LightVela (no Modal). Output: cron_jobs.py.

- Drops `import modal`, the Modal images/volume/App, and all
  @app.function(...) decorators (schedules move to crontab).
- Keeps every function body + helper verbatim (same logic, same publish
  contract, same fail-open behaviour).
- volume.commit() -> no-op (LightVela disk is persistent).
- d1_backup writes to $CRON_BACKUP_DIR (default ~/backups/d1), keeps 7.
- Secrets come from env; STOCK_PUBLISH_SECRET may also be read from a
  raw-value file via $STOCK_PUBLISH_SECRET_FILE (default
  ~/.stockapp_publish). Never hardcode, never print.
- Adds a CLI dispatcher: stock_snapshot | ohlcv --mode intraday|eod |
  maintenance --mode books|backup | finhay_crosscheck.
"""
import re
import sys

SRC = "app.py"
DST = "cron_jobs.py"

src = open(SRC, encoding="utf-8").read()

# --- 1. Drop `import modal` ---------------------------------------------
src = src.replace("import modal\n", "")

# --- 2. Drop the Modal volume + images + App ------------------------------
# volume = modal.Volume.from_name(...)
src = re.sub(r"^volume = modal\.Volume\.from_name\(.*\n", "", src, flags=re.M)
# book_image = ( ... )  — multi-line, ends with ")\n\n"
src = re.sub(r"^book_image = \(\n(?:.*\n)*?^\)\n", "", src, flags=re.M)
# stock_image = ( ... ) — multi-line
src = re.sub(r"^stock_image = \(\n(?:.*\n)*?^\)\n", "", src, flags=re.M)
# app = modal.App(...)
src = re.sub(r"^app = modal\.App\(.*\n", "", src, flags=re.M)

# --- 3. Drop @app.function(...) decorators (multi-line, balanced parens) --
out_lines = []
lines = src.split("\n")
i = 0
while i < len(lines):
    line = lines[i]
    if line.startswith("@app.function("):
        # consume until the closing ")" line (the decorator ends with ")")
        depth = line.count("(") - line.count(")")
        i += 1
        while i < len(lines) and depth > 0:
            depth += lines[i].count("(") - lines[i].count(")")
            i += 1
        continue
    out_lines.append(line)
    i += 1
src = "\n".join(out_lines)

# --- 4. volume.commit() -> no-op ------------------------------------------
src = src.replace("    volume.commit()\n", "    # (LightVela: local disk is persistent, no volume commit)\n")

# --- 5. d1_backup: /data/backups/d1 -> env-configurable dir ---------------
src = src.replace(
    '    os.makedirs("/data/backups/d1", exist_ok=True)\n'
    '    key = f"/data/backups/d1/{today}.json"',
    '    backup_dir = os.environ.get("CRON_BACKUP_DIR", os.path.expanduser("~/backups/d1"))\n'
    '    os.makedirs(backup_dir, exist_ok=True)\n'
    '    key = os.path.join(backup_dir, f"{today}.json")',
)
src = src.replace(
    '    olds = sorted(glob.glob("/data/backups/d1/*.json"))',
    '    olds = sorted(glob.glob(os.path.join(backup_dir, "*.json")))',
)

# --- 6. Secret loader + CLI dispatcher (appended) --------------------------
tail = '''

# ==================== LightVela runner (no Modal) ====================
# Secrets: read from env at runtime. STOCK_PUBLISH_SECRET may also come
# from a raw-value file (0600) via STOCK_PUBLISH_SECRET_FILE; the file
# content is used as-is (stripped), never printed or logged.

def _load_publish_secret():
    """Ensure STOCK_PUBLISH_SECRET is in env, loading it from a raw-value
    file when the env var is absent. Returns True when available."""
    if os.environ.get("STOCK_PUBLISH_SECRET"):
        return True
    path = os.environ.get(
        "STOCK_PUBLISH_SECRET_FILE",
        os.path.expanduser("~/.stockapp_publish"))
    try:
        with open(path, "r", encoding="utf-8") as fh:
            val = fh.read().strip()
        if val:
            os.environ["STOCK_PUBLISH_SECRET"] = val
            return True
    except OSError:
        pass
    return False


def _run_ohlcv(mode: str):
    """Merged OHLCV (PA-3b + PA-3c + daily EOD) in ONE function.

    intraday: stocks (MIN_BARS guard + PA-4a collector overlay) + indices,
      POST stocks then indices; empty -> skip gracefully (exit 0).
    eod: stocks only (no guard, no overlay — pure KBS, the EOD final);
      empty -> exit 1 (strict, like the old publish_ohlcv_daily which
      raised so the dashboard showed Failed). Indices are NOT posted in
      eod mode: their EOD final comes from the collector slow run."""
    _load_publish_secret()
    base_dir = os.environ.get("DIRECT_FETCH_DIR", DIRECT_FETCH_DIR)
    _use_direct_fetch(base_dir)
    import source_router as rt

    from datetime import datetime, timedelta, timezone
    today_iso = datetime.now(timezone(timedelta(hours=7))).date().isoformat()

    if mode == "eod":
        payload = build_ohlcv_daily_payload(QUOTE_UNIVERSE, rt)
        if not payload["ohlcv"]:
            print("ohlcv eod: khong lay duoc nen ma nao (strict, exit 1)",
                  flush=True)
            return 1
        result = _post_publish(payload)
        print(f"ohlcv eod: {len(payload['ohlcv'])} ma -> {result}", flush=True)
        return 0

    # intraday
    import direct_fetch as df
    payload = build_ohlcv_daily_payload(QUOTE_UNIVERSE, rt)
    MIN_BARS = 100
    kept = {s: b for s, b in payload["ohlcv"].items() if len(b) >= MIN_BARS}
    dropped = len(payload["ohlcv"]) - len(kept)
    if dropped:
        print(f"ohlcv intraday: bo {dropped} ma nen < {MIN_BARS} phien",
              flush=True)
    payload["ohlcv"] = kept
    if kept:
        try:
            stats = apply_collector_today(payload, today_iso)
            print(f"ohlcv intraday: PA-4a collector overlay "
                  f"{len(stats)}/{len(kept)} ma, hom nay={today_iso}",
                  flush=True)
        except Exception as e:  # noqa: BLE001 - overlay loi khong chan POST
            print(f"ohlcv intraday: PA-4a overlay loi "
                  f"({str(e)[:120]}) -> giu KBS formed", flush=True)
        result = _post_publish(payload)
        print(f"ohlcv intraday: {len(kept)} ma -> {result}", flush=True)
    else:
        print("ohlcv intraday: khong co nen du dai -> giu file cu",
              flush=True)

    idx_payload = build_index_ohlcv_payload(df)
    if not idx_payload["ohlcv"]:
        print("ohlcv intraday: khong chi so nao qua gate -> giu file cu",
              flush=True)
        return 0
    result = _post_publish(idx_payload)
    print(f"ohlcv intraday: {len(idx_payload['ohlcv'])} chi so -> {result}",
          flush=True)
    return 0


def _run_finhay_crosscheck():
    """Standalone finhay crosscheck + the escalation alert the old Modal
    function did (the module's own main() does not send it)."""
    _load_publish_secret()
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import finhay_crosscheck

    doc = finhay_crosscheck.run(finhay_crosscheck.parse_cfg())
    if not doc:
        return 0
    s = doc["summary"]
    print(f"finhay_price_crosscheck: compared={s['compared']} "
          f"ok={s['counts'].get('ok', 0)} warn={s['counts'].get('warn', 0)} "
          f"alert={len(s['alert_symbols'])} "
          f"escalated={s['escalated_symbols']} "
          f"maxDiff={s['max_abs_diff_pct']}% refFlags={s['ref_flags']} "
          f"calls={s['finhay_calls']}", flush=True)
    if s["escalated_symbols"]:
        _finhay_alert(
            "finhay_price_crosscheck",
            f"{len(s['escalated_symbols'])} ma lech gia >=2 luot lien tiep: "
            + ", ".join(
                f"{r['symbol']} {r['diff_vnd']}d ({r['diff_pct']}%)"
                for r in doc["rows"] if r.get("escalated")),
        )
    return 0


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(
        description="Pocket Personal crons (LightVela, no Modal)")
    sub = ap.add_subparsers(dest="job", required=True)
    sub.add_parser("stock_snapshot")
    o = sub.add_parser("ohlcv")
    o.add_argument("--mode", choices=["intraday", "eod"], default="intraday")
    m = sub.add_parser("maintenance")
    m.add_argument("--mode", choices=["books", "backup"], required=True)
    sub.add_parser("finhay_crosscheck")
    args = ap.parse_args(argv)

    if args.job == "stock_snapshot":
        _load_publish_secret()
        stock_snapshot()
        return 0
    if args.job == "ohlcv":
        return _run_ohlcv(args.mode)
    if args.job == "maintenance":
        if args.mode == "books":
            book_processor()
        else:
            d1_backup()
        return 0
    if args.job == "finhay_crosscheck":
        return _run_finhay_crosscheck()
    return 2


if __name__ == "__main__":
    sys.exit(main())
'''

src += tail

open(DST, "w", encoding="utf-8").write(src)
print(f"wrote {DST}: {len(src.splitlines())} lines")

# sanity: no modal references left (except in comments/docstrings)
bad = [ln for ln in src.splitlines()
       if "modal." in ln and not ln.strip().startswith("#")
       and "modal:" not in ln and "Modal" not in ln]
print("remaining modal.* code lines:", len(bad))
for ln in bad[:10]:
    print("  ", ln)
