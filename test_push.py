#!/usr/bin/env python3
"""Tests for live_push.py (R2 + D1 STAGING live push).

Stub-only: R2 and D1 are local HTTP servers on 127.0.0.1 capturing
requests. No external network, no real credentials (fake values only),
no production targets. Run:
    python3 test_push.py
Exit code 0 = all cases pass.
"""

import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import collector as C  # noqa: E402
import live_push as LP  # noqa: E402

RESULTS = []

FAKE_R2_KEY = "FAKE-R2-ACCESS-KEY-1234"
FAKE_R2_SECRET = "FAKE-R2-SECRET-5678"
FAKE_D1_TOKEN = "FAKE-D1-TOKEN-9abc"
FAKES = (FAKE_R2_KEY, FAKE_R2_SECRET, FAKE_D1_TOKEN)


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}"
          + (f" -- {detail}" if detail and not cond else ""), flush=True)


class CaptureServer:
    """Threading HTTP server recording every request."""

    def __init__(self, handler_cls):
        self.requests = []
        self.lock = threading.Lock()
        self.fail_first = 0
        self._handler_cls = handler_cls
        handler_cls.server_ref = self
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        return False

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.port

    def record(self, method, path, headers, body):
        with self.lock:
            n = len(self.requests)
            self.requests.append({"method": method, "path": path,
                                  "headers": dict(headers), "body": body})
            return n

    def should_fail(self):
        with self.lock:
            return len(self.requests) < self.fail_first


def _make_handler(kind):
    class Handler(BaseHTTPRequestHandler):
        server_ref = None

        def log_message(self, *args):
            pass

        def _handle(self, method):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            n = self.server_ref.record(method, self.path,
                                       self.headers, body)
            if n < self.server_ref.fail_first:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"success": false}')
                return
            if kind == "r2":
                self.send_response(200)
                self.send_header("ETag", '"stub-etag"')
                self.end_headers()
            else:
                payload = json.dumps(
                    {"success": True, "result": [], "errors": [],
                     "messages": []}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        def do_PUT(self):
            self._handle("PUT")

        def do_POST(self):
            self._handle("POST")

        def do_GET(self):
            self._handle("GET")

    return Handler


def make_env(r2_url, d1_url, extra=None):
    env = {
        "LIVE_PUSH_ENABLED": "1",
        "R2_ENDPOINT": r2_url,
        "R2_BUCKET": "test-bucket",
        "R2_PREFIX": "instabox-live",
        "R2_ACCESS_KEY_ID": FAKE_R2_KEY,
        "R2_SECRET_ACCESS_KEY": FAKE_R2_SECRET,
        "D1_API_BASE": d1_url,
        "D1_ACCOUNT_ID": "test-acct",
        "D1_DATABASE_ID": "staging-db-uuid",
        "D1_API_TOKEN": FAKE_D1_TOKEN,
    }
    if extra:
        env.update(extra)
    return env


def candle_row(sym, minute, close=21.5, vol=100):
    return (sym, minute, 21.0, 22.0, 20.5, close, vol, "dnse",
            "20261028")


def test_disabled_noop():
    with CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        env = make_env(r2.url, d1.url)
        del env["LIVE_PUSH_ENABLED"]
        pusher = LP.LivePusher(env=env)
        stats = pusher.push_cycle("/nonexistent", "20261028",
                                  [candle_row("VCB", "2026-10-28T09:05")])
        check("disabled: no network, no raise",
              len(r2.requests) == 0 and len(d1.requests) == 0
              and stats["d1_rows"] == 0)
        # Enabled but nothing configured: also a no-op, no raise.
        pusher2 = LP.LivePusher(env={"LIVE_PUSH_ENABLED": "1"})
        stats2 = pusher2.push_cycle("/nonexistent", "20261028",
                                    [candle_row("VCB",
                                                "2026-10-28T09:05")])
        check("unconfigured: no network, no raise",
              len(r2.requests) == 0 and len(d1.requests) == 0
              and stats2["d1_rows"] == 0)


def test_env_file():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "push.env")
        with open(path, "w") as fh:
            fh.write("R2_ENDPOINT=http://127.0.0.1:9\n")
            fh.write("R2_ACCESS_KEY_ID='%s'\n" % FAKE_R2_KEY)
            fh.write("# comment\n\n")
            fh.write("D1_API_TOKEN=%s\n" % FAKE_D1_TOKEN)
        os.chmod(path, 0o600)
        pusher = LP.LivePusher(env={"LIVE_PUSH_ENABLED": "1",
                                    "LIVE_PUSH_ENV_FILE": path})
        check("env file 0600: values loaded",
              pusher.r2_endpoint == "http://127.0.0.1:9"
              and pusher.r2_key == FAKE_R2_KEY
              and pusher.d1_token == FAKE_D1_TOKEN)
        os.chmod(path, 0o644)
        pusher2 = LP.LivePusher(env={"LIVE_PUSH_ENABLED": "1",
                                     "LIVE_PUSH_ENV_FILE": path})
        check("env file 0644: refused",
              pusher2.r2_endpoint == "" and pusher2.r2_key == "")


