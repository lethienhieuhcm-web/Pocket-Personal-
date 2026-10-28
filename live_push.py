#!/usr/bin/env python3
"""Live push: R2 + D1 STAGING upload for the InstaBox collector trial.

Opt-in only (LIVE_PUSH_ENABLED=1). Local disk stays the source of truth:
the collector writes local files first, and this module only ever reads
what is already on disk plus the candle rows handed to it. Every push
failure is logged (credentials are never logged) and retried on a later
cycle; a push never raises into the collector and never stalls it (the
per-flush call runs on a background thread).

Targets are STAGING ONLY. Every endpoint, bucket, and database id comes
from the environment; the only baked-in defaults are staging-safe. No
production database id, URL, or target appears anywhere in this file.

Secrets come ONLY from environment variables or a 0600 env file
(LIVE_PUSH_ENV_FILE). They are never printed, logged, persisted, or
embedded in code, tests, or comments.
"""

import hashlib
import hmac
import json
import os
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# Staging-only defaults. The D1 default is the STAGING database uuid
# (english-lab-staging). There is deliberately no production default.
DEFAULT_R2_BUCKET = "english-lab-data"
DEFAULT_R2_PREFIX = "instabox-live"
DEFAULT_R2_REGION = "auto"
DEFAULT_D1_API_BASE = "https://api.cloudflare.com/client/v4"
DEFAULT_D1_DATABASE_ID = "79d8f828-cd52-418a-9f45-d5eb6556ebc8"
DEFAULT_D1_BATCH_ROWS = 500
DEFAULT_TIMEOUT = 30
MAX_PENDING_D1_ROWS = 300000

CANDLES_COLUMNS = ("symbol", "minute", "open", "high", "low", "close",
                   "volume", "source", "session_date")
CREATE_CANDLES_SQL = (
    "CREATE TABLE IF NOT EXISTS candles("
    "symbol TEXT NOT NULL, minute TEXT NOT NULL, "
    "open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, "
    "close REAL NOT NULL, volume INTEGER NOT NULL, "
    "source TEXT NOT NULL, session_date TEXT NOT NULL, "
    "PRIMARY KEY (symbol, minute))")

# File names the R2 upload scans for in the session outdir. WAL and
# journal sidecars are transient and never uploaded.
R2_FIXED_FILES = ("foreign_merged.json", "checkpoint.json", "load.jsonl",
                  "summary.json", "session.db")
R2_RAW_PREFIX = "raw_"

_SECRET_KEYS = ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
                "D1_API_TOKEN", "SSI_PROXY_URL")


def _hmac(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def sigv4_headers(access_key, secret_key, region, method, url, body,
                  now=None):
    """AWS Signature Version 4 headers for an S3-compatible PUT/GET.

    Pure stdlib. Returns only the auth headers; the caller must not log
    the returned Authorization value."""
    now = now or datetime.now(timezone.utc)
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc
    canonical_uri = urllib.parse.quote(parsed.path or "/", safe="/~")
    qs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    canonical_qs = "&".join(
        "%s=%s" % (urllib.parse.quote(k, safe="~"),
                   urllib.parse.quote(v, safe="~"))
        for k, v in sorted(qs))
    body_hash = hashlib.sha256(body).hexdigest()
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    headers = {"host": host, "x-amz-content-sha256": body_hash,
               "x-amz-date": amz_date}
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_headers = "".join(
        "%s:%s\n" % (k, v) for k, v in sorted(headers.items()))
    canonical_request = "\n".join(
        [method, canonical_uri, canonical_qs, canonical_headers,
         signed_headers, body_hash])
    scope = "%s/%s/s3/aws4_request" % (date_stamp, region)
    string_to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", amz_date, scope,
         hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()])
    k_date = _hmac(("AWS4" + secret_key).encode("utf-8"), date_stamp)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, "s3")
    k_signing = _hmac(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"),
                         hashlib.sha256).hexdigest()
    return {
        "Authorization":
            "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, "
            "Signature=%s" % (access_key, scope, signed_headers, signature),
        "x-amz-date": amz_date,
        "x-amz-content-sha256": body_hash,
    }


