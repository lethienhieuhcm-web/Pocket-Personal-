"""Ban thu sang ngay flow tren Modal (Henrry Chot huong Modal-first 27/10).

Chi doc KBS + tra ket qua ve caller. KHONG ghi file live (khong dung
flow_watchlist.json / flow_daily_context.json), KHONG lich chay,
KHONG deploy app lau dai — chi `modal run` theo pattern spike 26/10.
Tai su dung ham compute() goc trong flow_screen_daily.py (khong
chep lai cong thuc) de doi chieu parity voi ban chay local.
File ho tro trong flow_screen_trial/ la snapshot ngay 27/10 cua
script stock-app (byte-identical, xem README) — khong sua rieng.
"""
import json
import os
import sys
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
TRIAL_DIR = os.path.join(HERE, "flow_screen_trial")

app = modal.App("flow-screen-trial")

image = (
    modal.Image.debian_slim()
    .add_local_file(os.path.join(TRIAL_DIR, "direct_fetch.py"),
                    "/root/direct_fetch.py")
    .add_local_file(os.path.join(TRIAL_DIR, "flow_screen_daily.py"),
                    "/root/flow_screen_daily.py")
    .add_local_file(os.path.join(TRIAL_DIR, "universe.json"),
                    "/root/flow_universe_modal.json")
)


@app.function(image=image, timeout=7200)
def run_screen(symbols: list[str], end: str, pace_s: float) -> dict:
    sys.path.insert(0, "/root")
    import direct_fetch as df  # noqa: E402
    import flow_screen_daily as fs  # noqa: E402

    start = fs.datetime.strptime(end, "%Y-%m-%d").date() - fs.timedelta(days=110)
    start = start.isoformat()
    ctx: dict[str, dict] = {}
    skipped = 0
    t0 = time.time()
    for sym in symbols:
        try:
            bars = df.kbs_ohlcv(sym, start, end)
            bars = sorted(bars, key=lambda b: str(b.get("time")))
            c = fs.compute(bars)
            if c is None:
                skipped += 1
            else:
                ctx[sym] = c
        except Exception as e:  # noqa: BLE001
            skipped += 1
            print(f"[modal-screen] {sym} LOI: {type(e).__name__}: {e}",
                  flush=True)
        time.sleep(pace_s)
    gated = {s: c for s, c in ctx.items()
             if c["avg_val20"] >= fs.VAL_MIN_VND
             and fs.POS_LO <= c["pos60"] <= fs.POS_HI
             and c["updown20"] >= fs.UPDOWN_MIN}
    ranked = sorted(gated.items(),
                    key=lambda kv: (kv[1]["updown20"], kv[1]["rvol1d"]),
                    reverse=True)
    cands = [{"symbol": s, **c} for s, c in ranked[: fs.TOP_N]]
    return {
        "screen_date": end,
        "universe": len(symbols),
        "computed": len(ctx),
        "skipped": skipped,
        "wall_s": round(time.time() - t0, 1),
        "candidates": cands,
        "symbols": ctx,
    }


@app.local_entrypoint()
def main(symbols: str = "", end: str = "", pace_s: float = 1.5):
    if symbols:
        syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    else:
        syms = json.load(open(os.path.join(TRIAL_DIR, "universe.json"),
                              encoding="utf-8"))
    if not end:
        end = fs_today()
    res = run_screen.remote(syms, end, pace_s)
    print("FLOW_TRIAL_JSON_START")
    print(json.dumps(res, ensure_ascii=False))
    print("FLOW_TRIAL_JSON_END")
    out = os.path.join(HERE, "flow_screen_modal_trial_out.json")
    tmp = out + ".tmp"
    json.dump(res, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, out)
    print(f"[modal-screen] da ghi {out}")


def fs_today() -> str:
    from datetime import datetime, timezone, timedelta
    return (datetime.now(timezone.utc) + timedelta(hours=7)).strftime("%Y-%m-%d")
