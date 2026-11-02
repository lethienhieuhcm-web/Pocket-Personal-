"""
Modal cron jobs for Pocket Personal (k1 Section 2).

2 scheduled functions:
1. book_processor  - daily 17:00 +07: process PDF uploads from R2 (English Lab Books)
2. d1_backup        - daily: backup D1 to Modal Volume (keep 7 versions)
   (realtime_poller da xoa 28/10, lenh Henrry 17:35; thay bang doi ung InstaBox — xem thiet ke 28/10.)
   (publish_snapshot da xoa 28/10 de don 1 suat lich Modal; code con trong git.)

NHAP BUOC 2 (01/11, board-vci-wiring): +1 ham `stock_snapshot` tren stock_image
  — consumer DAU TIEN goi bundle /opt/direct_fetch.py (vnd_index_snapshot +
  vci_symbols). CHUA hen lich, CHUA deploy; xem work/CONSUMER_SPEC.md.

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
import os
import sys

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
    # NHAP BUOC 2: router la lop dinh tuyen ma consumer Modal can; no phai
    # nam cung choi direct_fetch.py tren duong /opt de `from direct_fetch
    # import ...` ben trong ham router tim thay module.
    .add_local_file("./source_router.py", "/opt/source_router.py")
)

# (Nhat ban nhap: dinh nghia `app` day len truoc khoai wiring duoi day vi
#  no dung @app.function — thu tu nay khong anh huong Modal.)
app = modal.App("pocket-personal-crons")

# --- NHAP BUOC 2: duong nap bundle /opt/direct_fetch.py -------------------
# /opt KHONG nam trong sys.path mac dinh cua Python, nen file da nam trong
# image tu 01/11 (8cfe4f7) van khong the import duoc — do chinh la ly do
# bundle "mo coi" (khong consumer nao goi). Phai chen tuong minh.
# DIRECT_FETCH_DIR chi la moc de offline harness tro vao thu muc gia lap;
# deploy that khong dat env => mac dinh "/opt" dung nhu image da chep file.
DIRECT_FETCH_DIR = os.environ.get("DIRECT_FETCH_DIR", "/opt")


def _use_direct_fetch(base_dir: str = DIRECT_FETCH_DIR):
    """Chen base_dir vao sys.path va import direct_fetch (bundle 670 dong).

    Tra ve module da import. source_router.goI `from direct_fetch import ...`
    BEN TRONG ham cua no, nen chi can goc /opt nam tren sys.path truoc luc
    goi router-la du; khong can sua router."""
    if base_dir not in sys.path:
        sys.path.insert(0, base_dir)
    import direct_fetch
    return direct_fetch


# Universe cho lane quotes cua stock_snapshot. TAM = 47 ma cua
# screener.py:23-29 (VM). Nguon chuan nen lay tu listing_cache/R2 —
# de Plan quyet sau phien 02/11 (KHONG phat minh list moi).
QUOTE_UNIVERSE = (
    "FPT", "MBB", "HPG", "VCB", "VIC", "VHM", "MSN", "VNM", "GAS", "PLX",
    "BID", "CTG", "TCB", "VPB", "ACB", "STB", "SSI", "VCI", "HCM", "VND",
    "POW", "REE", "PNJ", "MWG", "FRT", "DGW", "SAB", "DGC", "GEX", "KBC",
    "PDR", "VRE", "VJC", "HDB", "EIB", "OCB", "TPB", "LPB", "SHB", "GVR",
    "BVH", "CMG", "VGI", "ACV", "BSR", "PVD", "PVS",
)

# Ky hieu chi so — trung voi publish_snapshot.py:122-123 de Worker/Frontend
# khong thay doi hop dong.
MAIN_INDEX_SYMBOLS = ["VNINDEX", "VN30", "HNXIndex", "UPCOMIndex"]
SECTOR_INDEX_SYMBOLS = ["VNFIN", "VNREAL", "VNIT", "VNIND", "VNMAT", "VNCONS"]


@app.function(
    image=stock_image,
    secrets=[modal.Secret.from_name("pocket-personal")],
    # P0-1 (lenh Henrry 13:17 02/11): HEN LAI producer chi so — day la ly do
    # R2 indices.json dong bang tu 28/10 (bo producer bi go lich).
    # */5 2-7 * * 1-5 UTC = moi 5 phut trong gio phien 09:00-15:00 ICT
    # (UTC+7 -> 02:00-07:59 UTC), thu 2-den thu 6.
    schedule=modal.Cron("*/5 2-7 * * 1-5", timezone="UTC"),
    timeout=300,
)
def stock_snapshot(symbols: tuple = QUOTE_UNIVERSE):
    """NHAP BUOC 2: consumer dau tien cua bundle /opt/direct_fetch.py.

    Lai 2 lane ma realtime_poller (da xoa 28/10) tung phat, bang dung bundle:
      indices/sector_indices  <- vnd_index_snapshot()  (VNDirect dchart, 10 dong)
      quotes                  <- vci_symbols()          (VietCap trading, qua router)
    Du lieu publish thay cho: khong co gi (bundle chua tung duoc goi).

    Chay thu ma khong ghi Worker: dat env STOCK_SNAPSHOT_DRY=1."""
    import json
    import urllib.request
    from datetime import datetime, timezone

    base_dir = os.environ.get("DIRECT_FETCH_DIR", DIRECT_FETCH_DIR)
    _use_direct_fetch(base_dir)               # nap bundle tu /opt
    import source_router as rt                # /opt da nam tren sys.path

    idx, idx_src = rt.index_snapshot(MAIN_INDEX_SYMBOLS + SECTOR_INDEX_SYMBOLS)
    main = [r for r in idx if r["symbol"] in MAIN_INDEX_SYMBOLS]
    sector = [r for r in idx if r["symbol"] in SECTOR_INDEX_SYMBOLS]

    board, board_src = rt.price_board(list(symbols), prefer="vci")
    quotes = {}
    for sym, q in board.items():
        close = q.get("close")
        # Scale: vci_symbols/kbs_price_board deu tra gia bang DONG
        # (probe: VIC matchPrice 241000, KBS CP 241000). R2 quotes.json
        # CUNG dung DONG (worker/src/stock.js:437, do that 22/10: FPT
        # 57400; chi screener.json moi la NGHIN dong, FPT 57,4).
        # publish_snapshot.py:606 chia 1000 la khi ghi DB screener_cache
        # (thang nghin), KHONG phai R2 — dung vao day la lech 1000 lan.
        # (Plan sua 01/11: bo /1000 cua ban nhap.)
        # value_vnd: router VCI phat `value_vnd` (dong, x1e6 tu
        # accumulatedValue trieu dong); chuoi KBS khong co key do nen
        # roi ve `value` = KBS TV (cung la dong) — giong het
        # publish_snapshot.py:601.
        value_vnd = q.get("value_vnd", q.get("value"))
        quotes[sym] = {
            "close": close,
            "change": q.get("change"),
            "pct_change": q.get("pct_change"),
            "volume": q.get("volume"),
            "value_vnd": value_vnd,
            "exchange": q.get("exchange"),
            "foreign_buy_volume": q.get("foreign_buy_volume"),
            "foreign_sell_volume": q.get("foreign_sell_volume"),
            "foreign_buy_value": q.get("foreign_buy_value"),
            "foreign_sell_value": q.get("foreign_sell_value"),
        }

    payload = {"indices": main, "sector_indices": sector, "quotes": quotes,
               # P0-1 CHUAN DON VI (quyet dinh, xem REPORT muc 1): moi gia tri
               # tien (close/change/reference/value) trong payload nay = DONG
               # (VND) — trung voi quotes.json (von la DONG, stock.js:437).
               # screener.json moi la NGHIN dong. Them truong `unit` de fanout/
               # UI nhan ra bac don vi va khong phat gia sai 1000 lan (REPORT §6.4).
               "unit": "VND",
               "_prov": {"source": f"modal:direct_fetch({idx_src}+{board_src})",
                         "retrieved_at": datetime.now(timezone.utc).isoformat(),
                         "unit": "VND"}}

    # DRY=1: buoc POST (offline harness dung moc nay). Deploy that khong dat
    # env => mac dinh publish.
    if os.environ.get("STOCK_SNAPSHOT_DRY", "0") == "1":
        print(f"stock_snapshot DRY: {len(main)} chi so, {len(sector)} nganh, "
              f"{len(quotes)} ma (khong POST)", flush=True)
        return payload

    url = os.environ.get("STOCKAPP_PUBLISH_URL",
                         "https://lethanhdong.one/api/internal/stock-publish")
    secret = os.environ.get("STOCK_PUBLISH_SECRET", "")
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "X-Publish-Secret": secret,
                                          "X-Internal-Secret": secret,
                                          "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode())
    print(f"stock_snapshot: {len(main)} chi so, {len(sector)} nganh, "
          f"{len(quotes)} ma -> {result}", flush=True)
    return result


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
