"""Session runner (§3, §6 dac ta): noi gate + consumer + store + WAL.

1 process: gate thread DNSE (GĐ1) -> WAL -> shared queue bounded ->
consumer thread duy nhat -> SQLite + checkpoint + status. Resume: nap
state SQLite + replay WAL tail sau last_seq neu checkpoint cung ngay;
khac ngay thi xoay file cu sang archive/, bat dau phien moi.

Dung bang SIGINT/SIGTERM hoac --minutes. Ket thuc in summary JSON (on ao).
"""
import argparse
import datetime
import json
import logging
import os
import queue
import shutil
import signal
import threading
import time

from .consumer import Consumer, FLUSH_SEC, QUEUE_MAX
from .envelope import Envelope
from .gate import DnseGate, GATE
from .rights import load_rights_calendar
from .store import SessionStore
from .wal import read_wal

ICT = datetime.timezone(datetime.timedelta(hours=7))
log = logging.getLogger("collector.session")


def ict_today():
    return datetime.datetime.now(datetime.timezone.utc).astimezone(ICT).date().isoformat()


def default_watchdog_armed():
    """Watchdog chi armed trong gio giao dich 09:00-15:05 ICT, thu 2-6."""
    now = datetime.datetime.now(datetime.timezone.utc).astimezone(ICT)
    if now.weekday() >= 5:
        return False
    return datetime.time(9, 0) <= now.time() <= datetime.time(15, 5)


class SessionConfig:
    def __init__(self, symbols, out_dir, session_date=None, ws_url=None,
                 client_id=None, flush_sec=FLUSH_SEC, queue_max=QUEUE_MAX,
                 silence_sec=120, minutes=None, rights_calendar=None):
        self.symbols = symbols
        self.out_dir = out_dir
        self.session_date = session_date or ict_today()
        self.ws_url = ws_url
        self.client_id = client_id
        self.flush_sec = flush_sec
        self.queue_max = queue_max
        self.silence_sec = silence_sec
        self.minutes = minutes
        self.rights_calendar = rights_calendar


