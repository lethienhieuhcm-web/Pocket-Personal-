#!/usr/bin/env python3
"""Test offline cho fix "chunk roi bang gia KBS" (06/11/2026, CHUA deploy).

Chay: python3 modal_crons/tests/test_kbs_board_chunk.py
Khong mang, khong secret, stdlib only.

Hien truoc do sua: POST 100 ma cua room ngoai bi proxy cat, retry co
dinh 2s x3 khong vuot qua con stall, `publish_foreign_room.py` nuot
exception va PUBLISH phong khuyet (1.190/1.518) de ghi de phong tot.
"""
import contextlib
import http.client
import importlib.util
import json
import sys
import unittest
from unittest import mock

BASE = __file__.rsplit("/tests/", 1)[0]


@contextlib.contextmanager
def use_conn(conn):
    """Chat ket noi gia vao threading.local THAT de _kbs_conn_drop()
    duoc goi that va dong duoc ket noi — neu khong, test se mo khung."""
    df._KBS_CONN.conn = conn

    def fake(timeout):
        return conn
    with mock.patch.object(df, "_kbs_conn", fake):
        try:
            yield conn
        finally:
            df._KBS_CONN.conn = None


def load(name):
    spec = importlib.util.spec_from_file_location(name, f"{BASE}/{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


df = load("direct_fetch")
rt = load("source_router")


class FakeConn:
    """HTTPSConnection gia lap: ghi nhan request, phat ra `responses`."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.closed = 0

    def request(self, method, path, body=None, headers=None):
        self.calls.append({"method": method, "path": path,
                           "body": body, "headers": dict(headers or {})})

    def getresponse(self):
        r = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        return r

    def close(self):
        self.closed += 1


class FakeResp:
    def __init__(self, raw, status=200, encoding="gzip"):
        self._raw, self.status = raw, status
        self._enc = encoding

    def read(self):
        return self._raw

    def getheader(self, name, default=None):
        return self._enc if name == "Content-Encoding" else default


class _IncompleteResp:
    """Proxy cat body giua chung: read() tra ve nua phan roi noi loi."""

    def __init__(self, partial, status=200, encoding="gzip"):
        self._partial, self.status, self._enc = partial, status, encoding

    def read(self):
        raise http.client.IncompleteRead(self._partial)

    def getheader(self, name, default=None):
        return self._enc if name == "Content-Encoding" else default


class BackoffTest(unittest.TestCase):
    def test_backoff_tang_dan_va_co_chan(self):
        vals = [df._kbs_board_backoff(i) for i in range(8)]
        self.assertLess(vals[0], vals[1])
        self.assertLess(vals[1], vals[3])
        for v in vals:
            self.assertLessEqual(v, 30.0 * 1.25 + 0.001)

    def test_backoff_co_jitter(self):
        seen = {round(df._kbs_board_backoff(2), 6) for _ in range(20)}
        self.assertGreater(len(seen), 1, "jitter that vuong = co dinh")


class TransportTest(unittest.TestCase):
    def _run(self, responses, codes=("FPT", "HPG"), attempts=3):
        conn = FakeConn(responses)
        with use_conn(conn):
            out = df.kbs_price_board(list(codes), attempts=attempts)
        return out, conn

    def test_gzip_theo_do_mau_khong_the_nho_header(self):
        import gzip
        rows = [{"SB": "FPT", "FO": 1, "FR": 2}, {"SB": "HPG",
                                                 "FO": 3, "FR": 4}]
        payload = gzip.compress(json.dumps(rows).encode())
        # header NOE gzip bi proxy lam mat -> van phai parse duoc
        for enc in ("gzip", None):
            out, _ = self._run([FakeResp(payload, encoding=enc)])
            self.assertEqual(sorted(out), ["FPT", "HPG"])

    def test_proxy_da_goi_nen_body_plain_header_van_gzip(self):
        rows = [{"SB": "FPT", "FO": 1, "FR": 2}]
        out, _ = self._run([FakeResp(json.dumps(rows).encode(),
                                     encoding="gzip")])
        self.assertEqual(list(out), ["FPT"])

    def test_body_bi_cat_khong_duoc_coi_la_thanh_cong(self):
        """`except IncompleteRead: raw = e.partial` da bi loai bo."""
        import gzip
        good = gzip.compress(json.dumps([{"SB": "FPT", "FO": 1,
                                          "FR": 2}]).encode())
        conn = FakeConn([_IncompleteResp(good[:5])])
        with use_conn(conn):
            with self.assertRaises(df.KbsTransportError) as ctx:
                df.kbs_price_board(["FPT"], attempts=2)
        # moi lan phai la mot lan that bai RANG RO, khong phai partial OK
        self.assertEqual(ctx.exception.requested, 1)
        self.assertEqual(len(conn.calls), 2, "ca 2 lan deu goi that")
        # Ket noi bi nhiem doc phai dong lai (production: moi lan drop la
        # mot HTTPSConnection moi; fake tra lai vat y het nen chi thay 1).
        self.assertGreaterEqual(conn.closed, 1)

    def test_khong_phai_list_thi_that_bai(self):
        conn = FakeConn([FakeResp(json.dumps({"error": "x"}).encode(),
                                  encoding=None)])
        with use_conn(conn):
            with self.assertRaises(df.KbsTransportError):
                df.kbs_price_board(["FPT"], attempts=1)

    def test_non_200_that_bai(self):
        conn = FakeConn([FakeResp(b"boom", status=503, encoding=None)])
        with use_conn(conn):
            with self.assertRaises(df.KbsTransportError):
                df.kbs_price_board(["FPT"], attempts=1)

    def test_identity_switch_sau_KBS_BOARD_IDENTITY_AFTER(self):
        rows = [{"SB": "FPT", "FO": 1, "FR": 2}]
        payload = json.dumps(rows).encode()
        conn = FakeConn([FakeResp(payload, status=500, encoding=None),
                         FakeResp(payload, status=500, encoding=None),
                         FakeResp(payload, encoding=None)])
        with use_conn(conn), mock.patch.object(df.time, "sleep", lambda s: None):
            out = df.kbs_price_board(["FPT"], attempts=3)
        self.assertEqual(list(out), ["FPT"])
        encs = [c["headers"]["Accept-Encoding"] for c in conn.calls]
        self.assertEqual(encs[0], "gzip, deflate")
        self.assertEqual(encs[-1], "identity", "phai doi sang identity")

    def test_keep_alive_dung_lai_mot_ket_noi(self):
        rows = [{"SB": "FPT", "FO": 1, "FR": 2}]
        payload = json.dumps(rows).encode()
        conn = FakeConn([FakeResp(payload, encoding=None)])
        made = []

        def spy(timeout):
            made.append(timeout)
            return conn
        with mock.patch.object(df, "_kbs_conn", spy):
            df.kbs_price_board(["FPT"], attempts=1)
            df.kbs_price_board(["FPT"], attempts=1)
        self.assertEqual(len(made), 2, "cung timeout -> tam chung 1 ket noi")

    def test_retry_backoff_dung_thoi_gian_khong_phi(self):
        conn = FakeConn([FakeResp(b"", status=500, encoding=None)])
        slept = []
        with use_conn(conn), mock.patch.object(df.time, "sleep",
                                                lambda s: slept.append(s)):
            with self.assertRaises(df.KbsTransportError):
                df.kbs_price_board(["FPT"], attempts=3)
        self.assertEqual(len(slept), 2, "lan cuoi khong can ngu")
        self.assertEqual(len(conn.calls), 3)

    def test_danh_sach_trong_khong_goi_mang(self):
        with mock.patch.object(df, "_kbs_conn",
                               side_effect=AssertionError("phai goi mang")):
            self.assertEqual(df.kbs_price_board([]), {})

    def test_kbs_error_co_thong_tin_yeu_cau(self):
        conn = FakeConn([FakeResp(b"", status=500, encoding=None)])
        with use_conn(conn), mock.patch.object(df.time, "sleep", lambda s: None):
            with self.assertRaises(df.KbsTransportError) as ctx:
                df.kbs_price_board(["FPT", "HPG", "VIC"], attempts=1)
        self.assertEqual(ctx.exception.requested, 3)
        self.assertEqual(ctx.exception.attempts, 1)
        self.assertIsInstance(ctx.exception, RuntimeError,
                             "tuong thich nguoi bat RuntimeError cu")


class RouterChunkTest(unittest.TestCase):
    """_board_kbs: mot chunk loi KHONG duoc giet ca bang."""

    def _patch_board(self, fail_codes):
        calls = []

        def fake(symbols, timeout=None, attempts=None):
            syms = list(symbols)
            calls.append(len(syms))
            bad = [s for s in syms if s in fail_codes]
            if bad:
                raise ConnectionResetError("Remote end closed connection")
            return {s: {"close": 1, "foreign_buy_value": None,
                        "foreign_sell_value": None} for s in syms}
        return fake, calls

    def test_chunk_loi_khong_anh_huong_chunk_khac(self):
        fake, _ = self._patch_board({"AAA"})
        with mock.patch.object(df, "kbs_price_board", fake):
            got, missing = rt._kbs_board_chunks(
                ["FPT", "AAA", "HPG", "SSI"], 2, "t")
        # chunk [FPT, AAA] chet CA TWO ma (do la don vi goi) -> [HPG, SSI]
        self.assertEqual(sorted(got), ["HPG", "SSI"])
        self.assertEqual(missing, ["FPT", "AAA"])

    def test_tra_thieu_ma_cung_tinh_la_thieu(self):
        def fake(symbols, timeout=None, attempts=None):
            return {s: {"close": 1} for s in list(symbols)[:1]}
        with mock.patch.object(df, "kbs_price_board", fake):
            got, missing = rt._kbs_board_chunks(["FPT", "HPG", "VIC"], 3, "t")
        self.assertEqual(sorted(missing), ["HPG", "VIC"])
        self.assertEqual(list(got), ["FPT"])

    def test_board_kbs_refetch_idempotent_lan_2(self):
        # Lan 1 (chunk 10) chet voi moi goi >= 10 ma; lan 2 (chunk 5) OK.
        calls = []

        def fake(symbols, timeout=None, attempts=None):
            syms = list(symbols)
            calls.append(len(syms))
            if len(syms) >= 10:
                raise ConnectionResetError("stall")
            return {s: {"close": 1, "foreign_buy_value": 9,
                        "foreign_sell_value": 9} for s in syms}
        with mock.patch.object(df, "kbs_price_board", fake), \
                mock.patch.object(df, "vci_symbols",
                                  side_effect=AssertionError("khong can VCI")):
            out = rt._board_kbs([f"S{i}" for i in range(20)])
        self.assertEqual(len(out), 20, "ca 20 ma phai duoc phuc hoi")
        self.assertIn(10, calls)
        self.assertIn(5, calls, "lan 2 phai dung chunk nho hon")

    def test_coverage_thap_thi_raise_de_roi_xuong_vci(self):
        def fake(symbols, timeout=None, attempts=None):
            raise ConnectionResetError("KBS chet hoan toan")
        with mock.patch.object(df, "kbs_price_board", fake), \
                mock.patch.object(df, "vci_symbols",
                                  return_value={}) as vci:
            with self.assertRaises(RuntimeError) as ctx:
                rt._board_kbs([f"S{i}" for i in range(10)])
        self.assertIn("bao phu", str(ctx.exception))

    def test_price_board_roi_xuong_vci_khi_kbs_lech(self):
        def fake(symbols, timeout=None, attempts=None):
            raise ConnectionResetError("KBS chet")
        vci_out = {"FPT": {"close": 10, "open": 9, "volume": 1,
                           "value": 2, "exchange": "HOSE"}}
        with mock.patch.object(df, "kbs_price_board", fake), \
                mock.patch.object(df, "vci_symbols", return_value=vci_out):
            data, src = rt.price_board(["FPT"])
        self.assertEqual(src, "vci")
        self.assertEqual(data["FPT"]["close"], 10)

    def test_khong_con_nuot_loi_im_lang(self):
        """Truoc fix: 1 chunk loi -> ca _board_kbs noi loi (mat both).
        Sau fix: phan nho loi duoc GIU LAI, pieu loi duoc ALERT ro."""
        dead = {f"S{i}" for i in range(10, 20)}

        def fake(symbols, timeout=None, attempts=None):
            syms = list(symbols)
            if any(s in dead for s in syms):
                raise ConnectionResetError("chunk chet vin")
            return {s: {"close": 1, "foreign_buy_value": 1,
                        "foreign_sell_value": 1} for s in syms}
        with mock.patch.object(df, "kbs_price_board", fake), \
                mock.patch.object(df, "vci_symbols", return_value={}), \
                mock.patch("builtins.print") as pr:
            out = rt._board_kbs([f"S{i}" for i in range(50)])
        self.assertEqual(len(out), 40, "40/50 = 80% van du de tra bang")
        txt = " ".join(str(c.args[0]) for c in pr.call_args_list)
        self.assertIn("ALERT con thieu 10/50 ma", txt)

class ChainIntegrityTest(unittest.TestCase):
    def test_gio_drop_vnstock_khong_doi_price_board(self):
        # Fix 06/11 KHONG duoc cham co DROP_VNSTOCK_MAINPATH.
        with mock.patch.object(rt, "DROP_VNSTOCK_MAINPATH", True):
            a = rt._chain_for("price_board")
        with mock.patch.object(rt, "DROP_VNSTOCK_MAINPATH", False):
            b = rt._chain_for("price_board")
        self.assertEqual(a, ["kbs", "vci"])
        self.assertEqual(b, ["kbs", "vci"])


class DefaultsUnchangedTest(unittest.TestCase):
    def test_mac_dinh_giu_nguyen_hanh_vi_cu(self):
        self.assertEqual(rt.KBS_BOARD_CHUNK, 10)
        self.assertEqual(rt.KBS_BOARD_RETRY_CHUNK, 5)
        self.assertEqual(df.KBS_BOARD_ATTEMPTS, 4)
        self.assertEqual(df.KBS_BOARD_IDENTITY_AFTER, 2)
        self.assertEqual(df.KBS_BOARD_TIMEOUT, 25)


if __name__ == "__main__":
    unittest.main(verbosity=2)
