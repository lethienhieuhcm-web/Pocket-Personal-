#!/usr/bin/env python3
"""Test cho index_guard (F4, IMPL-PLAN B1, 04/11).

Kiem 2 thu:
  (1) apply_index_guard dat dung stale/age_s/suspect tu `time` vs ngay
      phien va GIU LAI `_date_mismatch` tren dong stale (khong pop);
  (2) nhanh except fail-open trong source_router.py CHI log — khong con
      `pop("_date_mismatch")` cung khong `setdefault("stale", False)`
      (ban fix khong duoc xoa bang chung nua), va router import duoc
      index_guard nhu sibling khi chay tu modal_crons/.

Chay: python3 modal_crons/tests/test_index_guard.py
stdlib only, khong mang, khong secret.
"""
import importlib.util
import os
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CRON_DIR = HERE.rsplit("/tests", 1)[0]
IG_PATH = os.path.join(CRON_DIR, "index_guard.py")
SR_PATH = os.path.join(CRON_DIR, "source_router.py")

ICT = timezone(timedelta(hours=7))


def load_index_guard():
    spec = importlib.util.spec_from_file_location("index_guard", IG_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ig = load_index_guard()


class ApplyIndexGuardTests(unittest.TestCase):
    def test_yesterday_row_is_stale_and_keeps_marker(self):
        now = datetime(2026, 11, 4, 13, 30, tzinfo=ICT)
        yday = (now.date() - timedelta(days=1)).isoformat()
        rows = [{
            "symbol": "VNINDEX", "close": 1200.0, "time": yday,
            "change": None, "pct_change": None, "_date_mismatch": True,
        }]
        out = ig.apply_index_guard(rows, now=now)
        r = out[0]
        self.assertTrue(r["stale"], "dong hom qua phai stale=True")
        self.assertIn("_date_mismatch", r, "guard PHAI giu _date_mismatch")
        self.assertTrue(r["_date_mismatch"])
        self.assertEqual(r["age_s"], 86400, "1 ngay lech = 86400s chan luoi")
        # change/pct da bi normalizer null → stale nhung khong "suspect"
        self.assertFalse(r["suspect"])

    def test_stale_row_with_move_is_suspect(self):
        # Truong hop fail-open nguy hiem: row lech ngay VAN con change.
        now = datetime(2026, 11, 4, 13, 30, tzinfo=ICT)
        yday = (now.date() - timedelta(days=2)).isoformat()
        rows = [{"symbol": "VN30", "time": yday, "change": 5.0,
                 "pct_change": 0.4, "_date_mismatch": True}]
        r = ig.apply_index_guard(rows, now=now)[0]
        self.assertTrue(r["stale"])
        self.assertTrue(r["suspect"], "stale + con change => suspect")
        self.assertEqual(r["age_s"], 2 * 86400)
        self.assertTrue(r["_date_mismatch"])

    def test_fresh_today_row_not_stale(self):
        now = datetime(2026, 11, 4, 9, 15, tzinfo=ICT)
        today = now.date().isoformat()
        rows = [{"symbol": "HNXINDEX", "time": today, "change": 1.0,
                 "pct_change": 0.1}]
        r = ig.apply_index_guard(rows, now=now)[0]
        self.assertFalse(r["stale"])
        self.assertFalse(r["suspect"])
        self.assertEqual(r["age_s"], 0)
        self.assertNotIn("_date_mismatch", r)

    def test_unparseable_date_is_stale(self):
        now = datetime(2026, 11, 4, 9, 15, tzinfo=ICT)
        rows = [{"symbol": "X", "time": "", "change": None}]
        r = ig.apply_index_guard(rows, now=now)[0]
        self.assertTrue(r["stale"])
        self.assertIsNone(r["age_s"])

    def test_guard_is_importable_as_sibling_from_cron_dir(self):
        # source_router.py:204 `import index_guard` phai tim thay module
        # khi chay tu modal_crons/ (LightVela copy) — nhu cron_jobs nap no.
        sys.path.insert(0, CRON_DIR)
        try:
            import index_guard  # noqa: F401
            self.assertTrue(hasattr(index_guard, "apply_index_guard"))
        finally:
            sys.path.remove(CRON_DIR)


class RouterFailOpenEvidenceTests(unittest.TestCase):
    """Nhanh except cua router phai chi log, khong xoa bang chung."""

    def test_router_except_does_not_erase_evidence(self):
        with open(SR_PATH, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("import index_guard", src)
        # Bang chung cu: fail-open truoc day xoa `_date_mismatch` + dat
        # stale=False. Sau F4 nhung dong lenh nay KHONG duoc con.
        self.assertNotIn('r.pop("_date_mismatch"', src,
                         "except khong duoc pop _date_mismatch nua")
        self.assertNotIn('r.setdefault("stale", False)', src,
                         "except khong duoc setdefault stale=False nua")
        self.assertNotIn('r.setdefault("suspect", False)', src)

    def test_source_router_imports_clean(self):
        stub = mock.MagicMock(name="modal")
        sys.modules.setdefault("modal", stub)
        sys.path.insert(0, CRON_DIR)
        try:
            spec = importlib.util.spec_from_file_location(
                "source_router", SR_PATH)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            self.assertTrue(hasattr(mod, "index_snapshot"))
        finally:
            sys.path.remove(CRON_DIR)


if __name__ == "__main__":
    unittest.main()
