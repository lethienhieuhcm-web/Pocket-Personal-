import struct
import unittest

from collector import dnse_wire, mqtt, protobuf
from collector.fieldmap import load_map

MAP = load_map()


class TestProtobuf(unittest.TestCase):
    def test_varint_roundtrip(self):
        for v in (0, 1, 127, 128, 300, 16384, 2 ** 63 - 1):
            raw = protobuf.encode_varint(v)
            got, pos = protobuf.read_varint(raw, 0)
            self.assertEqual((got, pos), (v, len(raw)))

    def test_nested_roundtrip(self):
        inner = (protobuf.encode_double_field(13, 55.0)
                 + protobuf.encode_varint_field(22, 100)
                 + protobuf.encode_varint_field(25, 88))
        outer = protobuf.encode_nested_field(41, inner)
        decoded = protobuf.decode(outer, {})
        self.assertEqual(decoded["f41"]["f13"], 55.0)
        self.assertEqual(decoded["f41"]["f22"], 100)
        self.assertEqual(decoded["f41"]["f25"], 88)

    def test_zigzag_and_string(self):
        raw = (protobuf.encode_zigzag_field(1, -5)
               + protobuf.encode_string_field(2, "ACB"))
        decoded = protobuf.decode(raw, {1: ("neg", "z"), 2: ("sym", "s")})
        self.assertEqual(decoded, {"neg": -5, "sym": "ACB"})

    def test_float32_and_unknown_field(self):
        raw = protobuf.encode_float_field(3, 1.5) + protobuf.encode_varint_field(99, 7)
        decoded = protobuf.decode(raw, {})
        self.assertAlmostEqual(decoded["f3"], 1.5, places=5)
        self.assertEqual(decoded["f99"], 7)

    def test_truncated_raises(self):
        with self.assertRaises(ValueError):
            protobuf.decode(b"\x08\x80", {})


class TestMqtt(unittest.TestCase):
    def test_remaining_length_roundtrip(self):
        for n in (0, 127, 128, 16383, 2097151, 268435455):
            raw = mqtt.encode_remaining_length(n)
            got, pos = mqtt.decode_remaining_length(raw, 0)
            self.assertEqual((got, pos), (n, len(raw)))

    def test_connect_packet_shape(self):
        pkt = mqtt.build_connect("tick-abc123", "user", "pw", keepalive=60)
        self.assertEqual(pkt[0], 0x10)
        self.assertIn(b"\x00\x04MQTT\x04", pkt)
        self.assertIn(b"tick-abc123", pkt)
        ptype, _, payload, used = mqtt.parse_packet(pkt)
        self.assertEqual(ptype, 1)
        self.assertEqual(used, len(pkt))
        self.assertEqual(payload[6], 4)  # protocol level 4 (MQTT 3.1.1)
        self.assertEqual(payload[7] & 0xC0, 0xC0)  # username + password flags

    def test_subscribe_and_publish_roundtrip(self):
        topics = dnse_wire.topics_for(["ACB", "VCB"])
        self.assertEqual(len(topics), 4)
        self.assertTrue(topics[0].endswith("/ACB") and "stockinfo" in topics[0])
        pkt = mqtt.build_subscribe(7, topics)
        self.assertEqual(pkt[0], 0x82)
        ptype, _, payload, _ = mqtt.parse_packet(pkt)
        self.assertEqual(ptype, 8)
        self.assertIn(b"quotes/krx/mdds/tick/v1/roundlot/symbol/VCB", payload)

        pub = mqtt.build_publish(topics[1], b"\x08\x01")
        ptype, _, payload, _ = mqtt.parse_packet(pub)
        self.assertEqual(ptype, 3)
        topic, body = mqtt.parse_publish_payload(payload)
        self.assertEqual((topic, body), (topics[1], b"\x08\x01"))

    def test_connack_suback(self):
        self.assertEqual(mqtt.parse_connack(b"\x00\x00"),
                         {"session_present": False, "return_code": 0})
        self.assertEqual(mqtt.parse_suback(b"\x00\x07\x00"),
                         {"packet_id": 7, "return_codes": [0]})


