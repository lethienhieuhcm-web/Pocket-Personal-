"""
Modal cron jobs for Pocket Personal (k1 Section 2).

3 scheduled functions:
1. book_processor  - every 5 min: process PDF uploads from R2 (English Lab Books)
2. publish_snapshot - every 30 min: publish stock snapshots via vnstock.
   Failure policy (ong lon style): track per-step success; if NOTHING was
   published (total failure) -> send Telegram alert via Worker
   /api/internal/modal-alert, then raise so the dashboard shows Failed.
   Partial failure only logs; the next run retries in 30 min.
3. d1_backup        - daily: backup D1 to Modal Volume (keep 7 versions)

Secrets (Modal dashboard -> Secrets -> "pocket-personal"):
  - CF_API_TOKEN
  - STOCK_PUBLISH_SECRET
  - VNSTOCK_API_KEY

Deploy:
  modal deploy app.py

Test single run:
  modal run app.py::book_processor
  modal run app.py::publish_snapshot
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
    .pip_install("vnstock", extra_index_url="https://vnstocks.com/api/simple")
)

app = modal.App("pocket-personal-crons")


@app.function(
    image=book_image,
    secrets=[modal.Secret.from_name("pocket-personal")],
    volumes={"/data": volume},
    schedule=modal.Cron("*/5 * * * *"),  # every 5 minutes
    timeout=600,
)
def book_processor():
    """Process pending PDF book uploads from R2 every 5 minutes."""
    import json, re, os, tempfile, urllib.request
    from datetime import datetime

    CF_TOKEN = os.environ["CF_API_TOKEN"]
    API = "https://api.cloudflare.com/client/v4"
    ACCOUNT = "25b2327e932d26e5487c2ba8ad058932"
    BUCKET = "english-lab-data"

    def api_req(method, path, data=None, raw=False):
        url = API + path
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", f"Bearer {CF_TOKEN}")
        if not raw:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=120) as resp:
            if raw:
                return resp.read()
            return json.loads(resp.read().decode())

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
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=120):
            pass

    # Find pending PDFs
    pending = r2_list("books/pending/")
    if not pending:
        print(f"[{datetime.now().isoformat()}] book_processor: no pending PDFs")
        return

    import fitz  # pymupdf

    for obj in pending:
        key = obj["key"]
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

    volume.commit()


@app.function(
    image=stock_image,
    secrets=[modal.Secret.from_name("pocket-personal")],
    volumes={"/data": volume},
    schedule=modal.Cron("*/30 2-7 * * 1-5", timezone="UTC"),  # every 30 min, 09:00-14:59 +07, Mon-Fri (HOSE hours; Modal cron is UTC)
    timeout=1200,
)
def publish_snapshot():
    """Publish stock snapshot every 30 min during HOSE trading hours."""
    import json, math, os, sys, time, urllib.request
    from datetime import date, timedelta

    PUBLISH_URL = "https://lethanhdong.one/api/internal/stock-publish"
    ALERT_URL = "https://lethanhdong.one/api/internal/modal-alert"
    SECRET = os.environ["STOCK_PUBLISH_SECRET"]
    VNSTOCK_KEY = os.environ["VNSTOCK_API_KEY"]

    # Write vnstock key to expected location for the library
    vnstock_dir = os.path.expanduser("~/.vnstock")
    os.makedirs(vnstock_dir, exist_ok=True)
    with open(os.path.join(vnstock_dir, "api_key.json"), "w") as f:
        json.dump({"api_key": VNSTOCK_KEY}, f)

    from vnstock import Market

    def vn_call(fn, label, retries=3):
        for attempt in range(retries):
            try:
                return fn()
            except SystemExit:
                print(f"[{label}] rate limit, sleep 70s (try {attempt+1})", flush=True)
                time.sleep(70)
            except Exception as e:
                print(f"[{label}] error: {e} (try {attempt+1})", flush=True)
                time.sleep(5)
        print(f"[{label}] skipped after {retries} tries", flush=True)
        return None

    def publish(payload):
        data = json.dumps(payload).encode()
        req = urllib.request.Request(PUBLISH_URL, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Publish-Secret", SECRET)
        req.add_header("X-Internal-Secret", SECRET)
        req.add_header("User-Agent", "Mozilla/5.0 (compatible; PocketPersonal/1.0)")
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())

    def send_fail_alert(detail):
        """Bao Henrry qua Telegram khi run that bai hoan toan (kieu ong lon:
        alert on meaningful failure, tranh alert fatigue khi chi loi 1 phan)."""
        from datetime import datetime, timezone
        try:
            data = json.dumps({
                "app": "pocket-personal-crons",
                "fn": "publish_snapshot",
                "time": datetime.now(timezone.utc).isoformat(),
                "detail": detail,
            }).encode()
            req = urllib.request.Request(ALERT_URL, data=data, method="POST")
            req.add_header("Content-Type", "application/json")
            req.add_header("X-Publish-Secret", SECRET)
            req.add_header("X-Internal-Secret", SECRET)
            req.add_header("User-Agent", "Mozilla/5.0 (compatible; PocketPersonal/1.0)")
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(f"  fail alert sent: HTTP {resp.status}", flush=True)
        except Exception as e:
            print(f"  fail alert error: {e}", flush=True)

    print(f"[{date.today().isoformat()}] publish_snapshot starting...")
    market = Market()
    ok_indices = False
    ok_quotes = False

    # Indices
    indices = vn_call(lambda: market.indices(), "indices")
    if indices is not None:
        try:
            result = publish({"type": "indices", "data": indices.to_dict("records") if hasattr(indices, "to_dict") else []})
            print(f"  indices: {result}")
            ok_indices = True
        except Exception as e:
            print(f"  indices publish error: {e}")

    # Top liquid symbols for quotes
    symbols = ["VCB", "BID", "CTG", "TCB", "MBB", "VPB", "HPG", "VHM", "VIC", "VNM",
               "MSN", "FPT", "MWG", "SSI", "VND", "HCM", "STB", "ACB", "SHB", "POW"]
    quotes = []
    for sym in symbols:
        q = vn_call(lambda s=sym: market.quote(s), f"quote-{sym}", retries=2)
        if q is not None:
            try:
                quotes.append(q.to_dict("records")[0] if hasattr(q, "to_dict") else {})
            except Exception:
                pass
        time.sleep(4)  # respect rate limit (15 calls/min shared)

    if quotes:
        try:
            result = publish({"type": "quotes", "data": quotes})
            print(f"  quotes: {len(quotes)} symbols -> {result}")
            ok_quotes = True
        except Exception as e:
            print(f"  quotes publish error: {e}")

    # That bai hoan toan (khong publish duoc gi) -> alert + raise de
    # dashboard Modal hien Failed. Loi 1 phan thi chi log, run sau tu retry.
    if not ok_indices and not ok_quotes:
        detail = "indices: FAILED, quotes: FAILED"
        send_fail_alert(detail)
        raise RuntimeError(f"publish_snapshot failed: {detail}")

    print("publish_snapshot done.")
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
