"""
Modal cron jobs for Pocket Personal (k1 Section 2).

2 scheduled functions:
1. book_processor  - daily 17:00 +07: process PDF uploads from R2 (English Lab Books)
2. d1_backup        - daily: backup D1 to Modal Volume (keep 7 versions)
   (realtime_poller da xoa 28/10, lenh Henrry 17:35; thay bang doi ung InstaBox — xem thiet ke 28/10.)
   (publish_snapshot da xoa 28/10 de don 1 suat lich Modal; code con trong git.)

Secrets (Modal dashboard -> Secrets -> "pocket-personal"):
  - CF_API_TOKEN
  - STOCK_PUBLISH_SECRET
  - VNSTOCK_API_KEY

Deploy:
  modal deploy app.py

Test single run:
  modal run app.py::book_processor
  modal run app.py::d1_backup
"""
import modal

# Persistent volume for state (D1 backups, temp files)
volume = modal.Volume.from_name("pocket-personal-vol", create_if_missing=True)

# Image with all dependencies
book_image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install("pymupdf", "requests")
)

stock_image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install("requests")
    .pip_install("vnstock>=5,<6", extra_index_url="https://vnstocks.com/api/packages")
    .add_local_file("./direct_fetch.py", "/opt/direct_fetch.py")  # CWD cua workflow deploy la modal_crons/
)

app = modal.App("pocket-personal-crons")


@app.function(
    image=book_image,
    secrets=[modal.Secret.from_name("pocket-personal")],
    volumes={"/data": volume},
    schedule=modal.Cron("0 10 * * *", timezone="UTC"),  # daily 10:00 UTC = 17:00 +07 (Chot 17:24 28/10)
    timeout=600,
)
def book_processor():
    """Process pending PDF book uploads from R2 once a day at 17:00 +07."""
    import json, re, os, tempfile, urllib.request
    from datetime import datetime

    CF_TOKEN = os.environ["CF_API_TOKEN"]
    API = "https://api.cloudflare.com/client/v4"
    ACCOUNT = "25b2327e932d26e5487c2ba8ad058932"
    BUCKET = "english-lab-data"
    # Cloudflare chan UA mac dinh cua urllib (error 1010) mot cach gian
    # doan theo IP egress cua Modal -> 403 vai lan/ngay tu 22/10.
    # Gan UA trinh duyet + retry voi backoff cho 403/429/5xx.
    UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
          "AppleWebKit/537.36 (KHTML, like Gecko) "
          "Chrome/126.0.0.0 Safari/537.36")

    def api_req(method, path, data=None, raw=False):
        import time as _time
        import urllib.error
        url = API + path
        body = json.dumps(data).encode() if data is not None else None
        last = None
        for attempt in range(4):
            req = urllib.request.Request(url, data=body, method=method)
            req.add_header("Authorization", f"Bearer {CF_TOKEN}")
            req.add_header("User-Agent", UA)
            if not raw:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    if raw:
                        return resp.read()
                    return json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                last = e
                if e.code in (403, 429) or e.code >= 500:
                    if attempt < 3:
                        _time.sleep((2, 5, 10)[attempt])
                        continue
                raise
            except Exception as e:
                last = e
                if attempt < 3:
                    _time.sleep((2, 5, 10)[attempt])
                    continue
                raise
        raise last

    def r2_download(key):
        return api_req("GET", f"/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}", raw=True)

    def r2_list(prefix):
        out = api_req("GET", f"/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects?prefix={prefix}")
        result = out.get("result", [])
        return result if isinstance(result, list) else result.get("objects", [])

    def r2_delete(key):
        api_req("DELETE", f"/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}")

    def r2_put(key, obj):
        data = json.dumps(obj).encode()
        req = urllib.request.Request(
            f"{API}/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}",
            data=data, method="PUT")
        req.add_header("Authorization", f"Bearer {CF_TOKEN}")
        req.add_header("User-Agent", UA)
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=120):
            pass

    def r2_get_json(key):
        try:
            return json.loads(r2_download(key).decode())
        except Exception:
            return None

    # Find pending PDFs
    pending = r2_list("books/pending/")
    if not pending:
        print(f"[{datetime.now().isoformat()}] book_processor: no pending PDFs")
        return

    # Claim chong xu ly trung: moi sach duoc danh dau bang mot object
    # books/claims/<book_id>.json truoc khi xu ly. Claim con tuoi
    # (< 20 phut) cua tien trinh khac -> bo qua sach do. Dau ra
    # (books/text, books/meta) xac dinh theo book_id nen ke ca khi hai
    # tien trinh cung chay, ghi de cung noi dung; claim chi de tranh
    # viec trung nhau. VM cron dung keyspace jobs/ + uploads/ rieng.
    now_ms = int(datetime.now().timestamp() * 1000)

    import fitz  # pymupdf

    for obj in pending:
        key = obj["key"]
        claim_id = os.path.basename(key).replace(".pdf", "")
        claim_key = f"books/claims/{claim_id}.json"
        existing = r2_get_json(claim_key)
        if existing and now_ms - int(existing.get("ts", 0)) < 20 * 60 * 1000:
            print(f"Skip {key}: claimed at {existing.get('ts')} "
                  f"by {existing.get('owner')}")
            continue
        try:
            r2_put(claim_key, {"owner": "modal-book-processor",
                               "ts": now_ms, "key": key})
        except Exception as e:
            print(f"Claim failed for {key}: {e} — xu ly tiep (dau ra "
                  f"theo book_id, ghi de cung noi dung)")
        print(f"Processing {key}...")
        try:
            pdf_bytes = r2_download(key)
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
                tf.write(pdf_bytes)
                pdf_path = tf.name

            doc = fitz.open(pdf_path)
            full_text = ""
            for page in doc:
                full_text += page.get_text() + "\n"
            doc.close()
            os.unlink(pdf_path)

            # Basic chapter detection (lines that look like headings)
            lines = full_text.split("\n")
            chapters = []
            current = {"title": "Chapter 1", "text": ""}
            for line in lines:
                stripped = line.strip()
                if re.match(r"^(chapter|chương)\s+\d+", stripped, re.I) and len(stripped) < 80:
                    if current["text"].strip():
                        chapters.append(current)
                    current = {"title": stripped, "text": ""}
                else:
                    current["text"] += line + "\n"
            if current["text"].strip():
                chapters.append(current)

            # Simple CEFR estimation by avg word length + sentence length
            words = full_text.split()
            avg_wl = sum(len(w) for w in words) / max(len(words), 1) if words else 0
            if avg_wl < 4.5:
                cefr = "A1"
            elif avg_wl < 5.0:
                cefr = "A2"
            elif avg_wl < 5.5:
                cefr = "B1"
            elif avg_wl < 6.0:
                cefr = "B2"
            else:
                cefr = "C1"

            book_id = os.path.basename(key).replace(".pdf", "")
            result = {
                "book_id": book_id,
                "source_key": key,
                "processed_at": datetime.now().isoformat(),
                "cefr": cefr,
                "word_count": len(words),
                "chapters": [
                    {"title": c["title"], "word_count": len(c["text"].split())}
                    for c in chapters
                ],
                "full_text_key": f"books/text/{book_id}.txt",
            }

            # Upload extracted text and metadata
            r2_put(f"books/text/{book_id}.txt", {"text": full_text})
            r2_put(f"books/meta/{book_id}.json", result)
            r2_delete(key)  # remove from pending

            print(f"  -> {book_id}: {len(words)} words, {len(chapters)} chapters, CEFR {cefr}")
        except Exception as e:
            print(f"  ERROR {key}: {e}")
        finally:
            try:
                r2_delete(claim_key)
            except Exception:
                pass

    volume.commit()




