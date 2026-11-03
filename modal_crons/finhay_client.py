"""Tài khoản dùng chung cho cron Python (Modal hoặc VM).

Chỉ đọc credentials từ env hoặc ~/.finhay/credentials/.env (0600).
KHÔNG in/nlog giá trị key — mask = ********.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://open-api.fhsc.com.vn"
# Đo ngày 03/11/2026: key này bị HTTP 429 sau ~35 lời gọi trong 60s (tài liệu ghi FREE=600
# weight nhưng thực tế thấp hơn nhiều) -> giữ trần 15 lời gọi/phút, cách nhau >=1.05s.
MIN_INTERVAL_S = 1.05
MAX_CALLS_PER_WINDOW = 15
WINDOW_S = 60.0


class FinhayError(RuntimeError):
    def __init__(self, message: str, permanent: bool = False, status: int | None = None, retry_after_s: float | None = None):
        super().__init__(message)
        self.permanent = permanent
        self.status = status
        self.retry_after_s = retry_after_s


def load_env_file(path: str) -> dict:
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            out[key.strip()] = val.strip().strip("\"'")
    return out


def resolve_config(env=None):
    env = env if env is not None else dict(os.environ)
    cred_file = env.get("FINHAY_CRED_FILE") or os.path.join(
        env.get("HOME", "/data/home"), ".finhay", "credentials", ".env"
    )
    file_cfg = load_env_file(cred_file)
    api_key = env.get("FINHAY_API_KEY") or file_cfg.get("FINHAY_API_KEY")
    api_secret = env.get("FINHAY_API_SECRET") or file_cfg.get("FINHAY_API_SECRET")
    base_url = env.get("FINHAY_BASE_URL") or file_cfg.get("FINHAY_BASE_URL") or DEFAULT_BASE_URL
    if not api_key or not api_secret:
        raise FinhayError(f"thiếu FINHAY_API_KEY / FINHAY_API_SECRET (env hoặc {cred_file})", permanent=True)
    return api_key, api_secret, base_url


class FinhayClient:
    def __init__(self, timeout_s: float = 30.0, min_interval_s: float = MIN_INTERVAL_S,
                 max_per_window: int = MAX_CALLS_PER_WINDOW, max_attempts: int = 3, logger=None):
        self.api_key, self.api_secret, self.base_url = resolve_config()
        self.timeout_s = timeout_s
        self.min_interval_s = min_interval_s
        self.max_per_window = max_per_window
        self.max_attempts = max_attempts
        self.logger = logger or (lambda msg: None)
        self._next_slot = 0.0
        self._stamps: list[float] = []
        self.calls = 0

    def _sign(self, method: str, request_path: str, timestamp: str) -> str:
        payload = f"{timestamp}\n{method}\n{request_path}\n".encode("utf-8")
        return hmac.new(self.api_secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()

    def _throttle(self) -> None:
        now = time.time()
        wait = self._next_slot - now
        if wait > 0:
            time.sleep(wait)
        self._next_slot = max(now, self._next_slot) + self.min_interval_s
        cutoff = time.time() - WINDOW_S
        self._stamps = [t for t in self._stamps if t > cutoff]
        if len(self._stamps) >= self.max_per_window:
            sleep_for = self._stamps[0] + WINDOW_S - time.time() + 0.05
            self.logger(f"[finhay] window cap {self.max_per_window}/60s -> sleep {sleep_for:.1f}s")
            if sleep_for > 0:
                time.sleep(sleep_for)
            self._stamps = [t for t in self._stamps if t > time.time() - WINDOW_S]
        self._stamps.append(time.time())

    def get(self, request_path: str, query: str | None = None) -> dict:
        for attempt in range(1, self.max_attempts + 1):
            try:
                return self._get_once(request_path, query)
            except FinhayError as err:
                if err.permanent or attempt == self.max_attempts:
                    raise
                backoff = 1.0 * attempt
                if err.status == 429:
                    backoff = min(err.retry_after_s or 60.0, 65.0)
                self.logger(f"[finhay] {err} -> thử lại sau {backoff:.0f}s")
                time.sleep(backoff)
        raise FinhayError(f"finhay failed {request_path}")

    def _get_once(self, request_path: str, query: str | None) -> dict:
        self._throttle()
        url = self.base_url + request_path + (f"?{query}" if query else "")
        timestamp = str(int(time.time() * 1000))
        req = urllib.request.Request(url, method="GET", headers={
            "X-FH-APIKEY": self.api_key,
            "X-FH-TIMESTAMP": timestamp,
            "X-FH-NONCE": os.urandom(16).hex(),
            "X-FH-SIGNATURE": self._sign("GET", request_path, timestamp),
            "User-Agent": "finhay-integration/1.0.0",
            "Accept": "application/json",
        })
        self.calls += 1
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                body = resp.read().decode("utf-8")
                status = resp.status
        except urllib.error.HTTPError as err:  # 4xx/5xx
            body = err.read().decode("utf-8", "replace")
            status = err.code
            retry_hdr = err.headers.get("Retry-After")
            if status == 429:
                raise FinhayError(f"http 429 {request_path}", permanent=False,
                                  status=429, retry_after_s=float(retry_hdr) if (retry_hdr or "").isdigit() else 60.0) from None
            permanent = status in (400, 401, 403, 404)
            raise FinhayError(f"http {status} {request_path}: {_mask(body, self.api_key, self.api_secret)[:160]}",
                              permanent=permanent, status=status) from None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise FinhayError(f"network {request_path}: {err}", permanent=False) from err
        try:
            doc = json.loads(body)
        except ValueError as err:
            raise FinhayError(f"json hỏng {request_path} http {status}", permanent=True) from err
        if status >= 400 or (doc.get("error_code") not in (None, "0", 0)):
            raise FinhayError(
                f"finhay http {status} {request_path} error_code={doc.get('error_code')} msg={_mask(str(doc.get('message')), self.api_key, self.api_secret)[:160]}",
                permanent=status in (400, 401, 404),
            )
        payload = doc["data"] if "data" in doc else doc.get("result")
        return {"body": doc, "data": payload, "took_ms": int((time.time() - started) * 1000), "bytes": len(body)}



def _mask(text: str, api_key: str, api_secret: str) -> str:
    return text.replace(api_key, "********").replace(api_secret, "********")