def _parse_env_file(path):
    """Parse KEY=VALUE lines. Returns {} unless the file is exactly
    mode 0600 (a lax file is refused: secrets must not sit in a
    world-readable file)."""
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        return {}
    if mode != 0o600:
        return {}
    out = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key, value = key.strip(), value.strip()
                if len(value) >= 2 and value[0] == value[-1] \
                        and value[0] in ("'", '"'):
                    value = value[1:-1]
                if key:
                    out[key] = value
    except OSError:
        return {}
    return out


class LivePusher:
    """Push session files to R2 and candle rows to D1 staging.

    Construction never touches the network. All network work happens
    in push_cycle / push_cycle_async, which never raise.
    """

    def __init__(self, env=None, sleeper=None, retry_delays=(1.0, 2.0)):
        self._sleeper = sleeper or time.sleep
        self._retry_delays = tuple(retry_delays)
        base_env = dict(os.environ if env is None else env)
        self.enabled = base_env.get("LIVE_PUSH_ENABLED", "") \
            in ("1", "true", "yes")
        self._env = base_env
        self._secrets = []
        self._uploaded = {}      # relpath -> (size, mtime_ns)
        self._pending_d1 = []    # candle row tuples, oldest first
        self._pending_lock = threading.Lock()
        self._schema_ready = False
        self._push_lock = threading.Lock()
        self._logged_no_config = False
        if not self.enabled:
            return
        env_file = base_env.get("LIVE_PUSH_ENV_FILE", "")
        if env_file:
            for key, value in _parse_env_file(env_file).items():
                self._env.setdefault(key, value)
        for key in _SECRET_KEYS:
            value = self._env.get(key, "")
            if value:
                self._secrets.append(value)
        self.r2_endpoint = self._env.get("R2_ENDPOINT", "").rstrip("/")
        self.r2_bucket = self._env.get("R2_BUCKET", DEFAULT_R2_BUCKET)
        self.r2_prefix = self._env.get("R2_PREFIX",
                                       DEFAULT_R2_PREFIX).strip("/")
        self.r2_region = self._env.get("R2_REGION", DEFAULT_R2_REGION)
        self.r2_key = self._env.get("R2_ACCESS_KEY_ID", "")
        self.r2_secret = self._env.get("R2_SECRET_ACCESS_KEY", "")
        self.d1_base = self._env.get("D1_API_BASE",
                                     DEFAULT_D1_API_BASE).rstrip("/")
        self.d1_account = self._env.get("D1_ACCOUNT_ID", "")
        self.d1_database = self._env.get("D1_DATABASE_ID",
                                         DEFAULT_D1_DATABASE_ID)
        self.d1_token = self._env.get("D1_API_TOKEN", "")
        try:
            self.d1_batch_rows = max(
                1, int(self._env.get("LIVE_PUSH_D1_BATCH_ROWS",
                                     DEFAULT_D1_BATCH_ROWS)))
        except ValueError:
            self.d1_batch_rows = DEFAULT_D1_BATCH_ROWS
        try:
            self.timeout = max(
                1, int(self._env.get("LIVE_PUSH_TIMEOUT",
                                     DEFAULT_TIMEOUT)))
        except ValueError:
            self.timeout = DEFAULT_TIMEOUT
        self.r2_configured = bool(self.r2_endpoint and self.r2_bucket
                                  and self.r2_key and self.r2_secret)
        self.d1_configured = bool(self.d1_base and self.d1_account
                                  and self.d1_database and self.d1_token)

    # ------------------------------------------------------------ utils

    def _safe(self, msg):
        """Redact every known credential value from a log string."""
        text = str(msg)
        for secret in self._secrets:
            if secret and secret in text:
                text = text.replace(secret, "***")
        return text

    def _log(self, msg):
        print("[live-push] %s" % self._safe(msg), flush=True)

    def _http(self, method, url, body=None, headers=None):
        """One HTTP request. Raises on HTTP/network error; the URL
        never carries credentials (auth travels in headers only)."""
        req = urllib.request.Request(url, data=body, method=method)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return resp.status, resp.read()

    def _with_backoff(self, label, fn):
        """Run fn() with retries on failure. Returns fn()'s value, or
        raises the last error after all attempts."""
        attempts = 1 + len(self._retry_delays)
        last_err = None
        for i in range(attempts):
            try:
                return fn()
            except Exception as e:  # noqa: BLE001 - retried, then logged
                last_err = e
                if i < len(self._retry_delays):
                    self._sleeper(self._retry_delays[i])
        raise RuntimeError("%s failed after %d attempts: %s"
                           % (label, attempts, last_err))

    # --------------------------------------------------------------- D1

    def _d1_query(self, sql, params=None):
        url = "%s/accounts/%s/d1/database/%s/query" % (
            self.d1_base, self.d1_account, self.d1_database)
        payload = json.dumps({"sql": sql,
                              "params": params or []}).encode("utf-8")
        status, raw = self._http(
            "POST", url, body=payload,
            headers={"Authorization": "Bearer %s" % self.d1_token,
                     "Content-Type": "application/json"})
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise RuntimeError("D1 bad JSON (HTTP %s)" % status)
        if not data.get("success", False):
            raise RuntimeError("D1 error: %s" % (data.get("errors"),))
        return data

    def ensure_schema(self):
        """CREATE TABLE IF NOT EXISTS, issued once per process. On
        failure the flag stays clear so the next cycle retries."""
        if self._schema_ready or not self.d1_configured:
            return self._schema_ready
        self._d1_query(CREATE_CANDLES_SQL)
        self._schema_ready = True
        return True

    def _queue_d1(self, candles):
        if not candles:
            return
        with self._pending_lock:
            self._pending_d1.extend(candles)
            if len(self._pending_d1) > MAX_PENDING_D1_ROWS:
                dropped = len(self._pending_d1) - MAX_PENDING_D1_ROWS
                del self._pending_d1[:dropped]
                self._log("d1: hang doi vuot gioi han, bo %d hang cu"
                          % dropped)

    def _take_pending(self):
        with self._pending_lock:
            rows = list(self._pending_d1)
        return rows

    def _drop_pending(self, count):
        with self._pending_lock:
            del self._pending_d1[:count]

    def _push_d1(self):
        """Drain the pending queue in chunks of <= batch rows, latest
        row per (symbol, minute) wins. Returns (rows_sent, failed).
        On failure the queued rows stay queued for the next cycle
        (INSERT OR REPLACE makes a re-send harmless)."""
        if not self.d1_configured:
            return 0, False
        queued = self._take_pending()
        if not queued:
            return 0, False
        # Dedupe: latest row per (symbol, minute) wins.
        latest = {}
        for row in queued:
            latest[(row[0], row[1])] = row
        rows = list(latest.values())
        sent_total = 0
        try:
            self._with_backoff(
                "d1 schema",
                lambda: self.ensure_schema())
            for start in range(0, len(rows), self.d1_batch_rows):
                chunk = rows[start:start + self.d1_batch_rows]
                placeholders = ",".join(
                    "(?,?,?,?,?,?,?,?,?)" for _ in chunk)
                sql = ("INSERT OR REPLACE INTO candles(%s) VALUES %s"
                       % (",".join(CANDLES_COLUMNS), placeholders))
                params = [v for row in chunk for v in row]
                self._with_backoff(
                    "d1 insert",
                    lambda sql=sql, params=params: self._d1_query(
                        sql, params))
                sent_total += len(chunk)
        except Exception as e:  # noqa: BLE001 - logged, retried later
            self._log("d1 loi: %s" % e)
            return sent_total, True
        self._drop_pending(len(queued))
        return sent_total, False

    # --------------------------------------------------------------- R2

    def _r2_candidates(self, outdir):
        try:
            names = os.listdir(outdir)
        except OSError:
            return []
        out = []
        for name in sorted(names):
            if name in R2_FIXED_FILES or name.startswith(R2_RAW_PREFIX):
                out.append(name)
        return out

    def _push_r2(self, outdir, session_date):
        """Upload new/changed files. Returns (uploaded, failed) name
        lists. One attempt per cycle; failures retry next cycle."""
        if not self.r2_configured:
            return [], []
        uploaded, failed = [], []
        for name in self._r2_candidates(outdir):
            path = os.path.join(outdir, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            sig = (st.st_size, st.st_mtime_ns)
            if self._uploaded.get(name) == sig:
                continue
            try:
                with open(path, "rb") as fh:
                    body = fh.read()
                key = "%s/%s/%s" % (self.r2_prefix, session_date, name)
                url = "%s/%s/%s" % (
                    self.r2_endpoint, self.r2_bucket,
                    urllib.parse.quote(key, safe="/~"))
                headers = sigv4_headers(
                    self.r2_key, self.r2_secret, self.r2_region,
                    "PUT", url, body)
                headers["Content-Type"] = "application/octet-stream"
                status, _ = self._http("PUT", url, body=body,
                                       headers=headers)
                if status not in (200, 201, 204):
                    raise RuntimeError("R2 HTTP %s" % status)
            except Exception as e:  # noqa: BLE001 - retried next cycle
                self._log("r2 loi %s: %s" % (name, e))
                failed.append(name)
                continue
            self._uploaded[name] = sig
            uploaded.append(name)
        return uploaded, failed

    # ------------------------------------------------------------ cycle

    def _push_once(self, outdir, session_date):
        stats = {"r2_uploaded": [], "r2_failed": [],
                 "d1_rows": 0, "d1_failed": False}
        if not self.r2_configured and not self.d1_configured:
            if not self._logged_no_config:
                self._log("bat: thieu cau hinh r2/d1, bo qua day")
                self._logged_no_config = True
            return stats
        uploaded, failed = self._push_r2(outdir, session_date)
        stats["r2_uploaded"] = uploaded
        stats["r2_failed"] = failed
        rows, d1_failed = self._push_d1()
        stats["d1_rows"] = rows
        stats["d1_failed"] = d1_failed
        if uploaded or rows:
            self._log("day: r2 %d file, d1 %d hang"
                      % (len(uploaded), rows))
        return stats

    def push_cycle(self, outdir, session_date, candles):
        """Synchronous push. Never raises. Local files are untouched;
        only already-flushed state is read."""
        if not self.enabled:
            return {"r2_uploaded": [], "r2_failed": [],
                    "d1_rows": 0, "d1_failed": False}
        self._queue_d1(candles or [])
        if not self._push_lock.acquire(timeout=60):
            self._log("bo qua: chu ky truoc chua xong")
            return {"r2_uploaded": [], "r2_failed": [],
                    "d1_rows": 0, "d1_failed": False,
                    "skipped": True}
        try:
            return self._push_once(outdir, session_date)
        except Exception as e:  # noqa: BLE001 - never break the caller
            self._log("loi chu ky day: %s" % e)
            return {"r2_uploaded": [], "r2_failed": [],
                    "d1_rows": 0, "d1_failed": True}
        finally:
            self._push_lock.release()

    def push_cycle_async(self, outdir, session_date, candles):
        """Background-thread push for the 60 s flush path: never stalls
        the collector loop. Rows are queued first, so a skipped cycle
        still retries them next cycle."""
        if not self.enabled:
            return False
        self._queue_d1(candles or [])
        if not self._push_lock.acquire(blocking=False):
            self._log("bo qua: chu ky truoc chua xong")
            return False

        def _run():
            try:
                self._push_once(outdir, session_date)
            except Exception as e:  # noqa: BLE001 - logged only
                self._log("loi chu ky day: %s" % e)
            finally:
                self._push_lock.release()

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        return True