@app.function(
    image=book_image,
    secrets=[modal.Secret.from_name("pocket-personal")],
    volumes={"/data": volume},
    schedule=modal.Cron("0 17 * * *"),  # daily at 17:00 UTC (midnight +07)
    timeout=600,
)
def d1_backup():
    """Daily D1 backup to Modal Volume. Keeps 7 versions."""
    import json, os, glob, datetime, urllib.request

    CF_TOKEN = os.environ["CF_API_TOKEN"]
    API = "https://api.cloudflare.com/client/v4"
    ACCT = "25b2327e932d26e5487c2ba8ad058932"
    D1_ID = "e856db4d-1ee1-42fd-9c1d-1807ca31afb5"
    KEEP = 7

    def api(method, path, data=None):
        url = API + path
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", f"Bearer {CF_TOKEN}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())

    today = datetime.date.today().isoformat()
    tables_r = api("POST", f"/accounts/{ACCT}/d1/database/{D1_ID}/query",
                   {"sql": "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"})
    if not tables_r.get("success"):
        print("Failed to list tables")
        return
    tables = [r["name"] for r in tables_r["result"][0]["results"]]

    backup = {"date": today, "tables": {}}
    for t in tables:
        try:
            r = api("POST", f"/accounts/{ACCT}/d1/database/{D1_ID}/query",
                    {"sql": f'SELECT * FROM "{t}" LIMIT 10000'})
            if r.get("success"):
                backup["tables"][t] = r["result"][0]["results"]
        except Exception as e:
            print(f"  skip {t}: {e}")

    data = json.dumps(backup, ensure_ascii=False).encode()
    os.makedirs("/data/backups/d1", exist_ok=True)
    key = f"/data/backups/d1/{today}.json"
    with open(key, "wb") as f:
        f.write(data)
    print(f"Backup: {len(tables)} tables, {len(data)} bytes -> {key}")

    olds = sorted(glob.glob("/data/backups/d1/*.json"))
    for old_key in olds[:-KEEP]:
        os.remove(old_key)
        print(f"  deleted old: {old_key}")

    volume.commit()
