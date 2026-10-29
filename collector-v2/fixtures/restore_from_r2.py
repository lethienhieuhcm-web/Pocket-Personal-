"""Khoi phuc fixture raw 28/10 tu R2 (chi chay khi can, khong tu dong).

Nguon: bucket english-lab-data, prefix instabox-live/20261028/ (9 file,
upload 28/10/2026 16:42 ICT). Chi tai 4 file raw_*.jsonl ve thu muc fixture.
Dung surrogate credential cua custom.cloudflare (khong ghi secret ra dau).
"""
import argparse
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.expanduser("~/workspace/custom-connectors/custom.legacy-cloudflare/bin")
for p in (BIN, "/opt/muse/skills/custom-connector-setup/bin"):
    if os.path.isdir(p) and p not in sys.path:
        sys.path.insert(0, p)

import requests  # noqa: E402
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

API = "https://api.cloudflare.com/client/v4"
ACCOUNT = "25b2327e932d26e5487c2ba8ad058932"
BUCKET = "english-lab-data"
FILES = ("raw_dnse.jsonl", "raw_kbs.jsonl", "raw_vndirect.jsonl", "raw_vps.jsonl")


def main():
    ap = argparse.ArgumentParser(description="Tai fixture raw 28/10 tu R2")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--prefix", default="instabox-live/20261028")
    args = ap.parse_args()
    entry = dynamic_credential_entry("custom.cloudflare", "access_token")
    headers = {"Authorization": "Bearer " + entry["surrogate"].strip()}
    os.makedirs(args.out_dir, exist_ok=True)
    for name in FILES:
        key = f"{args.prefix}/{name}"
        url = f"{API}/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}"
        dest = os.path.join(args.out_dir, name)
        print(f"GET {key} -> {dest}")
        with requests.get(url, headers=headers, stream=True, timeout=300) as r:
            r.raise_for_status()
            total = 0
            with open(dest, "wb") as f:
                for chunk in r.iter_content(chunk_size=1 << 20):
                    if chunk:
                        f.write(chunk)
                        total += len(chunk)
        print(f"  {total} bytes")
    print("xong.")


if __name__ == "__main__":
    main()
