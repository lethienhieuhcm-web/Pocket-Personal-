#!/usr/bin/env python3
"""Test offline cho PA-4b B1 — nen chi so trong envelope DNSE
(tag 42 MarketIndex) + chan do index cac cong khac (rebase dong
v24 len main, 04/11).

Chay: python3 modal_crons/tests/test_b1_index.py
Khong mang, khong secret, stdlib only (stub `modal`)."""
import importlib.util
import struct
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


# ---------------- bo goi protobuf nho (test du lieu nap cho pb_decode) ----

def _varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def _tag(no, wt):
    return _varint((no << 3) | wt)


def f_varint(no, v):
    return _tag(no, 0) + _varint(v)


def f_double(no, x):
    return _tag(no, 1) + struct.pack("<d", x)


def f_bytes(no, raw):
    return _tag(no, 2) + _varint(len(raw)) + raw


def f_str(no, s):
    return f_bytes(no, s.encode())


def index_payload(value=1699.62, cum_volume=1234567, cum_value=None,
                  day_high=None, day_low=None, prior=None,
                  name="VNINDEX", seconds=None, nanos=0, nanos_field=2):
    """Envelope DNSE: tag 42 = mdds.v1.MarketIndex."""
    inner = f_double(7, value) + f_varint(8, cum_volume)
    if cum_value is not None:
        inner += f_double(9, cum_value)
    if day_high is not None:
        inner += f_double(22, day_high)
    if day_low is not None:
        inner += f_double(23, day_low)
    if prior is not None:
        inner += f_double(26, prior)
    if name is not None:
        inner += f_str(27, name)
    if seconds is not None:
        ts = f_varint(1, seconds)
        if nanos:
            # DIEM NGHI NGOI (giu nguyen ban v26): comment trong
            # DNSE_index ghi google.protobuf.Timestamp nanos=field 3,
            # nhung spec DNSE_INDEX lai doc field 2 -> payload that
            # (field 3) se mat phan nano, ts le giay. Khong anh huong
            # bucket phut; can phien live ket luan.
            ts += _varint((nanos_field << 3) | 0) + _varint(nanos)
        inner = f_bytes(6, ts) + inner
    return f_bytes(42, inner)


