#!/usr/bin/env python3
"""Test offline cho sua publish intraday (29/10/2026, CHUA deploy).

Chay: python3 modal_crons/tests/test_intraday_publish_fix.py
Khong mang, khong secret, stdlib only. Module tick_collector import
voi stub `modal` (may test khong co goi modal).
"""
import asyncio
import contextlib
import importlib.util
import io
import sys
import time
import unittest
from datetime import datetime
from unittest import mock

TC_PATH = __file__.rsplit("/tests/", 1)[0] + "/tick_collector.py"


def load_tc():
    stub = mock.MagicMock(name="modal")
    sys.modules.setdefault("modal", stub)
    spec = importlib.util.spec_from_file_location("tick_collector", TC_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tc = load_tc()
ICT = tc.ICT


def epoch(y, mo, d, h, mi):
    return int(datetime(y, mo, d, h, mi, tzinfo=ICT).timestamp())


class DummyAdapter:
    """Adapter gia: nap tick vao agg roi tra ve ngay."""

    inject = []  # (sym, ts, price, vol)
    clear_dirty = False

    def __init__(self, agg, universe):
        self.agg = agg
        self.universe = universe
        self.msgs = 5
        self.last_msg = time.time()
        self.last_error = None
        self.connected = True
        # Nap tick ngay trong __init__: _collect tao task adapter roi
        # co the cancel truoc khi task chay (dang dong phien 15:05+),
        # nen nap o run() se khong kip. Day la dieu kien tien quyet
        # cua luot dong (bucket da gop truoc khi dong), khong phai
        # hanh vi adapter that.
        for sym, ts, price, vol in self.inject:
            self.agg.on_match("dnse", sym, ts, price, vol, None)
        if self.clear_dirty:
            self.agg.dirty.clear()
            self.agg.dirty_pt.clear()

    async def run(self):
        return

    def stop(self):
        pass


class FilterTests(unittest.TestCase):
    def test_merged_buckets_drops_prior_day_rows(self):
        agg = tc.Aggregator(session_date="2026-10-29")
        old = epoch(2026, 10, 28, 14, 45)
        a = epoch(2026, 10, 29, 9, 15)
        b = epoch(2026, 10, 29, 14, 45)
        agg.on_match("dnse", "AAA", old, 10.0, 100, 1)
        agg.on_match("dnse", "AAA", a, 11.0, 200, 2)
        agg.on_match("dnse", "AAA", b, 12.0, 300, 3)
        merged = agg._merged_buckets("AAA")
        self.assertEqual(sorted(merged), [a, b])
        out = agg.build_intraday(["AAA"])
        rows = out["AAA_1m"]
        self.assertTrue(all(r["t"].startswith("2026-10-29") for r in rows))
        self.assertEqual(rows[0]["t"], "2026-10-29T09:15")
        self.assertEqual(rows[-1]["t"], "2026-10-29T14:45")
        self.assertEqual(rows[-1]["v"], 300)

    def test_no_session_date_keeps_all_rows(self):
        agg = tc.Aggregator()
        old = epoch(2026, 10, 28, 14, 45)
        agg.on_match("dnse", "AAA", old, 10.0, 100, 1)
        self.assertIn(old, agg._merged_buckets("AAA"))

    def test_minute_failover_preserved_under_filter(self):
        agg = tc.Aggregator(session_date="2026-10-29")
        m = epoch(2026, 10, 29, 9, 16)
        old = epoch(2026, 10, 28, 14, 45)
        agg.on_match("kbs", "AAA", m, 20.0, 50, 1)
        agg.on_match("dnse", "AAA", old, 10.0, 100, 2)
        merged = agg._merged_buckets("AAA")
        self.assertEqual(sorted(merged), [m])
        self.assertEqual(merged[m][3], 20.0)


class CollectHarness(unittest.TestCase):
    def setUp(self):
        self.orig_config = dict(tc.CONFIG)
        self.orig = {}
        for name in ("publish", "publish_checked", "now_ict", "ADAPTERS"):
            self.orig[name] = getattr(tc, name)
        self.calls = []  # (kind, payload, source)

    def tearDown(self):
        tc.CONFIG.clear()
        tc.CONFIG.update(self.orig_config)
        for name, val in self.orig.items():
            setattr(tc, name, val)
        DummyAdapter.inject = []
        DummyAdapter.clear_dirty = False

    def _run_collect(self, now_dt, fail_rule=None, max_minutes=0):
        tc.CONFIG.update({
            "sources": ["dnse"],
            "universe": ["AAA", "BBB", "CCC", "DDD", "EEE"],
            "resume": False,
            "live": True,
            "publish_sec": 1,
        })
        tc.ADAPTERS = {"dnse": DummyAdapter}
        tc.now_ict = lambda: now_dt

        def publish(payload, source):
            self.calls.append(("publish", payload, source))
            return {"ok": True}

        def publish_checked(payload, source):
            self.calls.append(("checked", payload, source))
            if fail_rule is not None and fail_rule(payload):
                raise RuntimeError("boom chunk")
            return {"ok": True}

        tc.publish = publish
        tc.publish_checked = publish_checked
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            asyncio.run(tc._collect(max_minutes=max_minutes))
        return buf.getvalue()

    def _intraday_keys(self):
        keys = set()
        for kind, payload, _ in self.calls:
            if kind != "checked":
                continue
            for branch in ("tick_shadow", "tick_live"):
                intra = (payload.get(branch) or {}).get("intraday") or {}
                keys.update(intra)
        return keys

    def test_close_writes_universe_not_dirty_and_scopes_out_stale(self):
        DummyAdapter.inject = [
            ("AAA", epoch(2026, 10, 29, 9, 15), 10.0, 100),
            ("BBB", epoch(2026, 10, 29, 9, 15), 20.0, 100),
            ("CCC", epoch(2026, 10, 29, 9, 15), 30.0, 100),
            ("DDD", epoch(2026, 10, 29, 9, 15), 40.0, 100),
            ("EEE", epoch(2026, 10, 29, 9, 15), 50.0, 100),
            ("ZZZ", epoch(2026, 10, 29, 9, 15), 60.0, 100),
            ("AAA", epoch(2026, 10, 28, 14, 45), 9.0, 999),
        ]
        DummyAdapter.clear_dirty = True
        out = self._run_collect(datetime(2026, 10, 29, 15, 6, tzinfo=ICT))
        keys = self._intraday_keys()
        for sym in ("AAA", "BBB", "CCC", "DDD", "EEE"):
            self.assertIn(f"{sym}_1m", keys, out[-500:])
        self.assertFalse(any(k.startswith("ZZZ") for k in keys))
        # Khong dong 28/10 nao trong rows da gui.
        for kind, payload, _ in self.calls:
            for branch in ("tick_shadow", "tick_live"):
                intra = (payload.get(branch) or {}).get("intraday") or {}
                for rows in intra.values():
                    self.assertTrue(
                        all(r["t"].startswith("2026-10-29") for r in rows))

    def test_close_chunk_failure_continues(self):
        DummyAdapter.inject = [
            (s, epoch(2026, 10, 29, 9, 15), 10.0, 100)
            for s in ("AAA", "BBB", "CCC", "DDD", "EEE")
        ]

        def fail_rule(payload):
            for branch in ("tick_shadow", "tick_live"):
                intra = (payload.get(branch) or {}).get("intraday") or {}
                if "CCC_1m" in intra:
                    return True
            return False

        out = self._run_collect(
            datetime(2026, 10, 29, 15, 6, tzinfo=ICT), fail_rule=fail_rule)
        keys = self._intraday_keys()
        # Chunk sau chunk loi van duoc gui (DDD/EEE nam o chunk 1).
        self.assertIn("DDD_1m", keys)
        self.assertIn("EEE_1m", keys)
        self.assertIn("ALERT chunk publish loi", out)
        # Khong co exception thoat ra _collect (neu co, _run_collect
        # da raise). Luot dong van ket thuc binh thuong.

    def test_periodic_failure_still_raises_and_retries(self):
        DummyAdapter.inject = [
            ("AAA", epoch(2026, 10, 29, 10, 0), 10.0, 100),
        ]

        def fail_rule(payload):
            # Chi luot dinh ky (closed=False) moi loi; luot dong
            # (closed=True) cho qua de tien trinh ket thuc sach.
            status = (payload.get("tick_shadow") or {}).get("status") or {}
            return status.get("closed") is False

        out = self._run_collect(
            datetime(2026, 10, 29, 10, 0, tzinfo=ICT),
            fail_rule=fail_rule, max_minutes=0.1)
        # Luot dinh ky raise -> vong lap bat + in "publish loi",
        # dirty giu lai (chi 1 call truoc khi luot dong chay).
        self.assertIn("publish loi", out)
        closed_flags = []
        for kind, payload, _ in self.calls:
            status = (payload.get("tick_shadow") or {}).get("status")
            if status is not None:
                closed_flags.append(status.get("closed"))
        self.assertEqual(closed_flags[0], False)
        self.assertIn(True, closed_flags)


if __name__ == "__main__":
    unittest.main(verbosity=2)
