"""Tests for fixtures/restore_from_r2.py download_one (.gz-first fallback).

Stdlib only, no network, no secrets. The module is loaded by path with
stubbed requests/dynamic_credentials modules, so the suite stays runnable
without those packages installed.
"""
import gzip
import importlib.util
import io
import os
import sys
import tempfile
import types
import unittest

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "fixtures")


def load_restore_module():
    if "requests" not in sys.modules:
        sys.modules["requests"] = types.ModuleType("requests")
    if "dynamic_credentials" not in sys.modules:
        fake_dc = types.ModuleType("dynamic_credentials")

        def _unused(*args, **kwargs):
            raise RuntimeError("credential entry must not be called in tests")

        fake_dc.dynamic_credential_entry = _unused
        sys.modules["dynamic_credentials"] = fake_dc
    path = os.path.join(FIXTURES, "restore_from_r2.py")
    spec = importlib.util.spec_from_file_location("restore_from_r2", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


MOD = load_restore_module()


class FakeResponse:
    def __init__(self, status, body=b""):
        self.status_code = status
        self._body = body
        self.closed = False

    def iter_content(self, chunk_size=1 << 20):
        yield self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def close(self):
        self.closed = True


class DownloadOneTest(unittest.TestCase):
    def test_gz_hit_is_gunzipped(self):
        raw = b'{"a":1}\n' * 1000
        gz = gzip.compress(raw, compresslevel=9, mtime=0)

        def get_response(key):
            self.assertTrue(key.endswith(".gz"))
            return FakeResponse(200, gz)

        with tempfile.TemporaryDirectory() as d:
            dest = os.path.join(d, "raw_kbs.jsonl")
            total = MOD.download_one(get_response, "instabox-live/20261029/raw_kbs.jsonl", dest)
            self.assertEqual(total, len(gz))
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), raw)
            self.assertFalse(os.path.exists(dest + ".download"))

    def test_fallback_to_plain_on_404(self):
        raw = b"plain\n"

        def get_response(key):
            if key.endswith(".gz"):
                return FakeResponse(404)
            return FakeResponse(200, raw)

        with tempfile.TemporaryDirectory() as d:
            dest = os.path.join(d, "raw_dnse.jsonl")
            total = MOD.download_one(get_response, "instabox-live/20261028/raw_dnse.jsonl", dest)
            self.assertEqual(total, len(raw))
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), raw)

    def test_both_404_raises(self):
        def get_response(key):
            return FakeResponse(404)

        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(RuntimeError):
                MOD.download_one(get_response, "instabox-live/20261028/nope.jsonl",
                                 os.path.join(d, "nope.jsonl"))

    def test_gz_bytes_roundtrip_against_real_artifact(self):
        # The real 200MB measurement artifact, if present, must gunzip
        # through the same code path download_one uses.
        artifact = os.path.expanduser(
            "~/workspace/instabox-collector/scratch/gzip-measure/raw_kbs.jsonl.gz")
        orig = os.path.expanduser("~/workspace/instabox-collector/vm-pull/raw_kbs.jsonl")
        if not (os.path.exists(artifact) and os.path.exists(orig)):
            self.skipTest("measurement artifact not present")
        with open(artifact, "rb") as f:
            gz = f.read()

        def get_response(key):
            return FakeResponse(200, gz)

        with tempfile.TemporaryDirectory() as d:
            dest = os.path.join(d, "raw_kbs.jsonl")
            MOD.download_one(get_response, "instabox-live/20261029/raw_kbs.jsonl", dest)
            import hashlib
            h1 = hashlib.sha256(open(dest, "rb").read()).hexdigest()
            h2 = hashlib.sha256(open(orig, "rb").read()).hexdigest()
            self.assertEqual(h1, h2)


if __name__ == "__main__":
    unittest.main()
