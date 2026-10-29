"""Consumer duy nhat (§3, §4, §5 dac ta): 1 task/thread cham state.

Nhan envelope tu shared queue -> guard T1/T2/T3 -> dedup -> buckets 7 phan
tu [o,h,l,c,v,fts,lts] / snapshots / preopen -> flush SQLite + checkpoint +
quarantine moi FLUSH_SEC.

GHI CHU T0: guard nhay gia do quyen (§4.1 bo sung Q6) CHUA lam o day vi can
2 dau vao consumer hien chua co: file lich quyen + floor/ceiling/prev_close
tu board. Diem moc: Consumer.process() — khi session cap rights context thi
them mien tru T0 truoc classify() ma khong doi cac tang con lai.
"""
import json
import os
import queue
import threading
import time

from .envelope import Envelope
from .guards import RecencyGuard
from .store import SessionStore

FLUSH_SEC = 30
QUEUE_MAX = 50000


class ConsumerCounters:
    def __init__(self):
        self.msgs = 0
        self.matches = 0
        self.snapshots = 0
        self.ignored_kind = 0
        self.dup_dropped = 0
        self.acc_regressed = 0
        self.acc_resets = 0
        self.preopen_segments = 0
        self.restatements = 0
        self.by_gate = {}

    def _gate(self, gate):
        return self.by_gate.setdefault(
            gate, {"msgs": 0, "matches": 0, "dup_dropped": 0})

    def summary(self):
        return {"msgs": self.msgs, "matches": self.matches,
                "snapshots": self.snapshots, "ignored_kind": self.ignored_kind,
                "dup_dropped": self.dup_dropped,
                "acc_regressed": self.acc_regressed,
                "acc_resets": self.acc_resets,
                "preopen_segments": self.preopen_segments,
                "restatements": self.restatements, "by_gate": self.by_gate}


