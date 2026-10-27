#!/usr/bin/env python3
"""Sang ngay cho flow 2 tang (Henrry chot 27/10): tu du lieu ngay KBS,
tim ma tiem nang -> watchlist cho phien mai.

Chay toi (sau dong cua): lay bar ngay toi `end` (mac dinh: hom nay VN),
tinh boi canh moi ma (range 60 phien, EMA50, up/down vol 20 phien,
RVOL ngay cuoi), loc + xep hang -> watchlist.

Luat ban test (don gian, de kiem chung code chay; hieu chuan sau):
- Gates: gia tri TB20 >= 2 ty; vi tri trong range60 0.2-0.95;
  upVol/downVol 20 phien >= 1.15.
- Diem: upVol/downVol giam dan, tie-break RVOL ngay cuoi. Lay top 20.
- Universe: symbol distinct trong warehouse screener_history.
- Luu y KBS: tra DESCENDING -> phai sort ASC truoc khi cat (bai hoc
  flow baseline 27/10).
- File live chi ghi khi computed >= 100 ma (tranh watchlist rac khi
  KBS chet hang loat); ban test (--test) ghi file _test, trial khong doc.
- Boi canh them (27/10): cmf20/obv20/mfi14 (hien thi + kiem chung,
  CHUA lam gate — gate chi sau khi hieu chuan tren du lieu 2 nam).
"""
from __future__ import annotations
import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import direct_fetch as df  # noqa: E402

WAREHOUSE = os.path.expanduser("~/workspace/stock-app/data/warehouse.db")
OUT_DIR = HERE
VAL_MIN_VND = 2e9
POS_LO, POS_HI = 0.2, 0.95
UPDOWN_MIN = 1.15
TOP_N = 20
PACE_S = 1.5


def vn_today() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=7)).strftime("%Y-%m-%d")


def next_weekday(d: str) -> str:
    dt = datetime.strptime(d, "%Y-%m-%d").date()
    while True:
        dt += timedelta(days=1)
        if dt.weekday() < 5:
            return dt.isoformat()


def load_universe() -> list[str]:
    con = sqlite3.connect(f"file:{WAREHOUSE}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT DISTINCT symbol FROM screener_history ORDER BY symbol"
        ).fetchall()
    finally:
        con.close()
    return [r[0] for r in rows if r[0]]


def ema50(closes: list[float]) -> float:
    k = 2 / 51
    ema = sum(closes[:50]) / 50
    for c in closes[50:]:
        ema = c * k + ema * (1 - k)
    return ema


def compute(bars: list[dict]) -> dict | None:
    """bars da sort ASC. Can >= 61 bar. Tra dict boi canh hoac None."""
    bars = [b for b in bars
            if b.get("close") and b.get("high") and b.get("low")
            and float(b["close"]) > 0]
    if len(bars) < 61:
        return None
    closes = [float(b["close"]) for b in bars]
    vols = [float(b.get("volume") or 0) for b in bars]
    last60 = bars[-60:]
    hi = max(float(b["high"]) for b in last60 if b.get("high"))
    lo = min(float(b["low"]) for b in last60 if b.get("low"))
    if hi <= lo:
        return None
    close = closes[-1]
    pos = (close - lo) / (hi - lo)
    # 20 thay doi gan nhat: can 21 bar (bar dau lam moc so sanh).
    win = bars[-21:]
    up = down = 0.0
    for prev, cur in zip(win, win[1:]):
        pv, cv = float(prev.get("volume") or 0), float(cur.get("volume") or 0)
        pc, cc = float(prev["close"]), float(cur["close"])
        if cc > pc:
            up += cv
        elif cc < pc:
            down += cv
    if up <= 0 and down <= 0:
        return None
    updown = 99.0 if down <= 0 else up / down
    last20 = bars[-20:]
    avg_val = sum(float(b.get("volume") or 0) * float(b["close"])
                  for b in last20) / 20
    avg_vol20 = sum(vols[-20:]) / 20
    prev20_vol = [float(b.get("volume") or 0) for b in bars[-21:-1]]
    mean_prev = sum(prev20_vol) / len(prev20_vol) if prev20_vol else 0
    rvol = (vols[-1] / mean_prev) if mean_prev > 0 else 0.0
    e50 = ema50(closes)
    # CMF20: tong money-flow-volume 20 phien / tong volume 20 phien.
    mfv20 = 0.0
    for b in bars[-20:]:
        h, l, c = float(b["high"]), float(b["low"]), float(b["close"])
        v = float(b.get("volume") or 0)
        clv = ((c - l) - (h - c)) / (h - l) if h > l else 0.0
        mfv20 += clv * v
    vol20 = sum(vols[-20:])
    cmf20 = mfv20 / vol20 if vol20 > 0 else 0.0
    # OBV20: thay doi OBV 20 phien, don vi = so phien volume TB.
    obv = [0.0]
    for i in range(1, len(closes)):
        if closes[i] > closes[i - 1]:
            obv.append(obv[-1] + vols[i])
        elif closes[i] < closes[i - 1]:
            obv.append(obv[-1] - vols[i])
        else:
            obv.append(obv[-1])
    obv20 = (obv[-1] - obv[-21]) / avg_vol20 if avg_vol20 > 0 else 0.0
    # MFI14: typical price * volume, dong tien len/xuong 14 phien.
    tp = [(float(b["high"]) + float(b["low"]) + float(b["close"])) / 3
          for b in bars]
    posf = negf = 0.0
    for i in range(len(tp) - 14, len(tp)):
        rmf = tp[i] * vols[i]
        if tp[i] > tp[i - 1]:
            posf += rmf
        elif tp[i] < tp[i - 1]:
            negf += rmf
    mfi14 = 100.0 if negf == 0 else 100 - 100 / (1 + posf / negf)
    return {
        "close": close,
        "pos60": round(pos, 3),
        "ema50": round(e50, 0),
        "above_ema50": close > e50,
        "updown20": round(updown, 3),
        "rvol1d": round(rvol, 3),
        "avg_vol20": round(avg_vol20, 0),
        "avg_val20": round(avg_val, 0),
        "cmf20": round(cmf20, 3),
        "obv20": round(obv20, 2),
        "mfi14": round(mfi14, 1),
    }