def test_r2_upload_change_detection():
    with tempfile.TemporaryDirectory() as tmpdir, \
            CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        outdir = os.path.join(tmpdir, "20261028")
        os.makedirs(outdir)
        with open(os.path.join(outdir, "raw_dnse.jsonl"), "w") as fh:
            fh.write('{"kind":"match"}\n')
        with open(os.path.join(outdir, "checkpoint.json"), "w") as fh:
            fh.write('{"flush_count":1}')
        pusher = LP.LivePusher(env=make_env(r2.url, d1.url))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            stats = pusher.push_cycle(outdir, "20261028", [])
        puts = [r for r in r2.requests if r["method"] == "PUT"]
        check("r2: uploads new files",
              len(puts) == 2 and len(stats["r2_uploaded"]) == 2,
              str(stats))
        check("r2: key prefix + session date",
              all(r["path"].startswith(
                  "/test-bucket/instabox-live/20261028/") for r in puts),
              str([r["path"] for r in puts]))
        check("r2: auth header present, secret not in headers",
              all("Authorization" in r["headers"] for r in puts)
              and not any(FAKE_R2_SECRET in str(r["headers"])
                          for r in puts))
        with contextlib.redirect_stdout(buf):
            pusher.push_cycle(outdir, "20261028", [])
        check("r2: unchanged files not re-uploaded",
              len([r for r in r2.requests if r["method"] == "PUT"]) == 2)
        with open(os.path.join(outdir, "raw_dnse.jsonl"), "a") as fh:
            fh.write('{"kind":"match"}\n')
        with contextlib.redirect_stdout(buf):
            pusher.push_cycle(outdir, "20261028", [])
        puts = [r for r in r2.requests if r["method"] == "PUT"]
        check("r2: changed file re-uploaded, other skipped",
              len(puts) == 3
              and puts[-1]["path"].endswith("raw_dnse.jsonl"))
        out = buf.getvalue()
        check("r2: no credential in stdout",
              not any(fake in out for fake in FAKES))


def test_r2_failure_retry_next_cycle():
    with tempfile.TemporaryDirectory() as tmpdir, \
            CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        r2.fail_first = 1
        outdir = os.path.join(tmpdir, "20261028")
        os.makedirs(outdir)
        with open(os.path.join(outdir, "summary.json"), "w") as fh:
            fh.write('{"matches_total": 3}')
        pusher = LP.LivePusher(env=make_env(r2.url, d1.url))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            stats = pusher.push_cycle(outdir, "20261028", [])
        check("r2 fail: reported failed, no raise",
              stats["r2_failed"] == ["summary.json"]
              and stats["r2_uploaded"] == [])
        with contextlib.redirect_stdout(buf):
            stats = pusher.push_cycle(outdir, "20261028", [])
        check("r2 fail: retried next cycle and uploaded",
              stats["r2_uploaded"] == ["summary.json"])
        check("r2 fail: exactly 2 attempts total",
              len([r for r in r2.requests if r["method"] == "PUT"]) == 2)