class Consumer:
    def __init__(self, session_date, store, out_dir, fieldmap_data=None,
                 flush_sec=FLUSH_SEC, time_fn=time.time,
                 monotonic_fn=time.monotonic):
        self.session_date = session_date
        self.store = store
        self.out_dir = out_dir
        self.fieldmap_data = fieldmap_data
        self.flush_sec = flush_sec
        self._time = time_fn
        self._mono = monotonic_fn
        self.guard = RecencyGuard(session_date)
        self.counters = ConsumerCounters()
        self.buckets = {}       # (gate, sym, minute) -> [o,h,l,c,v,fts,lts,restated]
        self.snapshots = {}     # (gate, sym) -> (as_of, fields, field_src)
        self._acc_seen = set()  # (gate, sym, acc)
        self._tick_seen = set()  # (gate, sym, minute, price, vol, ts)
        self._last_acc = {}     # (gate, sym) -> last acc
        self._max_acc = {}      # (gate, sym) -> max acc
        self._preopen = {}      # (gate, sym, segment) -> [first_acc, first_recv_ts, first_ts, resets]
        self._seg = {}          # (gate, sym) -> current segment
        self._flushed_keys = set()
        self._quarantine_buf = []
        self._gaps_buf = []
        self._last_seq = {}
        self.flush_count = 0
        self._last_flush_mono = self._mono()

    # -- nap lai (resume) --
    def load_state(self):
        self.buckets = {k: list(v) for k, v in self.store.load_buckets().items()}
        self.snapshots = dict(self.store.load_snapshots())
        for (g, s, kind, key) in self.store.load_dedup_keys():
            if kind == "acc":
                self._acc_seen.add((g, s, float(key)))
            else:
                parts = key.split("|")
                self._tick_seen.add((g, s, int(parts[0]), float(parts[1]),
                                     float(parts[2]), float(parts[3])))
        for (g, s, seg), (fa, frt, ft, r) in self.store.load_preopen().items():
            self._preopen[(g, s, seg)] = [fa, frt, ft, r]
            self._seg[(g, s)] = max(seg, self._seg.get((g, s), 0))
        self._flushed_keys = set(self.buckets.keys())

    # -- xu ly 1 envelope (dung ca trong vong loop lan replay resume) --
    def process(self, env):
        self.counters.msgs += 1
        self.counters._gate(env.gate)["msgs"] += 1
        if env.seq:
            self._last_seq[env.gate] = max(env.seq, self._last_seq.get(env.gate, 0))
        outcome = self.guard.classify(env)
        if outcome != "accept":
            self._quarantine_buf.append({"outcome": outcome, "env": env.to_dict()})
            return outcome
        if env.kind == "match":
            return self._apply_match(env)
        if env.kind == "snapshot":
            self.counters.snapshots += 1
            self.snapshots[(env.gate, env.sym)] = (env.recv_ts, env.fields, env.field_src)
            return "accept"
        self.counters.ignored_kind += 1
        return "accept"

    def _apply_match(self, env):
        self.counters.matches += 1
        self.counters._gate(env.gate)["matches"] += 1
        key = (env.gate, env.sym)
        acc = env.acc
        use_fallback = acc is None
        if acc is not None:
            last = self._last_acc.get(key)
            if last is not None and acc < last:
                # acc regressed: KHONG dung acc de loai tick, chi dem (§4.2).
                self.counters.acc_regressed += 1
                use_fallback = True
            elif (env.gate, env.sym, acc) in self._acc_seen:
                self.counters.dup_dropped += 1
                self.counters._gate(env.gate)["dup_dropped"] += 1
                return "dup_dropped"
            else:
                self._acc_seen.add((env.gate, env.sym, acc))
            if last is None or acc > last:
                self._last_acc[key] = acc
            prev_max = self._max_acc.get(key)
            if prev_max is not None and acc < prev_max * 0.5:
                # acc reset giua phien (§5): dong doan cu, mo doan moi + gap log.
                self._seg[key] = self._seg.get(key, 0) + 1
                self.counters.acc_resets += 1
                self._gaps_buf.append({"gate": env.gate, "down_ts": env.recv_ts,
                                       "up_ts": env.recv_ts, "seconds": 0.0,
                                       "error": "acc_reset"})
            if prev_max is None or acc > prev_max:
                self._max_acc[key] = acc
        if use_fallback:
            tkey = (env.gate, env.sym, env.minute(), env.price, env.vol, env.ts)
            if tkey in self._tick_seen:
                self.counters.dup_dropped += 1
                self.counters._gate(env.gate)["dup_dropped"] += 1
                return "dup_dropped"
            self._tick_seen.add(tkey)
        # Preopen: acc cua match dau tien moi (gate, sym, segment) (§5).
        if acc is not None:
            seg = self._seg.get(key, 0)
            if (env.gate, env.sym, seg) not in self._preopen:
                self._preopen[(env.gate, env.sym, seg)] = [
                    acc, env.recv_ts, env.ts, self.counters.acc_resets]
                self.counters.preopen_segments += 1
        # Bucket 7 phan tu [o,h,l,c,v,fts,lts].
        bkey = (env.gate, env.sym, env.minute())
        b = self.buckets.get(bkey)
        if b is None:
            self.buckets[bkey] = [env.price, env.price, env.price, env.price,
                                  env.vol, env.ts, env.ts,
                                  1 if env.restated else 0]
        else:
            b[1] = max(b[1], env.price)
            b[2] = min(b[2], env.price)
            b[3] = env.price
            b[4] += env.vol
            b[5] = min(b[5], env.ts)
            b[6] = max(b[6], env.ts)
            if env.restated:
                b[7] = 1
                if bkey in self._flushed_keys:
                    # Bucket da flush roi moi sua -> ghi restatement rieng (§4.1 T3).
                    self.store.add_restatement(env.gate, env.sym, env.minute(),
                                               tuple(b[:7]), self._time())
                    self.counters.restatements += 1
        return "accept"

    # -- flush --
    def flush(self):
        t0 = self._mono()
        self.store.flush_buckets({k: tuple(v) for k, v in self.buckets.items()})
        self.store.flush_snapshots(self.snapshots)
        dedup_keys = {(g, s, "acc", repr(a)) for (g, s, a) in self._acc_seen}
        dedup_keys |= {(g, s, "tick", f"{m}|{p!r}|{v!r}|{t!r}")
                       for (g, s, m, p, v, t) in self._tick_seen}
        self.store.flush_dedup(dedup_keys)
        self.store.flush_preopen({k: tuple(v) for k, v in self._preopen.items()})
        for gap in self._gaps_buf:
            self.store.add_gap(gap["gate"], gap["down_ts"], gap["up_ts"],
                               gap["seconds"], gap["error"])
        self._gaps_buf = []
        if getattr(self, "gap_queue", None) is not None:
            while True:
                try:
                    gap = self.gap_queue.get_nowait()
                except queue.Empty:
                    break
                self.store.add_gap(gap["gate"], gap["down_ts"], gap["up_ts"],
                                   gap.get("seconds"), gap.get("error"))
        self._drain_quarantine()
        self._flushed_keys = set(self.buckets.keys())
        self.flush_count += 1
        self.store.set_meta("checkpoint", {
            "session_date": self.session_date,
            "last_flush_ts": self._time(), "last_seq": dict(self._last_seq),
            "flush_count": self.flush_count,
            "db_size": os.path.getsize(self.store.db_path)})
        self._write_checkpoint()
        self._last_flush_mono = self._mono()
        return (self._mono() - t0) * 1000.0

    def _drain_quarantine(self):
        if not self._quarantine_buf:
            return
        by_gate = {}
        for item in self._quarantine_buf:
            by_gate.setdefault(item["env"]["gate"], []).append(item)
        for gate, items in by_gate.items():
            path = os.path.join(self.out_dir, f"quarantine_{gate}.jsonl")
            with open(path, "a", encoding="utf-8") as f:
                for item in items:
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")
        self._quarantine_buf = []

    def _write_checkpoint(self):
        data = {"session_date": self.session_date,
                "last_flush_ts": self._time(), "last_seq": dict(self._last_seq),
                "flush_count": self.flush_count,
                "guard": self.guard.counters.summary(),
                "counters": self.counters.summary()}
        tmp = os.path.join(self.out_dir, "checkpoint.json.tmp")
        final = os.path.join(self.out_dir, "checkpoint.json")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, final)

    def flush_due(self):
        return self._mono() - self._last_flush_mono >= self.flush_sec

    # -- vong chay cua consumer thread --
    def run(self, q, stop_event):
        while not stop_event.is_set() or not q.empty():
            try:
                env = q.get(timeout=0.5)
            except queue.Empty:
                pass
            else:
                try:
                    self.process(env)
                finally:
                    q.task_done()
            if self.flush_due():
                self.flush()
        # Drain cuoi: xu ly het queue roi flush lan cuoi.
        while True:
            try:
                env = q.get_nowait()
            except queue.Empty:
                break
            try:
                self.process(env)
            finally:
                q.task_done()
        self.flush()
