#!/usr/bin/env python3
"""Test offline cho guard universe tape (04/11/2026 — su co dong bang
/api/stock/trades).

Chay: python3 modal_crons/tests/test_tape_universe.py
Khong mang, khong secret, stdlib only (stub `modal` nhu ca test khac).

Nham giu bat dung cai da gay ra phien 04/11: `CONFIG["universe"]` bi
doi thanh tap B200 doc (nganh truong cua 2d5b63f) nen DnseAdapter
khong con subscribe tick cua VCB/FPT/HPG -> build_tape() tra {} ->
lenh POST {"tape": ...} bi bo qua (`if tape:`) -> R2 giu nguyen file
phien 03/11, Worker (khong guard theo ngay) van tra 200 du lieu cu.
"""
import importlib.util
import sys
import unittest
from unittest import mock

TC_PATH = __file__.rsplit("/tests/", 1)[0] + "/tick_collector.py"
WATCHDOG_CANARIES = ["VCB", "FPT", "HPG"]  # tape_stall_watchdog.py mac dinh


def load_tc():
    stub = mock.MagicMock(name="modal")
    sys.modules.setdefault("modal", stub)
    spec = importlib.util.spec_from_file_location("tick_collector", TC_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestTapeUniverse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tc = load_tc()
        cls.universe = cls.tc.CONFIG["universe"]

    def test_dna_canaries_are_collected(self):
        """Ma chien canh cua watchdog phai nam trong universe."""
        for sym in WATCHDOG_CANARIES:
            self.assertIn(sym, self.universe,
                          f"{sym} ngoai universe -> tape {sym} se dong")

    def test_bluechip_and_b200_both_survive(self):
        """Union, khong phai chon mot: 40 ma xan + 42 ma B200."""
        self.assertEqual(40, len(self.tc.UNIVERSE_BLUECHIP))
        self.assertEqual(42, len(self.tc.UNIVERSE_B200))
        for sym in self.tc.UNIVERSE_BLUECHIP | self.tc.UNIVERSE_B200:
            self.assertIn(sym, self.universe)
        self.assertEqual(78, len(self.universe))

    def test_dna_each_code_appears_once(self):
        self.assertEqual(sorted(set(self.universe)), list(self.universe))

    def test_dna_dnse_tick_topics_cover_every_code(self):
        """DnseAdapter the topic tick theo tung ma cua universe; universe
        thieu ma nao thi ma do KHONG the co tick -> tape thieu ma do."""
        topics = []
        for s in self.universe:
            topics += [f"quotes/krx/mdds/tick/v1/roundlot/symbol/{s}"]
        for sym in WATCHDOG_CANARIES:
            self.assertIn(
                f"quotes/krx/mdds/tick/v1/roundlot/symbol/{sym}", topics)

    def test_dna_guard_fails_loud(self):
        """Thu cut VCB -> guard phai noi (RuntimeError), khong im lang."""
        broken = [s for s in self.universe if s != "VCB"]
        self.assertNotIn("VCB", broken)
        with self.assertRaises(RuntimeError) as ctx:
            self.tc.assert_tape_universe(broken)
        self.assertIn("VCB", str(ctx.exception))

    def test_dna_build_tape_emits_for_canary_tick(self):
        """Chuoi ngan: tick DNSE -> tape_rec -> build_tape co record;
        tick cua ma NGOAI universe cung co record (nên buoc chan
        dung o universe/subscribe, khong phai o build_tape)."""
        agg = self.tc.Aggregator()
        agg.on_match("dnse", "VCB", 1_762_000_000, 53.5, 1000, 1)
        agg.on_match("dnse", "ABB", 1_762_000_001, 21.0, 500, 2)
        agg.on_match("kbs", "BID", 1_762_000_002, 40.0, 300, None)
        tape = agg.build_tape()
        self.assertIn("VCB", tape)
        self.assertIn("ABB", tape)
        self.assertNotIn("BID", tape)   # tape chan rieng DNSE
        self.assertTrue(tape["VCB"]["date"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
