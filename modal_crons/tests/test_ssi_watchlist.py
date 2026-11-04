#!/usr/bin/env python3
"""Test offline cho SSI M/B watchlist scope (Chot Henrry 21:55 03/11,
rebase dong v24 len main 04/11): SSI adapter chi subscribe/toan ly
M/B cac ma trong flow_watchlist.json (R2, toi da 20 ma), fallback ve
universe khi R2 khong doc duoc. Duong nay nuoi endpoint
money-flow-live + money-flow-trades (raw col 8 = side).

Chay: python3 modal_crons/tests/test_ssi_watchlist.py
Khong mang, khong secret, stdlib only (stub `modal`, mock feed/R2)."""
import importlib.util
import json
import os
import struct
import sys
import tempfile
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


def _varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def _f(no, wt, raw):
    return _varint((no << 3) | wt) + _varint(len(raw)) + raw


def le_payload(items):
    """SSI topic l/ — pb theo SSI_LE: items nested (price u, vol u,
    accumulatedVol i, time s, side s)."""
    msg = b""
    for it in items:
        body = b""
        if it.get("price") is not None:
            body += _varint((1 << 3) | 0) + _varint(int(it["price"] * 1000))
        if it.get("vol") is not None:
            body += _varint((2 << 3) | 0) + _varint(int(it["vol"]))
        if it.get("acc") is not None:
            body += _varint((3 << 3) | 0) + _varint(int(it["acc"]))
        if it.get("side"):
            body += _f(6, 2, it["side"].encode())
        msg += _f(1, 2, body)
    return msg


WATCH20 = ["AAC", "AAS", "ABB", "BCM", "BWE", "C69", "CDC", "CLC",
           "CTF", "CTI", "DCL", "DPG", "FRT", "GDA", "GEX", "G36",
           "HAG", "HAI", "HDG", "HHP"]


def watch_doc(symbols=WATCH20, **extra):
    d = {"screen_date": "2026-11-03", "for_date": "2026-11-04",
         "candidates": [{"symbol": s, "cmf200": 1.0} for s in symbols]}
    d.update(extra)
    return d


