#!/usr/bin/env python3
"""Invariant test cho FIELD_MAP DNSE (GĐ0 30/10, Chot; ap lai 03/11).

Lich su: commit 0aaad4a4 (30/10) sua FIELD_MAP: f13=day_low (khong phai
last), f22=atc_volume (khong phai total_volume), f58/f59=matched-only
(khong phai buy/sell_value tong). Commit 6b9c1fd (31/10) vo tinh go
nguoc fix nay khi viet lai tick_collector.py — he qua: parity 02/11
crosscheck total_volume 0/40 vs DNSE (8 phien lien tiep khong sach).
Test nay khoa lai mapping dung: neu ai do doi ten truong ve dang cu
("total_volume" <- f22, "last" <- f13, "buy_value" <- f58,
"sell_value" <- f59) thi test FAIL ngay, khong doi toi parity phien sau.

Chay: python3 modal_crons/tests/test_field_map_dnse.py
Khong mang, khong secret, stdlib only. Module tick_collector import
voi stub `modal` (may test khong co goi modal), giong cac test hien co.
"""
import importlib.util
import sys
import unittest
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


class FieldMapDnseTests(unittest.TestCase):
    """FIELD_MAP["dnse"] phai dung ngu nghia GĐ0 (da doi chieu so that)."""

    def test_day_low_is_f13_not_last(self):
        self.assertEqual(tc.FIELD_MAP["dnse"]["day_low"],
                         ("stockinfo f13", 1, False))
        self.assertNotIn("last", tc.FIELD_MAP["dnse"])

    def test_atc_volume_is_f22_not_total_volume(self):
        self.assertEqual(tc.FIELD_MAP["dnse"]["atc_volume"],
                         ("stockinfo f22", 10, False))
        # f22 la bucket ATC, KHONG BAO GIO duoc map thanh total_volume.
        self.assertNotIn("total_volume", tc.FIELD_MAP["dnse"])

    def test_matched_only_f58_f59(self):
        self.assertEqual(tc.FIELD_MAP["dnse"]["buy_value_matched"],
                         ("stockinfo f58", 10 ** 9, False))
        self.assertEqual(tc.FIELD_MAP["dnse"]["sell_value_matched"],
                         ("stockinfo f59", 10 ** 9, False))
        # f58/f59 la matched-only, KHONG BAO GIO duoc map thanh tong.
        self.assertNotIn("buy_value", tc.FIELD_MAP["dnse"])
        self.assertNotIn("sell_value", tc.FIELD_MAP["dnse"])

    def test_total_value_still_f25(self):
        self.assertEqual(tc.FIELD_MAP["dnse"]["total_value"],
                         ("stockinfo f25", 10 ** 9, False))

    def test_qty_fields_cover_new_names(self):
        for f in ("atc_volume", "buy_value_matched", "sell_value_matched"):
            self.assertIn(f, tc.QTY_FIELDS)


class DnseAdapterEmissionTests(unittest.TestCase):
    """DnseAdapter phai phat dung ten truong moi (khong phat ten cu)."""

    def test_on_msg_emits_new_field_names(self):
        # Fake aggregator: chi ghi lai on_snapshot, khong chay logic.
        calls = []

        class FakeAgg:
            gate_stats = {}

            def on_snapshot(self, src, sym, snap):
                calls.append((src, sym, snap))

        # Stub MqttWs de __init__ khong mo ket noi that.
        with mock.patch.object(tc, "MqttWs", mock.MagicMock()):
            adapter = tc.DnseAdapter(FakeAgg(), ["VCB"])

        # Fake 1 ban stockinfo: f13=day-low, f22=ATC, f58/f59=matched.
        fake_msg = {"f41": {"f4": "VCB", "f13": 53.3, "f22": 12345,
                            "f25": 100, "f17": 1000, "f58": 5000,
                            "f18": 2000, "f59": 6000, "f20": 100,
                            "f60": 1000000}}
        with mock.patch.object(tc, "pb_decode", return_value=fake_msg):
            adapter._on_msg(
                "quotes/krx/mdds/stockinfo/v1/roundlot/symbol/VCB", b"x")

        self.assertEqual(len(calls), 1)
        src, sym, snap = calls[0]
        self.assertEqual(src, "dnse")
        self.assertEqual(sym, "VCB")
        # Ten moi co mat, dung gia tri (sau scale).
        self.assertEqual(snap.get("day_low"), 53.3)
        self.assertEqual(snap.get("atc_volume"), 123450)
        self.assertEqual(snap.get("buy_value_matched"), 5000 * 10 ** 9)
        self.assertEqual(snap.get("sell_value_matched"), 6000 * 10 ** 9)
        # Ten cu KHONG duoc phat.
        for old in ("last", "total_volume", "buy_value", "sell_value"):
            self.assertNotIn(old, snap)


if __name__ == "__main__":
    unittest.main()
