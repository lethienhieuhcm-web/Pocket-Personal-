"""Khoi phuc fixture raw 28/10 tu R2 (chi chay khi can, khong tu dong).

Nguon: bucket english-lab-data, prefix instabox-live/20261028/ (9 file,
upload 28/10/2026 16:42 ICT). Chi tai 4 file raw_*.jsonl ve thu muc fixture.
Dung surrogate credential cua custom.cloudflare (khong ghi secret ra dau).

Tu phien 29/10 (Chot 14:52 29/10), file JSONL day len R2 o dang gzip
(key .gz). download_one thu key .gz truoc, 404 thi thu ban thuong, .gz
thi giai nen ve ten goc. Prefix cu (28/10) van ban thuong.
"""
import argparse
import gzip
import os
import shutil
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


def download_one(get_response, key_base, dest):
    """Tai 1 file: thu key .gz truoc, 404 thi thu ban thuong.

    get_response(key) tra doi tuong co status_code, iter_content(),
    raise_for_status() va close(). Tra so byte ghi ra dest (sau khi
    giai nen neu la .gz). Ca 2 key deu 404 thi raise RuntimeError.
    """
    for suffix, is_gz in ((".gz", True), ("", False)):
        key = key_base + suffix
        resp = get_response(key)
        try:
            if resp.status_code == 404:
                continue
            resp.raise_for_status()
            tmp = dest + ".download"
            total = 0
            with open(tmp, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    if chunk:
                        f.write(chunk)
                        total += len(chunk)
        finally:
            resp.close()
        print(f"  GET {key} ({total} bytes)")
        if is_gz:
            with gzip.open(tmp, "rb") as fin, open(dest, "wb") as fout:
                shutil.copyfileobj(fin, fout, length=1 << 20)
            os.remove(tmp)
        else:
            os.replace(tmp, dest)
        return total
    raise RuntimeError(f"not found: {key_base} (.gz va ban thuong deu 404)")


def main():
    ap = argparse.ArgumentParser(description="Tai fixture raw 28/10 tu R2")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--prefix", default="instabox-live/20261028")
    args = ap.parse_args()
    entry = dynamic_credential_entry("custom.cloudflare", "access_token")
    headers = {"Authorization": "Bearer " + entry["surrogate"].strip()}
    os.makedirs(args.out_dir, exist_ok=True)

    def get_response(key):
        url = f"{API}/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}"
        return requests.get(url, headers=headers, stream=True, timeout=300)

    for name in FILES:
        key_base = f"{args.prefix}/{name}"
        dest = os.path.join(args.out_dir, name)
        print(f"GET {key_base} -> {dest}")
        download_one(get_response, key_base, dest)
    print("xong.")


if __name__ == "__main__":
    main()
