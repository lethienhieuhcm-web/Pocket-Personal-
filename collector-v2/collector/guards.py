"""Recency guard 2 tang + T3 (§4.1, Q3). Chay trong consumer, TRUOC khi
su kien cham bucket/snapshot. Moi quyet dinh loai deu dem, khong vut lang.

T1 (cung): date(minute(ts)) != session_date -> REJECT.
T2 (mem): recv_ts - ts > SKEW_SEC (900s, Chot Q3) -> REPLAY-SUSPECT (quarantine).
T3 (muon cung ngay): minute(ts) < watermark(gate, sym) -> vao bucket + co restated.
"""
import datetime

ICT = datetime.timezone(datetime.timedelta(hours=7))

SKEW_SEC = 900  # Chot Q3


class GuardCounters:
    def __init__(self):
        self.accepted = 0
        self.rejected_t1 = 0
        self.quarantined_t2 = 0
        self.restated_t3 = 0
        self.by_gate = {}

    def _gate(self, gate):
        return self.by_gate.setdefault(
            gate, {"accepted": 0, "rejected_t1": 0, "quarantined_t2": 0, "restated_t3": 0})

    def record(self, gate, outcome):
        setattr(self, outcome, getattr(self, outcome) + 1)
        self._gate(gate)[outcome] += 1

    def summary(self):
        return {"accepted": self.accepted, "rejected_t1": self.rejected_t1,
                "quarantined_t2": self.quarantined_t2, "restated_t3": self.restated_t3,
                "by_gate": self.by_gate}


class RecencyGuard:
    def __init__(self, session_date, skew_sec=SKEW_SEC):
        """session_date: 'YYYY-MM-DD' (ngay giao dich, suy tu lich)."""
        self.session_date = session_date
        self.skew_sec = skew_sec
        self.watermarks = {}  # (gate, sym) -> minute epoch lon nhat da thay
        self.counters = GuardCounters()

    @staticmethod
    def _date_of_minute(minute_epoch):
        return datetime.datetime.fromtimestamp(minute_epoch, tz=ICT).date().isoformat()

    def classify(self, env):
        """Tra ve 'accept' | 'reject_t1' | 'quarantine_t2'.
        Neu 'accept' va env.restated=True thi la T3 (van vao bucket + co)."""
        minute = env.minute()
        if self._date_of_minute(minute) != self.session_date:
            self.counters.record(env.gate, "rejected_t1")
            return "reject_t1"
        if env.recv_ts - env.ts > self.skew_sec:
            self.counters.record(env.gate, "quarantined_t2")
            return "quarantine_t2"
        key = (env.gate, env.sym)
        prev = self.watermarks.get(key)
        if prev is not None and minute < prev:
            env.restated = True
            self.counters.record(env.gate, "restated_t3")
        else:
            env.restated = False
        if prev is None or minute > prev:
            self.watermarks[key] = minute
        self.counters.record(env.gate, "accepted")
        return "accept"