def save_json(path: str, obj) -> None:
    tmp = path + ".tmp"
    json.dump(obj, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--end", default=vn_today())
    ap.add_argument("--symbols", default="")
    ap.add_argument("--test", action="store_true")
    args = ap.parse_args()
    end = args.end
    start = (datetime.strptime(end, "%Y-%m-%d").date()
             - timedelta(days=110)).isoformat()
    if args.symbols:
        universe = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    else:
        try:
            universe = load_universe()
        except Exception as e:  # noqa: BLE001
            print(f"[screen] khong lay duoc universe: {e}", flush=True)
            return 2
    print(f"[screen] end={end} universe={len(universe)}"
          f"{' TEST' if args.test else ''}", flush=True)
    ctx: dict[str, dict] = {}
    skipped = 0
    for i, sym in enumerate(universe):
        try:
            bars = df.kbs_ohlcv(sym, start, end)
            bars = sorted(bars, key=lambda b: str(b.get("time")))
            c = compute(bars)
            if c is None:
                skipped += 1
            else:
                ctx[sym] = c
        except Exception as e:  # noqa: BLE001
            skipped += 1
            if i < 5 or skipped % 100 == 0:
                print(f"[screen] {sym} LOI: {type(e).__name__}",
                      flush=True)
        time.sleep(PACE_S)
    print(f"[screen] computed={len(ctx)} skipped={skipped}", flush=True)
    if not args.test and len(ctx) < 100:
        print("[screen] computed qua it, KHONG ghi file live", flush=True)
        return 1
    gated = {s: c for s, c in ctx.items()
             if c["avg_val20"] >= VAL_MIN_VND
             and POS_LO <= c["pos60"] <= POS_HI
             and c["updown20"] >= UPDOWN_MIN}
    ranked = sorted(gated.items(),
                    key=lambda kv: (kv[1]["updown20"], kv[1]["rvol1d"]),
                    reverse=True)
    cands = [{"symbol": s, **c} for s, c in ranked[:TOP_N]]
    print(f"[screen] gated={len(gated)} candidates={len(cands)}", flush=True)
    for c in cands:
        print(f"  {c['symbol']}: updown={c['updown20']} pos60={c['pos60']} "
              f"rvol1d={c['rvol1d']} avgVal={c['avg_val20']/1e9:.1f}ty",
              flush=True)
    suffix = "_test" if args.test else ""
    save_json(os.path.join(OUT_DIR, f"flow_daily_context{suffix}.json"),
              {"screen_date": end, "universe": len(universe),
               "computed": len(ctx), "symbols": ctx})
    save_json(os.path.join(OUT_DIR, f"flow_watchlist{suffix}.json"),
              {"screen_date": end,
               "for_date": "TEST" if args.test else next_weekday(end),
               "candidates": cands})
    print(f"[screen] da ghi file{' TEST' if args.test else ''}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