class TestConfig(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tc = load_tc()

    def test_index_keys_present(self):
        self.assertTrue(self.tc.CONFIG.get("index_probe"))
        for want in ("VNINDEX", "VN30", "HNX", "HNX30", "UPCOM",
                     "VNXALLSHARE", "VN100"):
            self.assertIn(want, self.tc.CONFIG["index_universe"])
        # 7 ten, thu tu 5 ten cu giu nguyen (HNX30 chen sau HNX,
        # VN100 cuoi):
        self.assertEqual(
            ["VNINDEX", "VN30", "HNX", "HNX30", "UPCOM",
             "VNXALLSHARE", "VN100"],
            self.tc.CONFIG["index_universe"])
        # 6 chi so NGANH DNSE khong co — tuyet doi khong them:
        for nganh in ("VNFIN", "VNREAL", "VNIT", "VNIND",
                      "VNMAT", "VNCONS"):
            self.assertNotIn(nganh, self.tc.CONFIG["index_universe"])

    def test_live_stays_off(self):
        """Luat 02/11: rebase B1 KHÔNG được kéo theo tick_live."""
        self.assertFalse(self.tc.CONFIG["live"])


class TestDecode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tc = load_tc()

    def test_topic_shape(self):
        self.assertEqual(
            "quotes/krx/mdds/index/VN30",
            self.tc.dnse_index_topic("VN30"))

    def test_fields_roundtrip(self):
        p = index_payload(value=1699.62, cum_volume=5_000_000,
                          cum_value=9e12, day_high=1701.5, day_low=1690.2,
                          prior=1695.0, name="VNINDEX",
                          seconds=1_762_150_000, nanos=250_000_000)
        f = self.tc.dnse_index_fields(p)
        self.assertAlmostEqual(f["value"], 1699.62, places=6)
        self.assertEqual(f["cum_volume"], 5_000_000)
        self.assertAlmostEqual(f["day_high"], 1701.5, places=6)
        self.assertAlmostEqual(f["day_low"], 1690.2, places=6)
        self.assertAlmostEqual(f["prior"], 1695.0, places=6)
        self.assertEqual(f["index_name"], "VNINDEX")
        self.assertAlmostEqual(f["ts"], 1_762_150_000.25, places=3)

    def test_scale_is_points(self):
        """Diem, khong nhan/chia 1000 (ket luan tu bundle hang)."""
        self.assertEqual(1.0, self.tc.INDEX_PRICE_SCALE)
        f = self.tc.dnse_index_fields(index_payload(value=1699.62))
        self.assertAlmostEqual(f["value"], 1699.62, places=6)

    def test_nanos_field_number_open_question(self):
        """nanos=field 2 theo spec code (khac google.Timestamp=3):
        payload dung field 3 bi le phan giay — bucket phut van dung,
        chi mat do chinh xac ts. Ghi nghi van trong REPORT."""
        p3 = index_payload(seconds=1_762_150_000, nanos=250_000_000,
                           nanos_field=3)
        self.assertAlmostEqual(
            self.tc.dnse_index_fields(p3)["ts"], 1_762_150_000.0)
        p2 = index_payload(seconds=1_762_150_000, nanos=250_000_000)
        self.assertAlmostEqual(
            self.tc.dnse_index_fields(p2)["ts"], 1_762_150_000.25, places=3)

    def test_fail_open(self):
        # khong co tag 42
        self.assertIsNone(self.tc.dnse_index_fields(f_bytes(45, b"\x01\x02")))
        # value <= 0
        self.assertIsNone(self.tc.dnse_index_fields(index_payload(value=0)))
        self.assertIsNone(self.tc.dnse_index_fields(index_payload(value=-5)))
        # payload khong phai bytes
        self.assertIsNone(self.tc.dnse_index_fields("khong phai bytes"))
        # bytes rac
        self.assertIsNone(self.tc.dnse_index_fields(b"\xff\xff\xff\xff"))


class TestAggregator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tc = load_tc()

    def test_bucket_ohlc_from_index_values(self):
        agg = self.tc.Aggregator()
        m = 1_762_150_200  // 60 * 60
        agg.on_index("dnse", "VNINDEX", m + 5, 100.0, cum_volume=1000)
        agg.on_index("dnse", "VNINDEX", m + 30, 105.0, cum_volume=1500)
        agg.on_index("dnse", "VNINDEX", m + 10, 95.0, cum_volume=1700)
        b = agg.candles["dnse"]["VNINDEX"][m]
        self.assertEqual(b[0], 100.0)              # o = gia tri dau tien
        self.assertEqual(b[1], 105.0)              # h = max
        self.assertEqual(b[2], 95.0)               # l = min
        self.assertEqual(b[3], 105.0)              # c = theo ts su kien lon nhat
        self.assertEqual(b[4], 1700 - 1000)        # v = lech cum ca phut
        self.assertIn("VNINDEX", agg.dirty)

    def test_cum_volume_regress_not_negative(self):
        agg = self.tc.Aggregator()
        m = 1_762_150_200
        agg.on_index("dnse", "VN30", m, 2400.0, cum_volume=900)
        agg.on_index("dnse", "VN30", m + 1, 2401.0, cum_volume=100)
        st = agg.index_stats["dnse"]["VN30"]
        self.assertEqual(st["vol_neg"], 1)
        self.assertEqual(agg.candles["dnse"]["VN30"][m][4], 0)

    def test_missing_value_counts_dropped(self):
        agg = self.tc.Aggregator()
        agg.on_index("dnse", "HNX", 1_762_150_200, None)
        st = agg.index_stats["dnse"]["HNX"]
        self.assertEqual(st["dropped"], 1)
        self.assertNotIn("HNX", agg.candles.get("dnse", {}))

    def test_day_high_regress_flagged(self):
        agg = self.tc.Aggregator()
        m = 1_762_150_200
        agg.on_index("dnse", "VNINDEX", m, 100.0, day_high=110.0)
        agg.on_index("dnse", "VNINDEX", m + 1, 101.0, day_high=105.0)
        st = agg.index_stats["dnse"]["VNINDEX"]
        self.assertEqual(st["hl_mismatch"], 1)
        self.assertEqual(agg.index_day["dnse"]["VNINDEX"]["day_high"], 105.0)

    def test_probe_records_structure(self):
        agg = self.tc.Aggregator()
        agg.on_index_probe("kbs", "INDEX",
                           {"O": 100, "H": 105, "V": 12, "note": None})
        p = agg.index_probe["kbs"]["INDEX"]
        self.assertEqual(p["count"], 1)
        self.assertEqual(p["fields"]["O"]["types"]["num"], 1)
        self.assertEqual(p["fields"]["note"]["types"]["null"], 1)
        self.assertEqual(p["sample"]["O"], 100)

    def test_probe_nested_keys(self):
        agg = self.tc.Aggregator()
        agg.on_index_probe("ssi-mqtt", "i/VNINDEX",
                           {"f7": [{"f1": 123}], "f1": 5})
        p = agg.index_probe["ssi-mqtt"]["i/VNINDEX"]
        self.assertIn("f7[0].f1", p["fields"])

    def test_probe_gate_off(self):
        agg = self.tc.Aggregator()
        with mock.patch.dict(self.tc.CONFIG, {"index_probe": False}):
            agg.on_index_probe("kbs", "INDEX", {"O": 1})
        self.assertEqual(agg.index_probe, {})

    def test_index_status_and_symbols(self):
        agg = self.tc.Aggregator()
        m = 1_762_150_200
        agg.on_index("dnse", "VNINDEX", m, 100.0, cum_volume=1000,
                     day_high=101.0)
        agg.on_index_probe("kbs", "INDEX", {"O": 1})
        st = agg.build_index_status()
        self.assertEqual(st["stats"]["dnse"]["VNINDEX"]["buckets"], 1)
        self.assertEqual(st["day"]["dnse"]["VNINDEX"]["day_high"], 101.0)
        self.assertNotIn("cum_volume", st["day"]["dnse"]["VNINDEX"])
        self.assertEqual(st["probe"]["kbs"]["INDEX"]["count"], 1)
        self.assertEqual(agg.index_symbols(), ["VNINDEX"])


class TestAdapterWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tc = load_tc()

    def _dnse(self):
        agg = mock.MagicMock()
        with mock.patch.object(self.tc, "MqttWs") as mw:
            ad = self.tc.DnseAdapter(agg, ["VCB"])
        return ad, mw, agg

    def test_index_topics_appended(self):
        _ad, mw, _agg = self._dnse()
        topics = mw.call_args[0][3]
        for name in self.tc.CONFIG["index_universe"]:
            self.assertIn(f"quotes/krx/mdds/index/{name}", topics)
        # khong sinh gate moi: van 1 ket noi, topic ma ping giu nguyen
        self.assertIn("quotes/krx/mdds/tick/v1/roundlot/symbol/VCB", topics)

    def test_on_msg_index_routes_to_on_index(self):
        ad, _mw, agg = self._dnse()
        p = index_payload(value=1699.62, cum_volume=100,
                          name="VNINDEX", seconds=1_762_150_000)
        ad._on_msg("quotes/krx/mdds/index/VNINDEX", p)
        agg.on_index.assert_called_once()
        args = agg.on_index.call_args[0]
        self.assertEqual(args[0], "dnse")
        self.assertEqual(args[1], "VNINDEX")
        self.assertAlmostEqual(args[3], 1699.62, places=6)
        agg.on_snapshot.assert_not_called()

    def test_on_msg_undecoded_goes_to_probe(self):
        ad, _mw, agg = self._dnse()
        ad._on_msg("quotes/krx/mdds/index/VN30", f_bytes(45, b"\x01"))
        agg.on_index.assert_not_called()
        kwargs = agg.on_index_probe.call_args[0]
        self.assertEqual(kwargs[1], "dnse_index_undecoded")


class TestSsiIndexProbe(unittest.TestCase):
    """Chi nhanh `i/` cua SSI — phan B1 trong SsiAdapter."""

    @classmethod
    def setUpClass(cls):
        cls.tc = load_tc()

    def _ssi(self, syms=("MSN",)):
        agg = mock.MagicMock()
        watch = {"candidates": [{"symbol": s} for s in syms]}
        with mock.patch.object(self.tc, "MqttWs"), \
                mock.patch.object(self.tc, "ssi_config",
                                  return_value=("wss://x", "u", "p")), \
                mock.patch.object(self.tc, "fetch_tick_state",
                                  return_value=watch):
            ad = self.tc.SsiAdapter(agg, ["VCB"])
        return ad, agg

    def test_i_topic_probed_not_dropped(self):
        ad, agg = self._ssi()
        ad._on_msg("i/VNINDEX", b"")
        agg.on_index_probe.assert_called_once_with(
            "ssi-mqtt", "i/VNINDEX", {})

    def test_i_topic_decode_error_swallowed(self):
        ad, agg = self._ssi()
        with mock.patch.object(self.tc, "pb_decode",
                               side_effect=RuntimeError("rac")):
            ad._on_msg("i/VN30", b"\x00")  # khong duoc noi ra ngoai


if __name__ == "__main__":
    unittest.main(verbosity=2)