def test_d1_create_table_once_and_batching():
    with CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        pusher = LP.LivePusher(env=make_env(r2.url, d1.url))
        rows = [candle_row("S%03d" % i, "2026-10-28T09:05")
                for i in range(1200)]
        buf = io.StringIO()
        with tempfile.TemporaryDirectory() as tmpdir:
            with contextlib.redirect_stdout(buf):
                stats = pusher.push_cycle(tmpdir, "20261028", rows)
            with contextlib.redirect_stdout(buf):
                pusher.push_cycle(tmpdir, "20261028", [])
        bodies = [json.loads(r["body"]) for r in d1.requests]
        creates = [b for b in bodies
                   if "CREATE TABLE" in b["sql"]]
        inserts = [b for b in bodies
                   if b["sql"].startswith("INSERT OR REPLACE")]
        check("d1: CREATE TABLE issued once",
              len(creates) == 1, str(len(creates)))
        check("d1: 1200 rows split 500/500/200",
              len(inserts) == 3
              and [len(b["params"]) // 9 for b in inserts] == [500, 500, 200],
              str([len(b["params"]) for b in inserts]))
        check("d1: column list matches README schema",
              all("symbol,minute,open,high,low,close,volume,source,"
                  "session_date" in b["sql"].replace(" ", "")
                  for b in inserts))
        check("d1: stats report rows sent",
              stats["d1_rows"] == 1200 and not stats["d1_failed"])
        check("d1: bearer auth used, token not in body",
              all(r["headers"].get("Authorization", "").startswith(
                  "Bearer ") for r in d1.requests)
              and not any(FAKE_D1_TOKEN in r["body"].decode()
                          for r in d1.requests))


def test_d1_retry_backoff():
    with CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        d1.fail_first = 2
        sleeps = []
        pusher = LP.LivePusher(env=make_env(r2.url, d1.url),
                               sleeper=sleeps.append)
        buf = io.StringIO()
        with tempfile.TemporaryDirectory() as tmpdir:
            with contextlib.redirect_stdout(buf):
                stats = pusher.push_cycle(
                    tmpdir, "20261028",
                    [candle_row("VCB", "2026-10-28T09:05")])
        check("d1 retry: backoff delays 1s, 2s",
              sleeps == [1.0, 2.0], str(sleeps))
        check("d1 retry: delivered after 2 failures",
              stats["d1_rows"] == 1 and not stats["d1_failed"])
        check("d1 retry: 4 requests (3 schema attempts + insert)",
              len(d1.requests) == 4, str(len(d1.requests)))


def test_d1_failure_keeps_pending():
    with CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        d1.fail_first = 100  # always fail this round
        pusher = LP.LivePusher(env=make_env(r2.url, d1.url),
                               sleeper=lambda s: None,
                               retry_delays=(0, 0))
        rows = [candle_row("VCB", "2026-10-28T09:05"),
                candle_row("FPT", "2026-10-28T09:05")]
        buf = io.StringIO()
        with tempfile.TemporaryDirectory() as tmpdir:
            with contextlib.redirect_stdout(buf):
                stats = pusher.push_cycle(tmpdir, "20261028", rows)
        check("d1 fail: reported failed, no raise",
              stats["d1_failed"] and stats["d1_rows"] == 0)
        check("d1 fail: rows stay queued",
              len(pusher._pending_d1) == 2)
        d1.fail_first = 0
        with tempfile.TemporaryDirectory() as tmpdir:
            with contextlib.redirect_stdout(buf):
                stats = pusher.push_cycle(tmpdir, "20261028", [])
        inserts = [json.loads(r["body"]) for r in d1.requests
                   if json.loads(r["body"])["sql"].startswith("INSERT")]
        check("d1 fail: queued rows delivered next cycle, once",
              stats["d1_rows"] == 2 and len(inserts) == 1
              and len(inserts[0]["params"]) == 18,
              str([len(b["params"]) for b in inserts]))


def test_push_dedupe():
    with CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        pusher = LP.LivePusher(env=make_env(r2.url, d1.url))
        rows = [candle_row("VCB", "2026-10-28T09:05", close=21.5),
                candle_row("VCB", "2026-10-28T09:05", close=21.9)]
        buf = io.StringIO()
        with tempfile.TemporaryDirectory() as tmpdir:
            with contextlib.redirect_stdout(buf):
                pusher.push_cycle(tmpdir, "20261028", rows)
        inserts = [json.loads(r["body"]) for r in d1.requests
                   if json.loads(r["body"])["sql"].startswith("INSERT")]
        check("dedupe: same minute sent once, last wins",
              len(inserts) == 1 and len(inserts[0]["params"]) == 9
              and inserts[0]["params"][5] == 21.9,
              str(inserts[0]["params"] if inserts else None))


def test_credentials_never_logged():
    with tempfile.TemporaryDirectory() as tmpdir, \
            CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        r2.fail_first = 100
        d1.fail_first = 100
        outdir = os.path.join(tmpdir, "20261028")
        os.makedirs(outdir)
        with open(os.path.join(outdir, "summary.json"), "w") as fh:
            fh.write('{"x": 1}')
        pusher = LP.LivePusher(env=make_env(r2.url, d1.url),
                               sleeper=lambda s: None,
                               retry_delays=(0, 0))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            pusher.push_cycle(outdir, "20261028",
                              [candle_row("VCB", "2026-10-28T09:05")])
        out = buf.getvalue()
        check("secrets: never in stdout, even on failure",
              not any(fake in out for fake in FAKES), out[:200])
        leaked = False
        for root, _, files in os.walk(tmpdir):
            for name in files:
                with open(os.path.join(root, name), "rb") as fh:
                    blob = fh.read().decode("utf-8", "replace")
                if any(fake in blob for fake in FAKES):
                    leaked = True
        check("secrets: never in files written", not leaked)


def test_collector_hook_flush():
    with tempfile.TemporaryDirectory() as tmpdir, \
            CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        pusher = LP.LivePusher(env=make_env(r2.url, d1.url))
        core = C.Core(tmpdir, "20261028", {}, live_push=pusher)
        base = 1793153100  # 2026-10-28 09:05 ICT
        core.apply_match("dnse", "VCB", base + 10, 21.5, 100, 1,
                         time.time())
        core.apply_match("dnse", "VCB", base + 20, 21.8, 50, 2,
                         time.time())
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            core.flush()
        deadline = time.time() + 5
        while time.time() < deadline:
            if d1.requests and r2.requests:
                break
            time.sleep(0.05)
        inserts = [json.loads(r["body"]) for r in d1.requests
                   if json.loads(r["body"])["sql"].startswith("INSERT")]
        check("hook: flush pushes candle to D1 stub",
              len(inserts) == 1 and inserts[0]["params"][0] == "VCB")
        check("hook: flush uploads files to R2 stub",
              any(r["path"].endswith("checkpoint.json")
                  for r in r2.requests))
        import sqlite3
        con = sqlite3.connect(os.path.join(tmpdir, "session.db"))
        n = con.execute("SELECT COUNT(*) FROM candles").fetchone()[0]
        con.close()
        check("hook: local SQLite still written", n >= 1, str(n))
        check("hook: no credential in flush output",
              not any(fake in buf.getvalue() for fake in FAKES))
        core.db.close()


async def test_run_session_push_failure_no_crash():
    with CaptureServer(_make_handler("r2")) as r2, \
            CaptureServer(_make_handler("d1")) as d1:
        # Dead endpoints: connection refused, instantly.
        env = make_env("http://127.0.0.1:1", "http://127.0.0.1:1")
        pusher = LP.LivePusher(env=env, sleeper=lambda s: None,
                               retry_delays=(0, 0))
        universe = [{"symbol": "VCB", "exchange": "HOSE"}]
        buf = io.StringIO()
        with tempfile.TemporaryDirectory() as tmpdir:
            with contextlib.redirect_stdout(buf):
                summary = await C.run_session(
                    universe, tmpdir, endpoints={
                        g: "ws://127.0.0.1:1/" for g in C.GATES},
                    minutes=0.02, live_push=pusher,
                    ssi_config_resolver=lambda: ("test",
                                                  "wss://unused.invalid/mqtt",
                                                  "u", "p"),
                    vnd_key_resolver=lambda: "")
            check("e2e fail: session completes, summary written",
                  isinstance(summary, dict)
                  and os.path.exists(
                      os.path.join(tmpdir, summary["session_date"],
                                   "summary.json")))
            check("e2e fail: local db written",
                  os.path.exists(os.path.join(
                      tmpdir, summary["session_date"], "session.db")))
        out = buf.getvalue()
        check("e2e fail: no credential in output",
              not any(fake in out for fake in FAKES))


async def main():
    test_disabled_noop()
    test_env_file()
    test_r2_upload_change_detection()
    test_r2_failure_retry_next_cycle()
    test_d1_create_table_once_and_batching()
    test_d1_retry_backoff()
    test_d1_failure_keeps_pending()
    test_push_dedupe()
    test_credentials_never_logged()
    test_collector_hook_flush()
    await test_run_session_push_failure_no_crash()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} PASS")
    if failed:
        for name, _, detail in failed:
            print(f"FAILED: {name} {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