class TestWatchlistLoader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tc = load_tc()

    def test_r2_default_key(self):
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(self.tc, "fetch_tick_state",
                                  return_value=watch_doc()) as fetch:
            os.environ.pop("SSI_WATCHLIST_R2_KEY", None)
            os.environ.pop("SSI_WATCHLIST_PATH", None)
            syms, desc = self.tc.ssi_watchlist_symbols(["VCB", "FPT"])
        fetch.assert_called_once_with("flow/watchlist/latest.json")
        self.assertEqual(syms, WATCH20)
        self.assertEqual(desc, "r2:flow/watchlist/latest.json")

    def test_custom_r2_key(self):
        with mock.patch.dict(os.environ,
                             {"SSI_WATCHLIST_R2_KEY": "flow/watchlist/x.json"}), \
                mock.patch.object(self.tc, "fetch_tick_state",
                                  return_value=watch_doc(["ONE", "TWO"])) as fetch:
            syms, desc = self.tc.ssi_watchlist_symbols(["VCB"])
        fetch.assert_called_once_with("flow/watchlist/x.json")
        self.assertEqual(syms, ["ONE", "TWO"])

    def test_local_file_path(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as f:
            json.dump(watch_doc(["LOC", "AUX"]), f)
            path = f.name
        try:
            with mock.patch.dict(os.environ,
                                 {"SSI_WATCHLIST_PATH": path}), \
                    mock.patch.object(self.tc, "fetch_tick_state",
                                      side_effect=AssertionError(
                                          "khong duoc goi R2 khi co PATH")):
                os.environ.pop("SSI_WATCHLIST_R2_KEY", None)
                syms, desc = self.tc.ssi_watchlist_symbols(["VCB"])
            self.assertEqual(syms, ["LOC", "AUX"])
            self.assertEqual(desc, f"file:{path}")
        finally:
            os.unlink(path)

    def test_dedup_upper_strip(self):
        d = {"candidates": [{"symbol": " vcb "}, {"symbol": "VCB"},
                            {"symbol": ""}, {"symbol": None},
                            "not-a-dict", {"symbol": "fpt"}]}
        with mock.patch.object(self.tc, "fetch_tick_state",
                               return_value=d):
            os.environ.pop("SSI_WATCHLIST_R2_KEY", None)
            os.environ.pop("SSI_WATCHLIST_PATH", None)
            syms, _ = self.tc.ssi_watchlist_symbols(["X"])
        self.assertEqual(syms, ["VCB", "FPT"])

    def test_fallback_on_bad_payload(self):
        for bad in ({"candidates": "khong phai list"}, {},
                   {"candidates": [{"symbol": ""}]},
                   {"candidates": [{"symbol": s} for s in range(5)]}):
            with mock.patch.object(self.tc, "fetch_tick_state",
                                   return_value=bad):
                os.environ.pop("SSI_WATCHLIST_R2_KEY", None)
                os.environ.pop("SSI_WATCHLIST_PATH", None)
                syms, desc = self.tc.ssi_watchlist_symbols(["A", "B", "C"])
            self.assertEqual(syms, ["A", "B", "C"], bad)
            self.assertEqual(desc, "fallback-universe")

    def test_fallback_on_r2_error(self):
        with mock.patch.object(self.tc, "fetch_tick_state",
                               side_effect=RuntimeError("R2 khong reachable")):
            os.environ.pop("SSI_WATCHLIST_R2_KEY", None)
            os.environ.pop("SSI_WATCHLIST_PATH", None)
            syms, desc = self.tc.ssi_watchlist_symbols(["A", "B"])
        self.assertEqual(syms, ["A", "B"])
        self.assertEqual(desc, "fallback-universe")


class TestSsiAdapterScope(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tc = load_tc()

    def _adapter(self, agg=None, watch=None, universe=None):
        agg = agg or mock.MagicMock()
        universe = universe or ["VCB", "FPT", "HPG"]
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(self.tc, "MqttWs") as mw, \
                mock.patch.object(self.tc, "ssi_config",
                                  return_value=("wss://x", "u", "p")), \
                mock.patch.object(self.tc, "fetch_tick_state",
                                  return_value=watch or watch_doc()):
            os.environ.pop("SSI_WATCHLIST_R2_KEY", None)
            os.environ.pop("SSI_WATCHLIST_PATH", None)
            ad = self.tc.SsiAdapter(agg, universe)
        return ad, mw.call_args[0][3], agg

    def test_topics_limited_to_watchlist(self):
        ad, topics, _agg = self._adapter()
        sym_topics = {t for t in topics if t.startswith(("s/", "l/"))}
        self.assertEqual(len(sym_topics), 2 * len(WATCH20))
        for t in sym_topics:
            self.assertIn(t.split("/")[1], WATCH20)
        # ma ngoai watchlist KHONG duoc sub
        self.assertNotIn("s/VCB/MAIN", topics)
        # topic chung giu nguyen
        for t in ("pe", "i/VNINDEX", "i/VN30"):
            self.assertIn(t, topics)
        self.assertEqual(ad.watchlist_src, "r2:flow/watchlist/latest.json")

    def test_fallback_subscribes_universe(self):
        with mock.patch.object(self.tc, "fetch_tick_state",
                               side_effect=RuntimeError("R2 chan")):
            agg = mock.MagicMock()
            with mock.patch.dict(os.environ, {}), \
                    mock.patch.object(self.tc, "MqttWs") as mw, \
                    mock.patch.object(self.tc, "ssi_config",
                                      return_value=("wss://x", "u", "p")):
                os.environ.pop("SSI_WATCHLIST_R2_KEY", None)
                os.environ.pop("SSI_WATCHLIST_PATH", None)
                ad = self.tc.SsiAdapter(agg, ["VCB", "FPT"])
            topics = mw.call_args[0][3]
        self.assertIn("s/VCB/MAIN", topics)
        self.assertEqual(ad.symbols, {"VCB", "FPT"})

    def test_out_of_watchlist_tick_skipped(self):
        ad, _topics, agg = self._adapter()
        ad._on_msg("l/VCB/MAIN", le_payload(
            [{"price": 50.0, "vol": 100, "side": "BUY"}]))
        agg.on_match.assert_not_called()
        self.assertEqual(ad.mb_skipped, 1)

    def test_in_watchlist_tick_processed_with_side(self):
        ad, _topics, agg = self._adapter()
        ad._on_msg("l/MSN/MAIN", b"")  # MSN khong thuoc WATCH20? co — kiem
        # MSN KHONG nam trong 20 ma Watch20 tren -> phai bi bo:
        agg.on_match.assert_not_called()
        ad2, _t2, agg2 = self._adapter(watch=watch_doc(["MSN"]))
        ad2._on_msg("l/MSN/MAIN", le_payload(
            [{"price": 40.5, "vol": 2000, "acc": 50000, "side": "SELL"}]))
        agg2.on_match.assert_called_once()
        args = agg2.on_match.call_args[0]
        self.assertEqual(args[0], "ssi-mqtt")
        self.assertEqual(args[1], "MSN")
        self.assertAlmostEqual(args[3], 40.5, places=6)
        self.assertEqual(args[4], 2000)
        self.assertEqual(args[5], 50000)
        self.assertEqual(args[6], "SELL")  # side = arg thu 8 (cot 8 raw)


class TestRawSide(unittest.TestCase):
    """on_match phai ghi duoc side vao cot 8 cua raw, 7 cot dau
    giu nguyen vi tri (worker money-flow-live doc ln[7])."""

    @classmethod
    def setUpClass(cls):
        cls.tc = load_tc()

    def test_side_appended(self):
        agg = self.tc.Aggregator()
        agg.on_match("ssi-mqtt", "MSN", 1_762_150_200, 40.5, 2000, 5, "BUY")
        rec = agg.raw_buf[-1]
        self.assertEqual(len(rec), 8)
        self.assertEqual(rec[:7],
                         ["ssi-mqtt", "MSN", 1_762_150_200, rec[3],
                          40.5, 2000, 5])
        self.assertEqual(rec[7], "BUY")

    def test_side_default_none(self):
        agg = self.tc.Aggregator()
        agg.on_match("dnse", "VCB", 1_762_150_200, 53.5, 1000, 1)
        self.assertIsNone(agg.raw_buf[-1][7])
        self.assertEqual(len(agg.raw_buf[-1]), 8)


if __name__ == "__main__":
    unittest.main(verbosity=2)
