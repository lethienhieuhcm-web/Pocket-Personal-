"""GĐ0 gate: replay 111.900 dong raw 28/10.
T1 loai dung 488 dong cu, 0 dong 28/10 bi loai nham; T2 quarantine 391 dong
cung ngay phat lai muon (theo thiet ke Chot Q3, giu trong quarantine)."""
import datetime
import json
import os
import tempfile
import unittest

from collector.replay import replay

RAW_DIR = os.environ.get(
    "COLLECTOR_RAW_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 "fixtures", "raw-20261028"))
SESSION_DATE = "2026-10-28"
FIXTURE_FILES = ("raw_dnse.jsonl", "raw_kbs.jsonl",
                 "raw_vndirect.jsonl", "raw_vps.jsonl")

ICT = datetime.timezone(datetime.timedelta(hours=7))


def _date_ict(ts):
    return datetime.datetime.fromtimestamp(ts, tz=ICT).date().isoformat()


class TestGd0Replay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [f for f in FIXTURE_FILES
                   if not os.path.exists(os.path.join(RAW_DIR, f))]
        if missing:
            raise unittest.SkipTest(
                f"fixture GĐ0 thieu {missing} trong {RAW_DIR} — khoi phuc bang "
                "fixtures/restore_from_r2.py, khong dung vm-pull (bi ghi de moi phien)")
        cls._tmp = tempfile.TemporaryDirectory()
        cls.result = replay(RAW_DIR, SESSION_DATE, cls._tmp.name)
        with open(os.path.join(cls._tmp.name, "quarantine.jsonl"), encoding="utf-8") as f:
            cls.quarantine = [json.loads(line) for line in f if line.strip()]

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_total_lines(self):
        self.assertEqual(self.result["total"], 111900)

    def test_t1_rejects_exactly_488_old_lines(self):
        rejected = [q for q in self.quarantine if q["outcome"] == "reject_t1"]
        self.assertEqual(len(rejected), 488)
        self.assertEqual(self.result["guard"]["rejected_t1"], 488)
        for q in rejected:
            rec = q["raw"]
            self.assertEqual(rec["kind"], "match")
            self.assertNotEqual(_date_ict(rec["ts"]), SESSION_DATE)

    def test_no_2810_line_t1_rejected(self):
        # Doc lap: dem truc tiep tu file raw, khong qua guard.
        rejected_keys = {json.dumps(q["raw"], sort_keys=True) for q in self.quarantine
                         if q["outcome"] == "reject_t1"}
        for fname in FIXTURE_FILES:
            with open(os.path.join(RAW_DIR, fname), encoding="utf-8") as f:
                for line in f:
                    rec = json.loads(line)
                    if rec.get("kind") == "match" and _date_ict(rec["ts"]) == SESSION_DATE:
                        self.assertNotIn(json.dumps(rec, sort_keys=True), rejected_keys)

    def test_t2_quarantines_391_same_day_replays(self):
        t2 = [q for q in self.quarantine if q["outcome"] == "quarantine_t2"]
        self.assertEqual(len(t2), 391)
        for q in t2:
            rec = q["raw"]
            self.assertEqual(rec["kind"], "match")
            self.assertEqual(_date_ict(rec["ts"]), SESSION_DATE)
            self.assertGreater(rec["recv"] - rec["ts"], 900)

    def test_all_2810_matches_accounted(self):
        total_matches = 0
        matches_2810 = 0
        for fname in FIXTURE_FILES:
            with open(os.path.join(RAW_DIR, fname), encoding="utf-8") as f:
                for line in f:
                    rec = json.loads(line)
                    if rec.get("kind") == "match":
                        total_matches += 1
                        if _date_ict(rec["ts"]) == SESSION_DATE:
                            matches_2810 += 1
        self.assertEqual(total_matches, 27009)
        self.assertEqual(matches_2810, 26521)
        g = self.result["guard"]
        self.assertEqual(g["accepted"] + g["rejected_t1"] + g["quarantined_t2"],
                         self.result["total"])
        self.assertEqual(g["accepted"], 111900 - 488 - 391)

    def test_restated_counter_runs(self):
        self.assertGreaterEqual(self.result["guard"]["restated_t3"], 0)


if __name__ == "__main__":
    unittest.main()
