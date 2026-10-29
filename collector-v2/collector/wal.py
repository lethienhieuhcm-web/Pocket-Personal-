"""WAL writer (§6 dac ta): gate task append envelope da parse ra file JSONL
theo cong, fsync theo batch NHO, TRUOC khi queue.put.

Quy tac Q6: crash chi mat toi da batch chua fsync (100 event hoac 1s).
Writer nay chi duoc goi tu gate task (1 thread/cong); moi cong 1 file.
"""
import json
import os
import threading
import time

BATCH_MAX = 100
BATCH_MAX_AGE_SEC = 1.0


class WalWriter:
    def __init__(self, path, batch_max=BATCH_MAX, batch_max_age=BATCH_MAX_AGE_SEC,
                 time_fn=time.monotonic):
        self.path = path
        self.batch_max = batch_max
        self.batch_max_age = batch_max_age
        self._time_fn = time_fn
        self._lock = threading.Lock()
        self._buf = []
        self._last_flush = self._time_fn()
        self._f = open(path, "a", encoding="utf-8")
        self.written = 0  # so dong da fsync
        self.buffered = 0  # so dong dang cho fsync

    def append(self, env_dict):
        """Buffer 1 envelope (dict). KHONG fsync ngay — goi flush_if_due sau."""
        line = json.dumps(env_dict, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self._buf.append(line)
            self.buffered += 1

    def flush_if_due(self):
        with self._lock:
            if not self._buf:
                return 0
            if (len(self._buf) >= self.batch_max
                    or self._time_fn() - self._last_flush >= self.batch_max_age):
                return self._flush_locked()
            return 0

    def flush(self):
        with self._lock:
            return self._flush_locked()

    def _flush_locked(self):
        if not self._buf:
            return 0
        for line in self._buf:
            self._f.write(line + "\n")
        self._f.flush()
        os.fsync(self._f.fileno())
        n = len(self._buf)
        self.written += n
        self.buffered = 0
        self._buf = []
        self._last_flush = self._time_fn()
        return n

    def close(self):
        with self._lock:
            self._flush_locked()
            self._f.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def read_wal(path, after_seq=None):
    """Doc file WAL -> list envelope dict, giu nguyen thu tu.
    after_seq: {gate: last_seq} — chi lay record co seq > last_seq cua cong do."""
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if after_seq is not None:
                last = after_seq.get(d.get("gate"), -1)
                if d.get("seq", 0) <= last:
                    continue
            out.append(d)
    return out
