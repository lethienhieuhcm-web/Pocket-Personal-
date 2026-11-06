#!/usr/bin/env python3
"""Test offline cho modal_crons/gateway_client.py (AI Gateway + Workers AI,
Chot trien khai 16:00 06/11). Chung minh:
  (a) gateway compat tra dung shape (verdict doc duoc tu JSON);
  (b) leg 1 (cerebras) loi transport → roi sang leg 2 (gemini) van OK;
  (c) Workers AI het quota (429/'out of allocation') → loi CO KIEM SOAT
      (reason workers_ai_quota, khong crash, khong goi lan 2 vao quota);
  (d) verdict no-rating → DOI LEG (logic tang verdict giu trong code);
  (e) gateway tat → duong truc tiep cu (gemini direct) van chay.
Chay: python3 modal_crons/tests/test_gateway_client.py
Khong mang, khong secret — mock _post_json (stdlib only)."""
import importlib.util
import os
import sys
import unittest
from unittest import mock

GC_PATH = __file__.rsplit("/tests/", 1)[0] + "/gateway_client.py"


def load_gc():
    spec = importlib.util.spec_from_file_location("gateway_client", GC_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gc = load_gc()

ENV_ON = {
    "AI_GATEWAY_ENABLED": "1",
    "AI_GATEWAY_ACCOUNT_ID": "acct123",
    "CEREBRAS_API_KEY": "cerebras-k",
    "GEMINI_API_KEYS": "gk1,gk2",
    "CLOUDFLARE_ACCOUNT_ID": "acct123",
    "CLOUDFLARE_API_TOKEN": "cf-tok",
}


def ok_openai(text):
    return 200, {"choices": [{"message": {"content": text}}]}


def compat_url_called(call_log, url):
    return [c for c in call_log if c[0] == url]


class TestGatewayClient(unittest.TestCase):
    def setUp(self):
        self.msgs = [{"role": "user", "content": "verdict cho FPT?"}]

    # (a) shape: compat response -> verdict rating doc duoc, leg 1 du
    def test_a_gateway_shape_and_leg_order(self):
        calls = []

        def fake_post(url, headers, payload, timeout):
            calls.append((url, headers, payload))
            return ok_openai('{"rating": "Mua", "target": 100}')

        with mock.patch.object(gc, "_post_json", fake_post):
            out = gc.consensus_call(self.msgs, env=ENV_ON)
        self.assertTrue(out["ok"])
        self.assertEqual(out["via"], gc.MODEL_CEREBRAS)
        self.assertEqual(out["verdict"]["rating"], "Mua")
        # leg 1 = cerebras, model gui dung dang {provider}/{model}
        self.assertEqual(calls[0][2]["model"], "cerebras/gpt-oss-120b")
        self.assertIn("/acct123/default/compat/chat/completions", calls[0][0])
        # key lay tu env, khong hardcode
        self.assertEqual(calls[0][1]["Authorization"], "Bearer cerebras-k")

    # (b) leg 1 loi 500 → leg 2 gemini 200
    def test_b_leg1_failover_to_leg2(self):
        def fake_post(url, headers, payload, timeout):
            if payload["model"] == gc.MODEL_CEREBRAS:
                return 500, {"error": "boom"}
            return ok_openai('{"rating": "Trung lap"}')

        with mock.patch.object(gc, "_post_json", fake_post):
            out = gc.consensus_call(self.msgs, env=ENV_ON)
        self.assertTrue(out["ok"])
        self.assertEqual(out["via"], "google-ai-studio/gemini-3.5-flash")

    # (b2) loi transport (exception) cung sang leg tiep
    def test_b2_transport_error_failover(self):
        def fake_post(url, headers, payload, timeout):
            if payload["model"] == gc.MODEL_CEREBRAS:
                raise gc.GatewayError("transport:URLError")
            return ok_openai('{"rating": "Ban"}')

        with mock.patch.object(gc, "_post_json", fake_post):
            out = gc.consensus_call(self.msgs, env=ENV_ON)
        self.assertTrue(out["ok"])
        self.assertEqual(out["verdict"]["rating"], "Ban")

    # (c) het quota Workers AI → loi co kiem soat
    def test_c_quota_controlled(self):
        calls = []

        def fake_post(url, headers, payload, timeout):
            calls.append(url)
            if "/ai/run/" in url:
                return 429, {"success": False,
                             "errors": [{"message":
                                         "You have run out of the free allocation "
                                         "of 10,000 Neurons for today."}]}
            raise gc.GatewayError("gateway_down:http_503")

        with mock.patch.object(gc, "_post_json", fake_post):
            out = gc.consensus_call(self.msgs, env=ENV_ON)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "workers_ai_quota")
        # Workers AI REST chi bi goi DUNG 1 lan (khong dot quota them)
        rest = [c for c in calls if "/ai/run/" in c]
        self.assertEqual(len(rest), 1)

    # (d) no-rating leg 1 → doi leg, lay verdict leg 2
    def test_d_no_rating_switches_leg(self):
        seen = []

        def fake_post(url, headers, payload, timeout):
            seen.append(payload["model"])
            if payload["model"] == gc.MODEL_CEREBRAS:
                return ok_openai('{"rating": null}')  # verdict rong
            return ok_openai('{"rating": "Mua"}')

        with mock.patch.object(gc, "_post_json", fake_post):
            out = gc.consensus_call(self.msgs, env=ENV_ON)
        self.assertTrue(out["ok"])
        self.assertEqual(len(seen), 2)  # leg 2 da duoc goi
        self.assertEqual(out["verdict"]["rating"], "Mua")

    # (d2) moi leg deu no-rating → tra no_rating co kiem soat (khong phai loi)
    def test_d2_all_no_rating(self):
        def fake_post(url, headers, payload, timeout):
            return ok_openai('{"rating": "no rating"}')

        with mock.patch.object(gc, "_post_json", fake_post):
            out = gc.consensus_call(self.msgs, env=ENV_ON)
        self.assertTrue(out["ok"])
        self.assertTrue(out.get("no_rating"))

    # (e) gateway tat → duong truc tiep cu (gemini direct + workersai $0)
    def test_e_direct_when_disabled(self):
        env = dict(ENV_ON)
        env["AI_GATEWAY_ENABLED"] = "0"
        calls = []

        def fake_post(url, headers, payload, timeout):
            calls.append(url)
            if "generativelanguage" in url:
                return 200, {"candidates": [
                    {"content": {"parts": [{"text": '{"rating": "Nam giu"}'}]}}]}
            return ok_openai('{"rating": "Nam giu"}')

        with mock.patch.object(gc, "_post_json", fake_post):
            out = gc.consensus_call(self.msgs, env=env)
        self.assertTrue(out["ok"])
        self.assertEqual(out["via"], "direct-gemini")
        self.assertTrue(any("generativelanguage" in c for c in calls))
        # khong goi gateway compat
        self.assertFalse(any("gateway.ai.cloudflare.com" in c for c in calls))

    def test_parse_verdict_helpers(self):
        self.assertEqual(gc.parse_verdict('tra loi: {"rating":"Mua"}')["rating"], "Mua")
        self.assertIsNone(gc.parse_verdict("khong co json")["rating"])
        self.assertTrue(gc.is_no_rating({"rating": None}))
        self.assertTrue(gc.is_no_rating({"rating": "No Rating"}))
        self.assertFalse(gc.is_no_rating({"rating": "Ban"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
