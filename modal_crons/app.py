"""
Modal cron jobs for Pocket Personal (k1 Section 2).

2 scheduled functions (bao tri) — cat Modal 04/11 (Henrry Chot 21:46 03/11):
1. book_processor  - daily 17:00 +07: process PDF uploads from R2 (English Lab Books)
2. d1_backup        - daily: backup D1 to Modal Volume (keep 7 versions)
(Cac job nen/gia — stock_snapshot, publish_ohlcv_daily, publish_ohlcv_intraday,
 publish_ohlcv_index_intraday, finhay_price_crosscheck — da chuyen sang LightVela,
 chay bang modal_crons/cron_jobs.py; code cu van con trong git + cron_jobs.py.)
   (realtime_poller da xoa 28/10, lenh Henrry 17:35; thay bang doi ung InstaBox — xem thiet ke 28/10.)
   (publish_snapshot da xoa 28/10 de don 1 suat lich Modal; code con trong git.)

NHAP BUOC 2 (01/11, board-vci-wiring): +1 ham `stock_snapshot` tren stock_image
  — consumer DAU TIEN goi bundle /opt/direct_fetch.py (vnd_index_snapshot +
  vci_symbols). CHUA hen lich, CHUA deploy; xem work/CONSUMER_SPEC.md.
  (P0 02/11 da hen lich */5 trong gio phien cho stock_snapshot.)
  (F5 / CUT OVER 03-04/11: stock_snapshot KHONG con lich tren Modal nua —
   da thu thuoc LightVela (modal_crons/cron_jobs.py + crontab.txt). Modal
   schedule verified EMPTY (chi book_processor + d1_backup) via `cat Modal`
   04/11; REEVAL §1.2. Dong "lich */5 tren Modal" o tren la CU, giu lai de
   doc lich su thoi.)

PA-3a (02/11): +1 ham `publish_ohlcv_daily` tren stock_image — EOD
  15:15 ICT (08:15 UTC) T2-T6, chi phat lane `ohlcv` (nen ngay cho
  chart 1D). Lane nay chua producer tung phat: publish_snapshot (xoa
  28/10) chi gui indices + quotes_patch, con stock_snapshot chi gui
  indices/sector_indices/quotes.

Secrets (Modal dashboard -> Secrets -> "pocket-personal"):
  - CF_API_TOKEN
  - STOCK_PUBLISH_SECRET
  - VNSTOCK_API_KEY

Deploy:
  modal deploy app.py

Test single run:
  modal run app.py::book_processor
  modal run app.py::publish_ohlcv_daily
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
    # F4 (IMPL-PLAN B1): source_router.index_snapshot `import index_guard`
    # (dong 204). File nay phai nam cung choi /opt giong router; truoc day
    # no KHONG co trong image -> import luon that -> nhanh fail-open xoa
    # bang chung stale. Ship no vao image la mot nua cua ban fix.
    .add_local_file("./index_guard.py", "/opt/index_guard.py")
    # DOI CHIEU FINHAY (TASK muc 1): 2 file nay nam canh app.py trong modal_crons/,
    # duoc nap len /opt giong direct_fetch.py. Cross-check chi DOC gia, khong ghi
    # vao quotes cua lane realtime.
    .add_local_file("./finhay_client.py", "/opt/finhay_client.py")
    .add_local_file("./finhay_crosscheck.py", "/opt/finhay_crosscheck.py")
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


def _post_publish(payload: dict) -> dict:
    """POST payload toi lane noi bo cua Worker — cung URL + header tuyet
    doi nhu khoai POST trong stock_snapshot. Secret lay tu env, khong
    hardcode."""
    import json
    import urllib.request

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
        return json.loads(resp.read().decode())


def build_ohlcv_daily_payload(symbols, rt, days: int = 800, today=None):
    """PA-3a (RC3): gom nen NGAY theo EOD thanh payload `body.ohlcv`.

    `rt.ohlcv` = source_router (chuoi kbs -> vnstock), gia da chuan hoa
    sang NGHIN dong (frontend nhan 1000 cho ma co phieu,
    js/stocks/detail.js:508,548) va `v` = khoi luong co phieu. Doi ten
    key date/open/high/low/close/volume -> {t,o,h,l,c,v} la dung contract
    R2 ma doc tai stock.js:340,987,1240, de Worker
    (stock.js:1501-1502, ghi tho `body.ohlcv[sym]` khong quy doi) ghi
    market/ohlcv/<SYM>.json = lane chart 1D doc.

    days=800 lich (~>500 phien) du cho chart xin count=400.

    Ma loi het chuoi nguon bi bo qua de nhung ma con van duoc publish;
    lan chay sau tu bo sung (nguon EOD nen lech 1 ngay, khong mat nen)."""
    from datetime import datetime, timedelta, timezone

    if today is None:
        # Nguon D1 la EOD theo gio phien VN -> moc tinh la hom nay ICT.
        today = datetime.now(timezone(timedelta(hours=7))).date()
    start = (today - timedelta(days=days)).isoformat()
    end = today.isoformat()
    out, srcs = {}, []
    for sym in symbols:
        try:
            rows, src = rt.ohlcv(sym, start, end)
        except Exception as e:  # noqa: BLE001
            print(f"[ohlcv-daily] {sym} het nguon: {str(e)[:120]}",
                  flush=True)
            continue
        bars = [{
            "t": r.get("date"), "o": r.get("open"), "h": r.get("high"),
            "l": r.get("low"), "c": r.get("close"), "v": r.get("volume"),
        } for r in (rows or []) if isinstance(r, dict) and r.get("date")]
        if bars:
            out[sym] = bars
            if src not in srcs:
                srcs.append(src)
    payload = {"ohlcv": out,
               "_prov": {"source": f"modal:ohlcv_daily({'+'.join(srcs)})",
                         "retrieved_at": datetime.now(timezone.utc).isoformat(),
                         "unit": "NGHIN_VND"}}
    print(f"[ohlcv-daily] {len(out)}/{len(list(symbols))} ma, "
          f"{start}..{end}, nguon={srcs or '-'}", flush=True)
    return payload


# (PA-3c, 03/11) Chi so -> (ten file R2, ten tren VCI IQ, ma tren dchart).
#Trung _INDEX_OHLCV_MAP o publish_snapshot.py:428-445 (san xuat EOD goc).
INDEX_OHLCV_MAP = (
    ("VNINDEX", "VNINDEX", "VNINDEX"),
    ("VN30", "VN30", "VN30"),
    ("HNX", "HNXIndex", "HNX"),
    ("UPCOM", "HNXUpcomIndex", "UPCOM"),
    ("VNFIN", "VNFIN", "VNFIN"),
    ("VNREAL", "VNREAL", "VNREAL"),
    ("VNIT", "VNIT", "VNIT"),
    ("VNIND", "VNIND", "VNIND"),
    ("VNMAT", "VNMAT", "VNMAT"),
    ("VNCONS", "VNCONS", "VNCONS"),
)


def _dchart_index_bars(sym: str, days: int = 500) -> dict:
    """Nen ngay chi so tu VNDirect dchart, {date: {t,o,h,l,c,v}}.

    Chi gui User-Agent (them Accept -> 406, cung le nhu _dchart_daily_close
    trong publish_snapshot.py). Dung (1) doi chieu close voi VCI va
    (2) lay nen hom nay dang formed (VCI IQ chi phat EOD, muon hon trong
    phien)."""
    import json
    import time
    import urllib.request
    from datetime import datetime, timedelta, timezone

    to = int(time.time())
    frm = to - days * 86400
    url = ("https://dchart-api.vndirect.com.vn/dchart/history"
           f"?symbol={sym}&resolution=D&from={frm}&to={to}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        d = json.loads(resp.read().decode())
    ict = timezone(timedelta(hours=7))
    ts = d.get("t") or []
    n = len(ts)
    out = {}
    for i, t in enumerate(ts):
        date = datetime.fromtimestamp(t, ict).strftime("%Y-%m-%d")
        out[date] = {"t": date,
                     "o": (d.get("o") or [None] * n)[i],
                     "h": (d.get("h") or [None] * n)[i],
                     "l": (d.get("l") or [None] * n)[i],
                     "c": (d.get("c") or [None] * n)[i],
                     "v": (d.get("v") or [None] * n)[i]}
    return out


def build_index_ohlcv_payload(df, limit: int = 320, today=None):
    """PA-3c: nen ngay CHI SO cho market/ohlcv/<IDX>.json (4 chinh + 6
    nganh). Dong cau vang 22/10 giu nguyen nhu _publish_index_ohlcv
    (publish_snapshot.py:464-515): VCI IQ history -> doi chieu close voi
    dchart, lech > 0.05 hoac < 20 phien chung hoac phien cuoi VCI khong
    co trong dchart -> BO QUA rieng chi so do.

    KHAC ban EOD: neu dchart co phien HOM NAY (VCI IQ chua cap nhat
    trong phien), nen formed duoc noi vao cuoi -> chart 1D chi so nhay
    theo phien (dung chat nhu PA-3b voi ma co phieu). Suat slow 17:00
    van la ban chot VCI, ghi de phia sau."""
    from datetime import datetime, timezone

    if today is None:
        from datetime import timedelta
        today = datetime.now(timezone(timedelta(hours=7))).date().isoformat()
    out, n_live = {}, 0
    for file_sym, vci_name, dch_sym in INDEX_OHLCV_MAP:
        try:
            by_date = {}
            for r in df.vci_index_history(vci_name, limit):
                if r.get("date") and r.get("close") is not None:
                    by_date[r["date"]] = {
                        "t": r["date"], "o": r.get("open"),
                        "h": r.get("high"), "l": r.get("low"),
                        "c": r.get("close"),
                        "v": int(r.get("volume") or 0)}
            rows = [by_date[x] for x in sorted(by_date)]
            ref = _dchart_index_bars(dch_sym)
            common = [x for x in sorted(by_date) if x in ref]
            worst = max((abs(by_date[x]["c"] - ref[x]["c"]) for x in common),
                        default=None)
            if not rows or len(common) < 20 or worst is None \
                    or worst > 0.05 or rows[-1]["t"] not in ref:
                print(f"[ohlcv-index] {file_sym}: BO QUA ({len(rows)} phien "
                      f"VCI, doi chung {len(common)}, lech close max={worst})",
                      flush=True)
                continue
            if today in ref and today > rows[-1]["t"]:
                rows.append(ref[today])       # nen hom nay dang formed
                n_live += 1
            out[file_sym] = rows[-limit:]
        except Exception as e:  # noqa: BLE001
            print(f"[ohlcv-index] {file_sym} loi: {str(e)[:120]}", flush=True)
    payload = {"ohlcv": out,
               "_prov": {"source": "modal:ohlcv_index(vci-iq+dchart-xcheck)",
                         "retrieved_at": datetime.now(timezone.utc).isoformat(),
                         "unit": "DIEM"}}
    print(f"[ohlcv-index] {len(out)}/{len(INDEX_OHLCV_MAP)} chi so, "
          f"{n_live} nen formed {today}", flush=True)
    return payload


# ---- PA-4a (03/11): "phat nen theo bo thu" (Henrry Chot 14:43) --------------
# PA-3b lay nen hom nay TU KBS luc publish (rt.ohlcv), KHONG phai bo thu.
# Bo thu modal (`stock-tick-collector`) DA ghi 1m buckets -> R2
# `market/intraday/<SYM>_1m.json` (worker stock.js:1886, lane tick_live,
# moi 30s). PA-4a: doc bucket 1m cua bo thu, rollup thanh 1D (o=first,
# h=max, l=min, c=last, v=sum), ROI ghi de/nen vao dong cuoi payload KBS.
# History (500 phien) van tu KBS — bo thu chua co. Chi so VAN thuoc PA-3c
# (VCI+dchart) — bo thu CHUA co index buckets (see REPORT.md BLOCKED).
#
# Don vi: bucket gia = DONG (e.g. FPT o=50300) -> chart ky NGHIN_VND
# (50.3), chia 1000. Volume GIU NGUYEN (co phieu).
# Fallback: ma ngoai universe B200 42 (41/47 QU tru B200) hoac loi doc R2
# -> GIU nen formed KBS (khong bao gio rong dong cuoi).


def _r2_get_json(bucket_key: str):
    """Doc R2 object (vi du 'market/intraday/FPT_1m.json') qua CF API.

    Worker luu voi tien to 'stock/' (stock.js:35 `env.DATA.put('stock/'+key,...)`,
    R2_PREFIX 'stock/' trong stock_config.py:38) — thienvao o day.
    Token: CF_TOKEN (cung bien book_processor dung, da co trong secret
    pocket-personal) — fallback CF_API_TOKEN neu secret doi ten sau nay.
    Khong co token hoac loi -> tra None (ben goi xu ly fallback)."""
    import json
    import urllib.request

    token = os.environ.get("CF_TOKEN", "") or os.environ.get("CF_API_TOKEN", "")
    if not token:
        return None
    acct = os.environ.get("CF_ACCOUNT_ID",
                          "25b2327e932d26e5487c2ba8ad058932")
    bucket = os.environ.get("CF_R2_BUCKET", "english-lab-data")
    prefix = os.environ.get("CF_R2_PREFIX", "stock/")
    url = (f"https://api.cloudflare.com/client/v4/accounts/{acct}"
           f"/r2/buckets/{bucket}/objects/{prefix}{bucket_key}")
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("User-Agent", "Mozilla/5.0 (PA-4a)")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except Exception:  # noqa: BLE001 — 404/token/thieu file/JSON hong
        return None


def collector_today_bar_1m(sym: str, today_iso: str, reader=_r2_get_json):
    """Rollup 1m bucket cua BO THU -> 1D bar hom nay (ICT). None neu
    thieu bucket / tong V<=0 / doc R2 loi.

    DON VI: bucket _1m.json cua modal collector DA o NGHIN_VND
    (giong KBS) — kiem 03/11: FPT bucket 09:15 o=50.3/h=50.8/c=50.8,
    14:45 c=50.4 (KBS C=50.4). KHONG chia 1000. Ban goc chia /1000
    (tuong bucket la DONG) -> nen overlay nho hon 1000 lan (0.0504),
    Plan bat duoc o trial VM 03/11 (FPT/VCB/HPG/MWG deu lech x1000)."""
    doc = reader(f"market/intraday/{sym}_1m.json")
    rows = (doc or {}).get("rows") or []
    today = [r for r in rows if isinstance(r, dict)
             and str(r.get("t", ""))[:10] == today_iso]
    if not today:
        return None
    o = today[0].get("o")
    c = today[-1].get("c")
    hi = [r.get("h") for r in today if r.get("h") is not None]
    lo = [r.get("l") for r in today if r.get("l") is not None]
    vol = sum(int(r.get("v") or 0) for r in today)
    if o is None or c is None or not hi or not lo or vol <= 0:
        return None
    return {"t": today_iso,
            "o": o, "h": max(hi),
            "l": min(lo), "c": c,
            "v": vol, "_n_buckets": len(today)}


def apply_collector_today(payload: dict, today_iso: str,
                          bar_fn=collector_today_bar_1m) -> dict:
    """Ghi de/append dong `t == today_iso` trong payload['ohlcv'][sym]
    bang rollup cua bo thu. Ma loi/thieu -> GIU nguyen KBS formed.
    Return {sym: n_buckets} de lane log."""
    stats = {}
    for sym in list(payload.get("ohlcv", {})):
        try:
            bar = bar_fn(sym, today_iso)
        except Exception:  # noqa: BLE001 — overlay loi khong chan POST
            continue
        if bar is None:
            continue
        clean = {k: v for k, v in bar.items() if not k.startswith("_")}
        rows = payload["ohlcv"][sym]
        hit = False
        for i, r in enumerate(rows):
            if r.get("t") == today_iso:
                rows[i] = clean
                hit = True
                break
        if not hit:
            rows.append(clean)
        stats[sym] = bar["_n_buckets"]
    prov = payload.setdefault("_prov", {})
    prov["collector_overlay"] = (
        f"{len(stats)}/{len(payload.get('ohlcv', {}))} ma"
        + (f" [{','.join(sorted(stats))}]" if stats else ""))
    return stats



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
    BUCKET = os.environ.get("CF_R2_BUCKET", "english-lab-data")
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


# ==================== FINHAY — doi chieu gia (bo sung 03/11) ====================
# TASK muc 1: moi 15 phut trong gio phien (09:00-15:00 ICT = 02:00-08:00 UTC, T2-T6),
# lay gia Finhay cua 47 ma QUOTE_UNIVERSE (1 goi `symbols=` batch — da do 03/11: tra du
# 47/47, ~3.1s) va so voi gia he thong doc tu /api/stock/quote (tuc quotes.json).
# LUAT: Finhay la chuan DOI CHIEU, khong phai nguon chart/chi so — lane realtime
# (stock_snapshot/indices/PA-3b/3c/4a) giuyen vo, khong thay doi.
# Fail-open: Finhay loi / ngoai gio phien -> in 1 dong, return None, KHONG crash cron.
# canh bao: ALERT cung ma lap lai >= 2 luot lien tiep -> day len /api/internal/modal-alert
# (Telegram) dung ham co san, khong mo kenh bao cao moi.
FINHAY_ALERT_URL = os.environ.get(
    "STOCKAPP_ALERT_URL", "https://lethanhdong.one/api/internal/modal-alert")