def _read_checkpoint(out_dir):
    path = os.path.join(out_dir, "checkpoint.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _rotate_old_session(out_dir, old_date):
    dest = os.path.join(out_dir, "archive", old_date)
    os.makedirs(dest, exist_ok=True)
    for name in ("session.db", "session.db-wal", "session.db-shm",
                 "checkpoint.json", f"raw_{GATE}.jsonl"):
        src = os.path.join(out_dir, name)
        if os.path.exists(src):
            shutil.move(src, os.path.join(dest, name))
    log.warning("phien cu %s xoay sang %s, bat dau phien moi", old_date, dest)


def run_session(cfg, stop_event=None):
    stop_event = stop_event or threading.Event()
    os.makedirs(cfg.out_dir, exist_ok=True)
    ckpt = _read_checkpoint(cfg.out_dir)
    if ckpt and ckpt.get("session_date") != cfg.session_date:
        _rotate_old_session(cfg.out_dir, ckpt["session_date"])
        ckpt = None
    store = SessionStore(os.path.join(cfg.out_dir, "session.db"))
    rights_events = {}
    if cfg.rights_calendar:
        if os.path.exists(cfg.rights_calendar):
            rights_events = load_rights_calendar(cfg.rights_calendar,
                                                 cfg.session_date)
            log.warning("lich quyen: %d ma co su kien ngay %s",
                        len(rights_events), cfg.session_date)
        else:
            log.warning("LICH QUYEN THIEU: %s khong ton tai — envelope khong co co ex_date",
                        cfg.rights_calendar)
    consumer = Consumer(cfg.session_date, store, cfg.out_dir,
                        flush_sec=cfg.flush_sec, rights_events=rights_events)
    gap_q = queue.Queue()
    consumer.gap_queue = gap_q
    resumed = False
    if ckpt:
        consumer.load_state()
        last_seq = ckpt.get("last_seq") or {}
        replayed = 0
        for d in read_wal(os.path.join(cfg.out_dir, f"raw_{GATE}.jsonl"),
                          after_seq=last_seq):
            consumer.process(Envelope.from_dict(d))
            replayed += 1
        log.warning("resume: nap state + replay WAL %d envelope", replayed)
        resumed = True
    q = queue.Queue(maxsize=cfg.queue_max)
    gate = DnseGate(cfg.symbols, q, gap_q, cfg.out_dir, ws_url=cfg.ws_url,
                    client_id=cfg.client_id, silence_sec=cfg.silence_sec,
                    watchdog_armed=default_watchdog_armed,
                    stop_event=stop_event)
    consumer_thread = threading.Thread(target=consumer.run, args=(q, stop_event),
                                       name="consumer", daemon=True)
    consumer_thread.start()
    gate.start()
    status_thread = threading.Thread(
        target=_status_loop,
        args=(cfg, consumer, gate, q, stop_event), name="status", daemon=True)
    status_thread.start()
    deadline = (time.monotonic() + cfg.minutes * 60) if cfg.minutes else None
    try:
        while not stop_event.is_set():
            if deadline is not None and time.monotonic() >= deadline:
                stop_event.set()
                break
            stop_event.wait(1.0)
    finally:
        stop_event.set()
        gate.join(timeout=30)
        consumer_thread.join(timeout=30)
        open_gap = gate.drain_open_gap(time.time())
        if open_gap:
            store.add_gap(open_gap["gate"], open_gap["down_ts"],
                          open_gap["up_ts"], open_gap["seconds"],
                          open_gap["error"])
        _write_status(cfg, consumer, gate, q, final=True)
        summary = {"resumed": resumed, "flush_count": consumer.flush_count,
                   "guard": consumer.guard.counters.summary(),
                   "counters": consumer.counters.summary(),
                   "gate": gate.stats.snapshot()}
        log.warning("ket thuc phien: %s", json.dumps(summary, ensure_ascii=False))
        store.close()
        print(json.dumps(summary, ensure_ascii=False, indent=1))
        return summary


def _status_snapshot(cfg, consumer, gate, q):
    return {"session_date": cfg.session_date, "ts": time.time(),
            "gate": gate.stats.snapshot(),
            "guard": consumer.guard.counters.summary(),
            "counters": consumer.counters.summary(),
            "queue_depth": q.qsize(), "queue_max": cfg.queue_max,
            "flush_count": consumer.flush_count}


def _write_status(cfg, consumer, gate, q, final=False):
    data = _status_snapshot(cfg, consumer, gate, q)
    data["final"] = final
    tmp = os.path.join(cfg.out_dir, "status.json.tmp")
    final_path = os.path.join(cfg.out_dir, "status.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, final_path)


def _status_loop(cfg, consumer, gate, q, stop_event):
    while not stop_event.is_set():
        try:
            _write_status(cfg, consumer, gate, q)
        except Exception:
            log.exception("ghi status that bai")
        stop_event.wait(5.0)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Collector GĐ1: gate DNSE -> WAL -> SQLite")
    ap.add_argument("--symbols", required=False, default=None,
                    help="ma, cach nhau bang dau phay (hoac dung --symbols-file)")
    ap.add_argument("--symbols-file", default=None,
                    help="file JSON array hoac moi dong 1 ma (universe du ma)")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--date", default=None, help="session_date YYYY-MM-DD (mac dinh: hom nay ICT)")
    ap.add_argument("--ws-url", default=None)
    ap.add_argument("--client-id", default=None)
    ap.add_argument("--flush-sec", type=int, default=FLUSH_SEC)
    ap.add_argument("--silence-sec", type=int, default=120)
    ap.add_argument("--minutes", type=float, default=None,
                    help="dung sau N phut (de chay thu)")
    ap.add_argument("--rights-calendar", default=None,
                    help="duong dan corporate_actions.json (co ex_date/corp_action, khong mien guard T0)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    symbols = []
    if args.symbols_file:
        with open(args.symbols_file, encoding="utf-8") as f:
            raw = f.read().strip()
        if raw.startswith("["):
            symbols = [str(s).strip().upper() for s in json.loads(raw)]
        else:
            symbols = [ln.strip().upper() for ln in raw.splitlines() if ln.strip()]
    if args.symbols:
        symbols += [s.strip() for s in args.symbols.split(",") if s.strip()]
    if not symbols:
        ap.error("can --symbols hoac --symbols-file")
    cfg = SessionConfig(symbols,
                        args.out_dir, session_date=args.date,
                        ws_url=args.ws_url, client_id=args.client_id,
                        flush_sec=args.flush_sec, silence_sec=args.silence_sec,
                        minutes=args.minutes,
                        rights_calendar=args.rights_calendar)
    stop_event = threading.Event()

    def _sig(*_a):
        stop_event.set()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    run_session(cfg, stop_event)


if __name__ == "__main__":
    main()
