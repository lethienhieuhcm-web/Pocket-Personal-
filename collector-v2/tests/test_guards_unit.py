import datetime
import unittest

from collector.envelope import Envelope
from collector.guards import RecencyGuard

ICT = datetime.timezone(datetime.timedelta(hours=7))


def epoch(y, mo, d, h, mi, s=0):
    return datetime.datetime(y, mo, d, h, mi, s, tzinfo=ICT).timestamp()


class TestGuards(unittest.TestCase):
    def setUp(self):
        self.guard = RecencyGuard("2026-10-28")

    def _env(self, gate, sym, ts, recv_ts):
        return Envelope(gate=gate, kind="match", sym=sym, ts=ts, recv_ts=recv_ts)

    def test_t1_rejects_old_date(self):
        env = self._env("dnse", "ACB", epoch(2026, 10, 27, 10, 0), epoch(2026, 10, 28, 14, 35))
        self.assertEqual(self.guard.classify(env), "reject_t1")
        self.assertEqual(self.guard.counters.rejected_t1, 1)

    def test_t1_boundary_midnight(self):
        # 28/10 00:00 ICT: cung ngay -> khong reject.
        env = self._env("dnse", "ACB", epoch(2026, 10, 28, 0, 0), epoch(2026, 10, 28, 0, 1))
        self.assertEqual(self.guard.classify(env), "accept")
        # 27/10 23:59 ICT: khac ngay -> reject.
        env2 = self._env("dnse", "ACB", epoch(2026, 10, 27, 23, 59), epoch(2026, 10, 28, 0, 1))
        self.assertEqual(self.guard.classify(env2), "reject_t1")

    def test_t2_quarantines_late_replay(self):
        env = self._env("dnse", "ACB", epoch(2026, 10, 28, 10, 0), epoch(2026, 10, 28, 10, 20))
        self.assertEqual(self.guard.classify(env), "quarantine_t2")
        self.assertEqual(self.guard.counters.quarantined_t2, 1)

    def test_t2_boundary_900s(self):
        env = self._env("dnse", "ACB", epoch(2026, 10, 28, 10, 0), epoch(2026, 10, 28, 10, 15))
        self.assertEqual(self.guard.classify(env), "accept")
        env2 = self._env("dnse", "ACB", epoch(2026, 10, 28, 10, 0), epoch(2026, 10, 28, 10, 15, 1))
        self.assertEqual(self.guard.classify(env2), "quarantine_t2")

    def test_t3_restated_same_day_late_minute(self):
        env1 = self._env("dnse", "ACB", epoch(2026, 10, 28, 10, 0), epoch(2026, 10, 28, 10, 0))
        self.assertEqual(self.guard.classify(env1), "accept")
        self.assertFalse(env1.restated)
        env2 = self._env("dnse", "ACB", epoch(2026, 10, 28, 9, 59), epoch(2026, 10, 28, 10, 1))
        self.assertEqual(self.guard.classify(env2), "accept")
        self.assertTrue(env2.restated)
        self.assertEqual(self.guard.counters.restated_t3, 1)

    def test_watermark_is_per_gate_sym(self):
        env1 = self._env("dnse", "ACB", epoch(2026, 10, 28, 10, 0), epoch(2026, 10, 28, 10, 0))
        self.guard.classify(env1)
        env2 = self._env("dnse", "VCB", epoch(2026, 10, 28, 9, 59), epoch(2026, 10, 28, 10, 0))
        self.assertEqual(self.guard.classify(env2), "accept")
        self.assertFalse(env2.restated)

    def test_synthetic_snapshot_never_t2(self):
        env = Envelope(gate="kbs", kind="snapshot", sym="DGW",
                       ts=epoch(2026, 10, 28, 14, 35), recv_ts=epoch(2026, 10, 28, 14, 35),
                       ts_synthetic=True)
        self.assertEqual(self.guard.classify(env), "accept")


if __name__ == "__main__":
    unittest.main()
