"""Test vong loop GĐ1: WAL + consumer + store + gate qua mock broker.

Chay offline hoan toan (127.0.0.1, stdlib). Khong secret that, khong mang.
"""
import datetime
import json
import os
import queue
import random
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mock_broker import MockBroker  # noqa: E402 (them tests/ vao sys.path o tren cho ca 2 cach chay)
from collector import dnse_wire, protobuf
from collector.consumer import Consumer
from collector.envelope import Envelope
from collector.fieldmap import load_map
from collector.gate import DnseGate, backoff_delay
from collector.store import SessionStore
from collector.wal import WalWriter, read_wal

ICT = datetime.timezone(datetime.timedelta(hours=7))
MAP = load_map()
# Gio "hien tai" cua test: guard T2 do (recv_ts - ts) theo gio thuc, nen ts
# cua tin phai gan gio chay test (khong dung gio co dinh 09:15 nua).
NOW = time.time()
SESSION_DATE = datetime.datetime.fromtimestamp(NOW, tz=ICT).date().isoformat()


def _minute_now(offset_min=0):
    return (int(NOW) // 60 + offset_min) * 60


def _ts(h, m, s=0, day=29):
    return int(datetime.datetime(2026, 10, day, h, m, s, tzinfo=ICT).timestamp())


def _tick_payload(price=55.0, vol_lots=60, acc_lots=160, ts=None):
    ts = int(NOW) if ts is None else ts
    time_node = protobuf.encode_varint_field(1, ts)
    tick = (protobuf.encode_double_field(5, price)
            + protobuf.encode_varint_field(6, vol_lots)
            + protobuf.encode_varint_field(10, acc_lots)
            + protobuf.encode_nested_field(7, time_node))
    return protobuf.encode_nested_field(45, tick)


def _stockinfo_payload():
    info = (protobuf.encode_double_field(13, 55.0)
            + protobuf.encode_varint_field(22, 100)
            + protobuf.encode_varint_field(25, 88)
            + protobuf.encode_varint_field(58, 98)
            + protobuf.encode_varint_field(17, 50))
    return protobuf.encode_nested_field(41, info)


def _match(sym="UIC", price=55.0, vol=600.0, acc=1600.0, ts=None, recv=None):
    ts = int(NOW) if ts is None else ts
    return Envelope(gate="dnse", kind="match", sym=sym, ts=ts,
                    recv_ts=time.time() if recv is None else recv,
                    price=price, vol=vol, acc=acc)


class TestBackoff(unittest.TestCase):
    def test_delay_bounds(self):
        rng = random.Random(42)
        bases = [2, 5, 15, 30, 60, 60, 60, 60]
        for attempt, base in enumerate(bases):
            d = backoff_delay(attempt, rng)
            self.assertGreaterEqual(d, base * 0.75)
            self.assertLessEqual(d, base * 1.25)


class TestWal(unittest.TestCase):
    def test_append_flush_read_after_seq(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "raw_dnse.jsonl")
            w = WalWriter(path, batch_max=2, batch_max_age=3600)
            envs = [_match() for _ in (1, 2, 3)]
            for i, e in enumerate(envs):
                e.seq = i + 1
                w.append(e.to_dict())
                w.flush_if_due()
            self.assertEqual(w.written, 2)
            self.assertEqual(w.buffered, 1)
            w.flush()
            w.close()
            rows = read_wal(path)
            self.assertEqual([r["seq"] for r in rows], [1, 2, 3])
            self.assertEqual(read_wal(path, after_seq={"dnse": 2}),
                             [rows[2]])
            env2 = Envelope.from_dict(rows[0])
            self.assertEqual((env2.sym, env2.price, env2.vol, env2.acc),
                             ("UIC", 55.0, 600.0, 1600.0))


class TestStore(unittest.TestCase):
    def test_flush_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            store = SessionStore(os.path.join(d, "session.db"))
            minute = _ts(9, 15) // 60 * 60
            store.flush_buckets({("dnse", "UIC", minute): (55000.0, 55500.0, 55000.0, 55500.0, 900.0, 1.0, 2.0, 0)})
            store.flush_snapshots({("dnse", "UIC"): (123.0, {"day_low": 55000.0}, {"day_low": "dnse"})})
            store.flush_dedup({("dnse", "UIC", "acc", "1600.0")})
            store.flush_preopen({("dnse", "UIC", 0): (1600.0, 5.0, 4.0, 0)})
            store.add_restatement("dnse", "UIC", minute, (1, 2, 3, 4, 5, 6, 7), 8.0)
            store.add_gap("dnse", 1.0, 2.0, 1.0, "test")
            self.assertEqual(store.load_buckets()[("dnse", "UIC", minute)][4], 900.0)
            self.assertEqual(store.load_snapshots()[("dnse", "UIC")][1]["day_low"], 55000.0)
            self.assertIn(("dnse", "UIC", "acc", "1600.0"), store.load_dedup_keys())
            self.assertEqual(store.load_preopen()[("dnse", "UIC", 0)][0], 1600.0)
            rows = store.conn.execute("SELECT COUNT(*) FROM restatements").fetchone()
            self.assertEqual(rows[0], 1)
            rows = store.conn.execute("SELECT COUNT(*) FROM gaps").fetchone()
            self.assertEqual(rows[0], 1)
            store.close()


class TestConsumer(unittest.TestCase):
    def _consumer(self, tmp):
        store = SessionStore(os.path.join(tmp, "session.db"))
        return Consumer(SESSION_DATE, store, tmp, flush_sec=3600), store

    def test_bucket_aggregation(self):
        with tempfile.TemporaryDirectory() as d:
            c, store = self._consumer(d)
            m = _minute_now()
            c.process(_match(price=55.0, vol=600.0, ts=m + 10))
            c.process(_match(price=56.0, vol=300.0, acc=1900.0, ts=m + 20))
            c.process(_match(price=54.0, vol=100.0, acc=2000.0, ts=m + 30))
            c.flush()
            rows = store.load_buckets()
            b = rows[("dnse", "UIC", m // 60 * 60)]
            self.assertEqual(b[:5], (55.0, 56.0, 54.0, 54.0, 1000.0))
            self.assertEqual(b[5], m + 10)
            self.assertEqual(b[6], m + 30)
            store.close()

    def test_t1_rejects_old_day_and_quarantines(self):
        with tempfile.TemporaryDirectory() as d:
            c, store = self._consumer(d)
            old = _match(ts=_ts(14, 30, day=28))
            self.assertEqual(c.process(old), "reject_t1")
            c.flush()
            qpath = os.path.join(d, "quarantine_dnse.jsonl")
            self.assertTrue(os.path.exists(qpath))
            rec = json.loads(open(qpath, encoding="utf-8").readline())
            self.assertEqual(rec["outcome"], "reject_t1")
            store.close()

    def test_t2_skew_quarantined(self):
        with tempfile.TemporaryDirectory() as d:
            c, store = self._consumer(d)
            env = _match(ts=int(NOW) - 901, recv=time.time())
            self.assertEqual(c.process(env), "quarantine_t2")
            store.close()

    def test_t3_restated_and_restatement_row(self):
        with tempfile.TemporaryDirectory() as d:
            c, store = self._consumer(d)
            m1, m2 = _minute_now(-2), _minute_now(-1)
            c.process(_match(ts=m1 + 10, acc=1600.0))
            c.process(_match(ts=m2 + 10, acc=1900.0))
            c.flush()
            late = _match(price=54.5, vol=50.0, acc=1950.0, ts=m1 + 40)
            self.assertEqual(c.process(late), "accept")
            b = c.buckets[("dnse", "UIC", m1 // 60 * 60)]
            self.assertEqual(b[7], 1)  # restated
            n = store.conn.execute("SELECT COUNT(*) FROM restatements").fetchone()[0]
            self.assertEqual(n, 1)
            store.close()

    def test_dedup_acc_and_regressed_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            c, store = self._consumer(d)
            m = _minute_now()
            self.assertEqual(c.process(_match(ts=m + 10, acc=1600.0)), "accept")
            self.assertEqual(c.process(_match(ts=m + 10, acc=1600.0)), "dup_dropped")
            # acc regressed: khong bi loai, chi dem; gui lai y het -> dup qua fallback.
            self.assertEqual(c.process(_match(price=54.0, vol=100.0, acc=500.0, ts=m + 20)), "accept")
            self.assertEqual(c.counters.acc_regressed, 1)
            self.assertEqual(c.process(_match(price=54.0, vol=100.0, acc=500.0, ts=m + 20)), "dup_dropped")
            self.assertEqual(c.counters.dup_dropped, 2)
            b = c.buckets[("dnse", "UIC", m // 60 * 60)]
            self.assertEqual(b[4], 700.0)  # 600 + 100, dup khong cong
            store.close()

    def test_preopen_and_acc_reset(self):
        with tempfile.TemporaryDirectory() as d:
            c, store = self._consumer(d)
            m = _minute_now()
            c.process(_match(ts=m + 10, acc=25000.0))
            c.process(_match(ts=m + 20, acc=10000.0))  # < 50% max -> reset
            self.assertEqual(c.counters.acc_resets, 1)
            c.flush()
            segs = store.load_preopen()
            self.assertEqual(len(segs), 2)
            self.assertEqual(segs[("dnse", "UIC", 0)][0], 25000.0)
            self.assertEqual(segs[("dnse", "UIC", 1)][0], 10000.0)
            n = store.conn.execute(
                "SELECT COUNT(*) FROM gaps WHERE error='acc_reset'").fetchone()[0]
            self.assertEqual(n, 1)
            store.close()

    def test_snapshot_latest_wins(self):
        with tempfile.TemporaryDirectory() as d:
            c, store = self._consumer(d)
            e1 = Envelope(gate="dnse", kind="snapshot", sym="UIC",
                          ts=int(NOW), recv_ts=int(NOW),
                          fields={"day_low": 55000.0}, field_src={"day_low": "dnse"})
            e2 = Envelope(gate="dnse", kind="snapshot", sym="UIC",
                          ts=int(NOW) + 1, recv_ts=int(NOW) + 1,
                          fields={"day_low": 55100.0}, field_src={"day_low": "dnse"})
            c.process(e1)
            c.process(e2)
            c.flush()
            snap = store.load_snapshots()[("dnse", "UIC")]
            self.assertEqual(snap[1]["day_low"], 55100.0)
            store.close()


def _wait_until(fn, timeout=25.0, step=0.2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if fn():
            return True
        time.sleep(step)
    return False


class TestGateLoopEndToEnd(unittest.TestCase):
    def test_full_loop_reconnect_and_dedup(self):
        tick_topic = dnse_wire.topics_for(["UIC"])[1]
        snap_topic = dnse_wire.topics_for(["UIC"])[0]
        tick1 = _tick_payload()
        snap = _stockinfo_payload()
        script = [("publish", tick_topic, tick1),
                  ("publish", snap_topic, snap),
                  ("drop",),
                  ("publish", tick_topic, tick1),  # gui lai sau reconnect -> dup
                  ("publish", tick_topic, _tick_payload(price=55.5, vol_lots=30, acc_lots=190))]
        broker = MockBroker(script).start()
        try:
            with tempfile.TemporaryDirectory() as d:
                store = SessionStore(os.path.join(d, "session.db"))
                consumer = Consumer(SESSION_DATE, store, d, flush_sec=3600)
                q = queue.Queue(maxsize=50000)
                gap_q = queue.Queue()
                consumer.gap_queue = gap_q
                stop = threading.Event()
                gate = DnseGate(["UIC"], q, gap_q, d,
                                ws_url=f"ws://127.0.0.1:{broker.port}",
                                username="u", password="p",
                                watchdog_armed=lambda: False,
                                stop_event=stop, rng=random.Random(7))
                ct = threading.Thread(target=consumer.run, args=(q, stop), daemon=True)
                ct.start()
                gate.start()
                try:
                    minute = _minute_now()
                    ok = _wait_until(
                        lambda: broker.connects >= 2 and ("dnse", "UIC", minute) in consumer.buckets,
                        timeout=25.0)
                    self.assertTrue(ok, f"broker connects={broker.connects} buckets={list(consumer.buckets)}")
                    self.assertGreaterEqual(broker.subscribes, 2)
                    self.assertIn(tick_topic, broker.topics)
                    self.assertTrue(_wait_until(lambda: consumer.counters.dup_dropped >= 1, timeout=10.0))
                    self.assertTrue(_wait_until(lambda: consumer.buckets[("dnse", "UIC", minute)][4] == 900.0, timeout=10.0))
                finally:
                    stop.set()
                    gate.join(timeout=20)
                    ct.join(timeout=20)
                consumer.flush()
                rows = store.load_buckets()
                self.assertEqual(rows[("dnse", "UIC", minute)][4], 900.0)
                snaps = store.load_snapshots()
                self.assertEqual(snaps[("dnse", "UIC")][1]["day_low"], 55000.0)
                wal_rows = read_wal(os.path.join(d, "raw_dnse.jsonl"))
                self.assertEqual(len(wal_rows), 4)  # WAL ghi ca ban gui lai
                self.assertTrue(os.path.exists(os.path.join(d, "checkpoint.json")))
                store.close()
        finally:
            broker.stop()

    def test_auth_failure_stops_without_retry(self):
        broker = MockBroker([], connack_code=5).start()
        try:
            with tempfile.TemporaryDirectory() as d:
                q = queue.Queue(maxsize=50000)
                gap_q = queue.Queue()
                stop = threading.Event()
                gate = DnseGate(["UIC"], q, gap_q, d,
                                ws_url=f"ws://127.0.0.1:{broker.port}",
                                username="u", password="p",
                                watchdog_armed=lambda: False,
                                stop_event=stop, rng=random.Random(7))
                gate.start()
                gate.join(timeout=10)
                self.assertFalse(gate.is_alive())
                self.assertEqual(broker.connects, 1)
                self.assertIn("auth", gate.stats.snapshot()["last_error"])
        finally:
            broker.stop()


if __name__ == "__main__":
    unittest.main()
