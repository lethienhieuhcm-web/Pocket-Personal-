#!/usr/bin/env python3
"""Test offline cho lane foreign_flow (rebase dong v24, su co 04/11):
collector co live=False van phai goi khoi ngoai hop nhat len lane
{"tick_live": {"foreign": ...}} de Worker gop vao
market/foreign_flow.json (frontend doc qua cachedMarket, cache 15
phut — endpoint money-flow). LUAT DUNG 02/11: tick_live NHEN khong
duoc boi — "live" van False, payload foreign khong duoc chua
intraday.

Chay: python3 modal_crons/tests/test_foreign_flow_publish.py
Khong mang, khong secret, stdlib only (stub `modal`)."""
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
    """Adapter gia: nap snapshot khoi ngoai (+ tick tuy chon) vao agg
    trong __init__ roi im lang — _collect tao task, nap o init moi
    chac chan kip luot publish."""

    inject_snapshot = True
    inject_tick = True
    clear_dirty = False

    def __init__(self, agg, universe):
        self.agg = agg
        self.universe = universe
        self.msgs = 5
        self.last_msg = time.time()
        self.last_error = None
        self.connected = True
        ts = epoch(2026, 11, 4, 9, 15)
        if self.inject_tick:
            agg.on_match("dnse", "AAA", ts, 10.0, 100, 1)
        if self.inject_snapshot:
            agg.on_snapshot("dnse", "AAA", {
                "buy_volume": 1_000_000, "sell_volume": 400_000,
                "buy_value": 2.0e10, "sell_value": 8.0e9,
                "total_volume": 9_000_000, "total_value": 1.8e11,
                "room": 3_000_000, "total_room": 12_000_000,
                "last": 10.5})
        if self.clear_dirty:
            agg.dirty.clear()
            agg.dirty_pt.clear()

    async def run(self):
        return

    def stop(self):
        pass


class ForeignFlowHarness(unittest.TestCase):
    def setUp(self):
        self.orig_config = dict(tc.CONFIG)
        self.orig = {}
        for name in ("publish", "now_ict", "ADAPTERS"):
            self.orig[name] = getattr(tc, name)
        self.calls = []

    def tearDown(self):
        tc.CONFIG.clear()
        tc.CONFIG.update(self.orig_config)
        for name, val in self.orig.items():
            setattr(tc, name, val)
        DummyAdapter.inject_snapshot = True
        DummyAdapter.inject_tick = True
        DummyAdapter.clear_dirty = False

    def _run(self, **overrides):
        cfg = {
            "sources": ["dnse"],
            "universe": ["AAA"],
            "resume": False,
            "live": False,          # luat 02/11 — khong bat lai
            "chart_candles": True,
            "foreign_flow": True,
            "publish_sec": 1,
        }
        cfg.update(overrides)
        tc.CONFIG.update(cfg)
        tc.ADAPTERS = {"dnse": DummyAdapter}
        tc.now_ict = lambda: datetime(2026, 11, 4, 15, 6, tzinfo=ICT)

        def publish(payload, source):
            self.calls.append(payload)
            return {"ok": True}

        tc.publish = publish
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            asyncio.run(tc._collect())
        return buf.getvalue()

    def _foreign_payloads(self):
        return [p["tick_live"] for p in self.calls
                if "tick_live" in p]

    def test_gate_keys_default(self):
        """CONFIG goc (pristine + patch): live van False, foreign_flow
        mo — nham khong tai hien su co 04/11 (file cu 15 phut)."""
        base = self.orig_config
        self.assertFalse(base.get("live"))
        self.assertTrue(base.get("foreign_flow"))

    def test_foreign_published_while_live_off(self):
        self._run()
        tl = self._foreign_payloads()
        self.assertTrue(tl, "khong co khoi ngoai len lane foreign_flow")
        flow = tl[0]["foreign"]
        self.assertIn("AAA", flow)
        self.assertEqual(flow["AAA"]["buy_volume"], 1_000_000)
        self.assertEqual(flow["AAA"]["sell_volume"], 400_000)
        self.assertEqual(flow["AAA"]["net_volume"], 600_000)

    def test_no_intraday_in_live_lane(self):
        """tick_live.foreign CHI khoi ngoai — nen van di lane
        chart_candles {"intraday": ...}, khong phai tick_live."""
        self._run()
        for p in self._foreign_payloads():
            self.assertNotIn("intraday", p)
        self.assertTrue(any("intraday" in p for p in self.calls),
                        "lane chart_candles phai chay song song")

    def test_flag_off_no_live_lane(self):
        self._run(foreign_flow=False)
        self.assertEqual(self._foreign_payloads(), [])
        self.assertTrue(any("intraday" in p for p in self.calls))

    def test_empty_flow_not_published(self):
        DummyAdapter.inject_snapshot = False
        self._run()
        self.assertEqual(self._foreign_payloads(), [])

    def test_foreign_survives_empty_candles(self):
        """Ma ngung khop lenh (dirty het) van cap nhat duoc khoi
        ngoai — day chinh la dieu frontend money-flow can."""
        DummyAdapter.clear_dirty = True
        self._run()
        tl = self._foreign_payloads()
        self.assertTrue(tl)
        self.assertIn("AAA", tl[0]["foreign"])

    def test_status_carries_index_fields(self):
        """build_status gan nhat: lane status co khoa "index" +
        "index_symbols" (B1 doi chieu phien ke tiep)."""
        self._run()
        shadow = [p["tick_shadow"] for p in self.calls if "tick_shadow" in p]
        self.assertTrue(shadow)
        st = shadow[0]["status"]
        self.assertIn("index", st)
        self.assertIn("index_symbols", st)


if __name__ == "__main__":
    unittest.main(verbosity=2)
