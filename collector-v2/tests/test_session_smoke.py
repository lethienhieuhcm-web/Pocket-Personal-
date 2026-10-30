"""Smoke test session runner: chay that run_session voi mock broker.

Chung minh wiring gate -> WAL -> consumer -> SQLite + checkpoint/status
qua CLI/config that, khong noi cong that."""
import json
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mock_broker import MockBroker  # noqa: E402
from collector import dnse_wire, protobuf  # noqa: E402
from collector.session import SessionConfig, run_session, parse_symbols_text  # noqa: E402
from collector.store import SessionStore  # noqa: E402
from test_gd1_loop import _tick_payload, _minute_now  # noqa: E402


class TestSessionSmoke(unittest.TestCase):
    def test_run_session_against_mock_broker(self):
        tick_topic = dnse_wire.topics_for(["UIC"])[1]
        script = [("publish", tick_topic, _tick_payload()),
                  ("wait", 2)]
        broker = MockBroker(script).start()
        try:
            with tempfile.TemporaryDirectory() as d:
                out_dir = os.path.join(d, "session")
                cfg = SessionConfig(["UIC"], out_dir, ws_url=f"ws://127.0.0.1:{broker.port}",
                                    minutes=0.08, flush_sec=5)
                os.environ["DNSE_MQTT_USER"] = "u"
                os.environ["DNSE_MQTT_PW"] = "p"
                t = threading.Thread(target=run_session, args=(cfg,),
                                     daemon=True)
                t.start()
                t.join(timeout=30)
                self.assertFalse(t.is_alive())
                self.assertTrue(os.path.exists(os.path.join(out_dir, "checkpoint.json")))
                self.assertTrue(os.path.exists(os.path.join(out_dir, "status.json")))
                self.assertTrue(os.path.exists(os.path.join(out_dir, "raw_dnse.jsonl")))
                with open(os.path.join(out_dir, "checkpoint.json"), encoding="utf-8") as f:
                    ckpt = json.load(f)
                self.assertGreaterEqual(ckpt["flush_count"], 1)
                store = SessionStore(os.path.join(out_dir, "session.db"))
                try:
                    buckets = store.load_buckets()
                finally:
                    store.close()
                self.assertEqual(len(buckets), 1)
                key = next(iter(buckets))
                self.assertEqual(key[1], "UIC")
                self.assertEqual(buckets[key][4], 600.0)
                self.assertEqual(key[2], _minute_now())
        finally:
            broker.stop()
            os.environ.pop("DNSE_MQTT_USER", None)
            os.environ.pop("DNSE_MQTT_PW", None)


class TestParseSymbols(unittest.TestCase):
    def test_dict_format_universe(self):
        raw = json.dumps([{"symbol": "acb", "exchange": "HOSE"},
                          {"symbol": "VCB", "exchange": "HOSE"},
                          {"symbol": "acb", "exchange": "HOSE"},
                          {"exchange": "HOSE"},
                          {"code": "fpt"}])
        self.assertEqual(parse_symbols_text(raw), ["ACB", "VCB", "FPT"])

    def test_string_array_and_lines(self):
        self.assertEqual(parse_symbols_text('["acb", "VCB", ""]'), ["ACB", "VCB"])
        self.assertEqual(parse_symbols_text("acb\n\nVCB\nacb\n"), ["ACB", "VCB"])


if __name__ == "__main__":
    unittest.main()
