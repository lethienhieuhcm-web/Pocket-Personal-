"""Replay harness GĐ0: doc file raw vm-pull 28/10 (khong noi cong), chay qua
envelope + guard, dem dinh huong xu ly. Ghi quarantine JSONL (T1/T2) ra out/.
"""
import argparse
import json
import os

from .envelope import envelope_from_raw
from .fieldmap import load_map
from .guards import RecencyGuard

RAW_FILES = {"dnse": "raw_dnse.jsonl", "kbs": "raw_kbs.jsonl",
             "vndirect": "raw_vndirect.jsonl", "vps": "raw_vps.jsonl"}


def replay(raw_dir, session_date, out_dir=None, fieldmap_data=None):
    fieldmap_data = fieldmap_data or load_map()
    guard = RecencyGuard(session_date)
    quarantine = []
    total = 0
    for gate in ("dnse", "kbs", "vndirect", "vps"):
        path = os.path.join(raw_dir, RAW_FILES[gate])
        with open(path, encoding="utf-8") as f:
            for seq, line in enumerate(f):
                line = line.strip()
                if not line:
                    continue
                total += 1
                rec = json.loads(line)
                env = envelope_from_raw(gate, rec, seq=seq, fieldmap_data=fieldmap_data)
                outcome = guard.classify(env)
                if outcome in ("reject_t1", "quarantine_t2"):
                    quarantine.append({"gate": gate, "outcome": outcome, "raw": rec})
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "quarantine.jsonl"), "w", encoding="utf-8") as f:
            for item in quarantine:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
    return {"total": total, "guard": guard.counters.summary(),
            "quarantine_lines": len(quarantine)}


def main():
    ap = argparse.ArgumentParser(description="GĐ0 replay raw 28/10 qua guard")
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--date", required=True, help="session_date YYYY-MM-DD")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    result = replay(args.raw_dir, args.date, args.out)
    print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