class TestDnseWire(unittest.TestCase):
    def _tick_payload(self, price=55.0, vol_lots=60, acc_lots=160, ts=1793172574):
        time_node = protobuf.encode_varint_field(1, ts)
        tick = (protobuf.encode_double_field(5, price)
                + protobuf.encode_varint_field(6, vol_lots)
                + protobuf.encode_varint_field(10, acc_lots)
                + protobuf.encode_nested_field(7, time_node))
        return protobuf.encode_nested_field(45, tick)

    def test_parse_tick(self):
        payload = self._tick_payload()
        env = dnse_wire.parse_message(
            "quotes/krx/mdds/tick/v1/roundlot/symbol/UIC", payload,
            recv_ts=1793172865.96, seq=3, fieldmap_data=MAP)
        self.assertIsNotNone(env)
        self.assertEqual(env.kind, "match")
        self.assertEqual(env.sym, "UIC")
        self.assertEqual(env.price, 55000.0)
        self.assertEqual(env.vol, 600.0)
        self.assertEqual(env.acc, 1600.0)
        self.assertEqual(env.ts, 1793172574)
        self.assertFalse(env.ts_synthetic)

    def test_parse_tick_missing_time_uses_recv(self):
        tick = (protobuf.encode_double_field(5, 55.0)
                + protobuf.encode_varint_field(6, 60)
                + protobuf.encode_varint_field(10, 160))
        payload = protobuf.encode_nested_field(45, tick)
        env = dnse_wire.parse_message(
            "quotes/krx/mdds/tick/v1/roundlot/symbol/UIC", payload,
            recv_ts=1793172865.96, fieldmap_data=MAP)
        self.assertTrue(env.ts_synthetic)
        self.assertEqual(env.ts, 1793172865.96)

    def test_parse_tick_missing_price_dropped(self):
        tick = protobuf.encode_varint_field(6, 60)
        payload = protobuf.encode_nested_field(45, tick)
        self.assertIsNone(dnse_wire.parse_message(
            "quotes/krx/mdds/tick/v1/roundlot/symbol/UIC", payload,
            recv_ts=1793172865.96, fieldmap_data=MAP))

    def test_parse_stockinfo(self):
        info = (protobuf.encode_double_field(13, 55.0)
                + protobuf.encode_varint_field(22, 100)
                + protobuf.encode_varint_field(25, 88)
                + protobuf.encode_varint_field(58, 98)
                + protobuf.encode_varint_field(17, 50))
        payload = protobuf.encode_nested_field(41, info)
        env = dnse_wire.parse_message(
            "quotes/krx/mdds/stockinfo/v1/roundlot/symbol/UIC", payload,
            recv_ts=1793172865.96, fieldmap_data=MAP)
        self.assertIsNotNone(env)
        self.assertEqual(env.kind, "snapshot")
        self.assertTrue(env.ts_synthetic)
        self.assertEqual(env.fields["day_low"], 55000.0)
        self.assertEqual(env.fields["atc_volume"], 1000)
        self.assertEqual(env.fields["total_value"], 88000000000)
        self.assertEqual(env.fields["buy_value_matched"], 98000000000)
        self.assertEqual(env.fields["buy_volume"], 500)
        self.assertNotIn("last", env.fields)
        self.assertEqual(env.field_src["room"], "MISSING")

    def test_parse_empty_snapshot_dropped(self):
        payload = protobuf.encode_nested_field(41, b"")
        self.assertIsNone(dnse_wire.parse_message(
            "quotes/krx/mdds/stockinfo/v1/roundlot/symbol/UIC", payload,
            recv_ts=1793172865.96, fieldmap_data=MAP))

    def test_parse_unknown_topic_dropped(self):
        self.assertIsNone(dnse_wire.parse_message(
            "quotes/krx/mdds/other/v1/symbol/UIC", b"\x08\x01",
            recv_ts=1793172865.96, fieldmap_data=MAP))


if __name__ == "__main__":
    unittest.main()
