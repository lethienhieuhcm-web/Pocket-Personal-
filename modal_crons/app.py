"""
Modal cron jobs for Pocket Personal (k1 Section 2).

3 scheduled functions:
1. book_processor  - every 5 min: process PDF uploads from R2 (English Lab Books)
2. realtime_poller - every 1 min trong phien HOSE (9:00-14:45 +07, T2-T6):
   lay gia live tu VCI/KBS (tu chu, khong qua vnstock), publish len R2.
   Payload DUNG contract Worker ({"indices": [...]} -> market/indices.json,
   {"quotes": {SYM: {...}}} -> market/quotes.json).
3. d1_backup        - daily: backup D1 to Modal Volume (keep 7 versions)
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
    .add_local_file("./modal_crons/direct_fetch.py", "/opt/direct_fetch.py")
)

# Realtime image: KHONG can vnstock, chi can direct_fetch (tu chu du lieu)
# VCI trading + KBS board la feed live trong phien, polling 60s
realtime_image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install("requests")
    .add_local_file("./modal_crons/direct_fetch.py", "/opt/direct_fetch.py")
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
    image=realtime_image,
    secrets=[modal.Secret.from_name("pocket-personal")],
    schedule=modal.Cron("* 2-7 * * 1-5", timezone="UTC"),  # every 1 min, 09:00-14:59 +07, Mon-Fri
    timeout=120,
)
def realtime_poller():
    """Realtime poller: lay gia live tu VCI/KBS (tu chu, khong qua vnstock), publish len R2 moi 60s.

    Chay trong phien HOSE (9:00-14:45 +07, T2-T6). Ngoai gio tu thoat nhanh.
    Nguon: direct_fetch.py — quotes: kbs_price_board; indices: vnd_index_snapshot
    (VNDirect dchart, doi chieu cheo + fallback bang vci_index_history).
    """
    import sys
    sys.path.insert(0, "/opt")
    import json, urllib.request
    from datetime import datetime, timezone, timedelta

    PUBLISH_URL = "https://lethanhdong.one/api/internal/stock-publish"
    import os
    SECRET = os.environ.get("STOCK_PUBLISH_SECRET", "")
    if not SECRET:
        raise RuntimeError("[realtime] thieu STOCK_PUBLISH_SECRET trong Modal Secrets 'pocket-personal'")

    # Kiem tra gio giao dich (VN time)
    vn_now = datetime.now(timezone.utc) + timedelta(hours=7)
    wd = vn_now.weekday()  # 0=Mon
    mins = vn_now.hour * 60 + vn_now.minute
    # 9:00-14:45, T2-T6
    if wd >= 5 or not (9 * 60 <= mins <= 14 * 60 + 45):
        print(f"[realtime] ngoai gio GD ({vn_now.strftime('%H:%M')} VN), skip")
        return

    import direct_fetch as df

    def publish(payload):
        data = json.dumps(payload).encode()
        req = urllib.request.Request(PUBLISH_URL, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Publish-Secret", SECRET)
        req.add_header("X-Internal-Secret", SECRET)
        req.add_header("User-Agent", "Mozilla/5.0")
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())

    # 1. Bang gia realtime tu KBS (1 call cho tat ca ma)
    symbols = ["VCB", "BID", "CTG", "TCB", "MBB", "VPB", "HPG", "VHM", "VIC", "VNM",
               "MSN", "FPT", "MWG", "SSI", "VND", "HCM", "STB", "ACB", "SHB", "POW",
               "GAS", "PLX", "BVH", "VRE", "VJC", "PNJ", "SAB", "GVR", "BCM", "CTG"]
    symbols = list(dict.fromkeys(symbols))  # dedup
    try:
        board = df.kbs_price_board(symbols)
        # Gia tri mua/ban NN: bang gia KBS khong co (FO/FR la han muc/room
        # tinh bang CP — sua goc 21/10/2026) -> lay gia tri that tu VCI.
        try:
            vboard = df.vci_symbols(symbols) or {}
        except Exception:  # noqa: BLE001
            vboard = {}
        quotes = {}
        for sym, q in board.items():
            vq = vboard.get(sym) or {}
            quotes[sym] = {
                "close": q.get("close"),
                "change": q.get("change"),
                "pct_change": q.get("pct_change"),
                "volume": q.get("volume"),
                "value_vnd": q.get("value"),
                "exchange": q.get("exchange"),
                "bid": q.get("bid"),
                "ask": q.get("ask"),
                # Khoi ngoai — frontend hien "NN mua/ban". KL tu KBS
                # (FB/FS), gia tri tu VCI. Phai publish o day vi realtime
                # ghi de toan bo quotes.json moi phut.
                "foreign_buy_volume": q.get("foreign_buy_volume"),
                "foreign_sell_volume": q.get("foreign_sell_volume"),
                "foreign_buy_value": vq.get("foreign_buy_value"),
                "foreign_sell_value": vq.get("foreign_sell_value"),
            }
        r = publish({"quotes_patch": quotes,
                     "_prov": {"source": "direct:kbs", "retrieved_at": datetime.now(timezone.utc).isoformat()}})
        print(f"[realtime] quotes: {len(quotes)} -> {r}")
    except Exception as e:
        print(f"[realtime] quotes error: {e}")

    # 1b. [v2 22/10] Do sau 3 buoc TOAN thi truong (moi 5 phut): trang chi tiet cac ma
    # ngoai vu tru poller chi co quote EOD tu screener (khong bid/ask) —
    # dien do sau that tu bang KBS (1 call lon nhu luong screener) theo
    # tien le FR/FO: nguon chinh thieu thi router/publish dien tu nguon
    # co that. Sua goc 22/10/2026 (lenh Henrry: bid/ask NaN + thieu do sau).
    if vn_now.minute % 5 == 0:
        try:
            listing = df.vnd_listing() or []
            all_syms = [x["symbol"] for x in listing if x.get("symbol")]
            full = df.kbs_price_board(all_syms)
            depth = {}
            for sym, q in full.items():
                if q.get("bid") or q.get("ask"):
                    depth[sym] = {"bid": q.get("bid"), "ask": q.get("ask")}
            r = publish({"depth": depth,
                         "_prov": {"source": "direct:kbs-board-full",
                                   "retrieved_at": datetime.now(timezone.utc).isoformat()}})
            print(f"[realtime] depth: {len(depth)}/{len(all_syms)} -> {r}")
        except Exception as e:  # noqa: BLE001
            print(f"[realtime] depth error: {e}")

    # 2. Chi so: nguon chinh VNDirect dchart (truc tiep), doi chieu cheo VCI.
    # 2026-10-20: bo vci_index_history lam nguon chinh — feed EOD cham 1 ngay
    # + sap xep GIAM dan (moi nhat truoc), code cu lay hist[-1] nen dang so
    # phien cu nhat trong cua so lam "hom nay" ca ngay (VNINDEX dung o so
    # 16/10 trong phien 20/10). VCI chi con vai tro doi chieu + fallback
    # (fallback gan dung ngay cua so nen app khong hieu nham la truc tiep).
    def _vci_close_on(sym, day):
        """Close cua phien `day` theo VCI IQ history (feed giam dan)."""
        try:
            for h in df.vci_index_history(sym, limit=7):
                if h.get("date") == day:
                    return h.get("close")
        except Exception:
            pass
        return None

    try:
        idx_rows = []
        for row in df.vnd_index_snapshot():
            vci_pc = _vci_close_on(row["symbol"], row["prev_date"])
            if vci_pc and row["prev_close"]:
                lech = abs(vci_pc - row["prev_close"]) / row["prev_close"] * 100
                if lech > 0.5:
                    print(f"[realtime] indices {row['symbol']}: LECH doi chieu "
                          f"VND prev={row['prev_close']} vs VCI={vci_pc} ({lech:.2f}%) "
                          f"-> bo qua chi so nay, giu so cu")
                    continue
            idx_rows.append({k: row[k] for k in
                             ("symbol", "close", "volume", "time",
                              "change", "pct_change")})
        if idx_rows:
            r = publish({"indices": idx_rows,
                         "_prov": {"source": "direct:vndirect", "retrieved_at": datetime.now(timezone.utc).isoformat()}})
            print(f"[realtime] indices (vnd): {len(idx_rows)} -> {r}")
        else:
            raise RuntimeError("vnd_index_snapshot rong hoac lech het")
    except Exception as e:
        print(f"[realtime] indices vnd error: {e} -> fallback VCI (EOD, gan dung ngay)")
        try:
            idx_rows = []
            for sym in ["VNINDEX", "VN30", "HNXIndex", "UPCOMIndex"]:
                hist = df.vci_index_history(sym, limit=2)
                if hist:
                    last = hist[0]  # feed GIAM dan: phan tu dau moi la moi nhat
                    pct = last.get("pct_change")  # VCI tra dang phan so (0.01 = 1%)
                    idx_rows.append({
                        "symbol": sym,
                        "close": last.get("close"),
                        "volume": last.get("volume"),
                        "time": last.get("date"),
                        "change": last.get("change"),
                        "pct_change": round(pct * 100, 2) if pct is not None else None,
                    })
            if idx_rows:
                r = publish({"indices": idx_rows,
                             "_prov": {"source": "direct:vci-fallback", "retrieved_at": datetime.now(timezone.utc).isoformat()}})
                print(f"[realtime] indices (vci-fallback): {len(idx_rows)} -> {r}")
        except Exception as e2:
            print(f"[realtime] indices fallback error: {e2} -> giu nguyen so cu tren R2")

    # 2b. Chi so nganh (them 23/10 — sua goc loi "chua co bieu do cua
    # cac chi so"): truoc day KHONG co buoc nao publish khoa
    # sector_indices trong luong chay thuong truc (publish_snapshot
    # Modal da tat 19/10, lane slow VM tra ve truoc doan base) nen
    # file tren R2 chi duoc ghi boi cac lan publish tay. Cung nguon
    # dchart + cung contract voi chi so chinh; loi thi giu so cu.
    try:
        sec_rows = df.vnd_sector_snapshot()
        if sec_rows:
            r = publish({"sector_indices": sec_rows,
                         "_prov": {"source": "direct:vndirect", "retrieved_at": datetime.now(timezone.utc).isoformat()}})
            print(f"[realtime] sector indices (vnd): {len(sec_rows)} -> {r}")
    except Exception as e:  # noqa: BLE001
        print(f"[realtime] sector indices error: {e} -> giu nguyen so cu tren R2")

    print("[realtime] done.")


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
