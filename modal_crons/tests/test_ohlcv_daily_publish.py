#!/usr/bin/env python3
"""Test offline cho PA-3a (RC3) — `publish_ohlcv_daily` trong modal_crons/app.py.

Chay: python3 modal_crons/tests/test_ohlcv_daily_publish.py
Khong mang, khong secret that, stdlib only.

Khac stub `modal` trong test_intraday_publish_fix.py (MagicMock tran):
MagicMock bien ham duoc trang thanh doi tuong goi duoc, nen khong the
kiem tra lich cua ham. O day dung fake `modal` that
(App.function ghi lai kwargs va TRA NGUYEN ham), do do kiem duoc ca:
  - dung lich Cron("15 8 * * 1-5", UTC) + timeout cho ham nay,
  - body that cua ham chay duoc (nguon + POST deu gia lap).
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import types
import unittest
from datetime import date, timedelta
from unittest import mock

APP_PATH = __file__.rsplit("/tests/", 1)[0] + "/app.py"
MODAL_CRONS_DIR = APP_PATH.rsplit("/app.py", 1)[0]
FAKE_SECRET = "TEST-SECRET-KHONG-PHAI-SECRET-THAT"


class CronSpec:
    def __init__(self, expr, timezone="UTC"):
        self.expr = expr
        self.timezone = timezone

    def __repr__(self):
        return f"Cron({self.expr!r}, timezone={self.timezone!r})"


class FakeApp:
    """Thay modal.App: ghi lai kwargs dang ky cua tung @app.function."""

    def __init__(self, name):
        self.name = name
        self.registered = {}

    def function(self, **kwargs):
        def deco(fn):
            self.registered[fn.__name__] = kwargs
            return fn                      # giu ham THAT de goi duoc
        return deco


def load_app():
    fake = types.ModuleType("modal")
    holder = FakeApp("pocket-personal-crons")
    fake.App = lambda name: holder
    fake.Cron = CronSpec
    fake.Image = mock.MagicMock(name="Image")
    fake.Volume = mock.MagicMock(name="Volume")
    fake.Secret = mock.MagicMock(name="Secret")
    saved = sys.modules.get("modal")
    sys.modules["modal"] = fake
    spec = importlib.util.spec_from_file_location("pp_crons_app", APP_PATH)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    finally:
        if saved is None:
            sys.modules.pop("modal", None)
        else:
            sys.modules["modal"] = saved
    mod.fake_app = holder
    return mod


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeRouter:
    """source_router.ohlcv gia: tra (rows, source) theo bang cua no."""

    def __init__(self, table=None, raise_for=()):
        self.table = table or {}
        self.raise_for = set(raise_for)
        self.calls = []

    @staticmethod
    def _bars(sym, n=3):
        d0 = date(2026, 10, 26)
        # Gia theo chuan source_router: NGHIN dong (kbs da chia 1000).
        return [{"date": (d0 + timedelta(days=i)).isoformat(),
                 "open": 30.5, "high": 30.65 + i, "low": 30.3,
                 "close": 30.4 + i, "volume": 9000000 + i * 1000,
                 "symbol": sym} for i in range(n)]

    def ohlcv(self, symbol, start, end):
        self.calls.append((symbol, start, end))
        if symbol in self.raise_for:
            raise RuntimeError(f"[router:ohlcv] het nguon: {symbol}")
        if symbol not in self.table:
            self.table[symbol] = (self._bars(symbol), "kbs")
        return self.table[symbol]


class AppLoadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_app()

    def test_publish_ohlcv_daily_hen_lich_eod(self):
        reg = self.mod.fake_app.registered.get("publish_ohlcv_daily")
        self.assertIsNotNone(reg, "ham chua duoc dang ky @app.function")
        sched = reg["schedule"]
        self.assertIsInstance(sched, CronSpec)
        self.assertEqual(sched.expr, "15 8 * * 1-5")
        self.assertEqual(sched.timezone, "UTC")
        # 15:15 ICT = sau HOSE dong cua 14:45 ICT (EOD, nguon D1).
        self.assertEqual(sched.expr.split()[1], "8")

    def test_timeout_du_cho_47_ma(self):
        reg = self.mod.fake_app.registered["publish_ohlcv_daily"]
        self.assertEqual(reg["timeout"], 60 * 50)
        self.assertEqual(reg["image"], self.mod.stock_image)

    def test_universe_mac_dinh_la_quote_universe(self):
        import inspect
        sig = inspect.signature(self.mod.publish_ohlcv_daily)
        self.assertEqual(sig.parameters["symbols"].default,
                         tuple(self.mod.QUOTE_UNIVERSE))
        self.assertGreaterEqual(len(sig.parameters["symbols"].default), 40)


class BuildPayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_app()

    def test_key_va_shape_dung_contract_R2(self):
        rt = _FakeRouter()
        payload = self.mod.build_ohlcv_daily_payload(
            ["CTG", "DGC"], rt, days=800, today=date(2026, 10, 29))
        self.assertIn("ohlcv", payload)
        self.assertEqual(sorted(payload["ohlcv"]), ["CTG", "DGC"])
        rows = payload["ohlcv"]["CTG"]
        self.assertEqual(list(rows[0]), ["t", "o", "h", "l", "c", "v"])
        # KHONG quy doi gia: source_router da chuan hoa sang nghin dong,
        # frontend tu nhan 1000 (detail.js:508,548) -> producer giu nguyen.
        self.assertEqual(rows[0]["t"], "2026-10-26")
        self.assertEqual(rows[0]["c"], 30.4)
        self.assertEqual(rows[0]["v"], 9000000)
        # Key thua cua nguon (symbol) khong boc vao R2.
        self.assertNotIn("symbol", rows[0])

    def test_moc_time_EOD_theo_nga_y(self):
        rt = _FakeRouter()
        self.mod.build_ohlcv_daily_payload(["CTG"], rt, days=800,
                                           today=date(2026, 10, 29))
        sym, start, end = rt.calls[0]
        self.assertEqual(end, "2026-10-29")
        self.assertEqual(start, (date(2026, 10, 29) - timedelta(days=800)).isoformat())

    def test_provenance_chi_ra_nguon_thuc(self):
        table = {"CTG": (_FakeRouter._bars("CTG"), "kbs"),
                 "DGC": (_FakeRouter._bars("DGC"), "vnstock")}
        payload = self.mod.build_ohlcv_daily_payload(
            ["CTG", "DGC"], _FakeRouter(table), today=date(2026, 10, 29))
        src = payload["_prov"]["source"]
        self.assertIn("kbs", src)
        self.assertIn("vnstock", src)
        self.assertTrue(payload["_prov"]["retrieved_at"])

    def test_ma_het_nguon_bi_bo_qua_khong_chan_run(self):
        rt = _FakeRouter(raise_for=["DGC"])
        with contextlib.redirect_stdout(io.StringIO()):
            payload = self.mod.build_ohlcv_daily_payload(
                ["CTG", "DGC"], rt, today=date(2026, 10, 29))
        self.assertEqual(list(payload["ohlcv"]), ["CTG"])
        self.assertNotIn("DGC", payload["ohlcv"])

    def test_rong_khong_bao_gio_gui_list_trong(self):
        empty = {"CTG": ([], "kbs")}
        with contextlib.redirect_stdout(io.StringIO()):
            payload = self.mod.build_ohlcv_daily_payload(
                ["CTG"], _FakeRouter(empty), today=date(2026, 10, 29))
        # List rong ghi de lane dang du -> chart mat nen; phai bo.
        self.assertEqual(payload["ohlcv"], {})


class FunctionRunTests(unittest.TestCase):
    """Chay body THAT cua publish_ohlcv_daily (nguon gia, POST gia)."""

    def setUp(self):
        self.mod = load_app()
        # _use_direct_fetch can nap direct_fetch tu DIRECT_FETCH_DIR.
        self.env = {"DIRECT_FETCH_DIR": MODAL_CRONS_DIR,
                    "STOCK_PUBLISH_SECRET": FAKE_SECRET}
        self._env = mock.patch.dict(os.environ, self.env)
        self._env.start()
        self.addCleanup(self._env.stop)
        # Nap that de sys.path cua module chi dung thu muc nay.
        self.saved_router = sys.modules.get("source_router")
        sys.modules["source_router"] = _FakeRouter()
        self.addCleanup(self._restore_router)
        self.posts = []
        self._post = mock.patch.object(
            self.mod, "_post_publish",
            side_effect=lambda p: self.posts.append(p) or {"ok": True})
        self._post.start()
        self.addCleanup(self._post.stop)

    def _restore_router(self):
        if self.saved_router is None:
            sys.modules.pop("source_router", None)
        else:
            sys.modules["source_router"] = self.saved_router

    def test_ham_chi_phat_lane_ohlcv(self):
        with contextlib.redirect_stdout(io.StringIO()):
            out = self.mod.publish_ohlcv_daily(("CTG", "DGC"))
        self.assertEqual(out, {"ok": True})
        self.assertEqual(len(self.posts), 1)
        payload = self.posts[0]
        self.assertEqual(set(payload), {"ohlcv", "_prov"})
        # PA-3a ham hep: KHONG keo theo lane da khai tu (indices,
        # quotes_patch cua publish_snapshot) hay lane nen intraday
        # (PA-1 lo) — khong ghi de duong cua chang khac.
        for dead in ("indices", "sector_indices", "quotes",
                     "quotes_patch", "intraday", "tick_live",
                     "tick_shadow", "tape"):
            self.assertNotIn(dead, payload)

    def test_khong_lay_duoc_nen_thi_raise(self):
        sys.modules["source_router"] = _FakeRouter(
            {"CTG": ([], "kbs")})
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                self.mod.publish_ohlcv_daily(("CTG",))
        self.assertEqual(self.posts, [])


class PostHelperTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_app()

    def test_post_dung_url_noi_bo_va_header_secret(self):
        captured = {}
        fake = _FakeResponse({"ok": True, "n": 1})

        def _urlopen(req, timeout=None):
            captured["req"] = req
            captured["timeout"] = timeout
            return fake

        env = {"STOCKAPP_PUBLISH_URL": "https://publish.invalid/internal",
               "STOCK_PUBLISH_SECRET": FAKE_SECRET}
        with mock.patch.dict(os.environ, env), \
                mock.patch("urllib.request.urlopen", _urlopen):
            result = self.mod._post_publish({"ohlcv": {"CTG": [{"t": "x"}]}})

        req = captured["req"]
        self.assertEqual(result, {"ok": True, "n": 1})
        self.assertEqual(req.full_url, "https://publish.invalid/internal")
        self.assertEqual(req.get_method(), "POST")
        with open(APP_PATH, encoding="utf-8") as f:
            app_src = f.read()
        # Secret phai tu env, khong hardcode trong code.
        self.assertEqual(req.headers["X-publish-secret"], FAKE_SECRET)
        self.assertEqual(req.headers["X-internal-secret"], FAKE_SECRET)
        self.assertNotIn(FAKE_SECRET, app_src)
        self.assertEqual(json.loads(req.data.decode())["ohlcv"]["CTG"],
                         [{"t": "x"}])


if __name__ == "__main__":
    unittest.main(verbosity=2)
