"""
Modal cron jobs for Pocket Personal (k1 Section 2).

4 scheduled functions (2 o day + 2 lane thi truong o cac doan duoi):
1. book_processor  - daily 17:00 +07: process PDF uploads from R2 (English Lab Books)
2. d1_backup        - daily: backup D1 to Modal Volume (keep 7 versions)
   (realtime_poller da xoa 28/10, lenh Henrry 17:35; thay bang doi ung InstaBox — xem thiet ke 28/10.)
   (publish_snapshot da xoa 28/10 de don 1 suat lich Modal; code con trong git.)

NHAP BUOC 2 (01/11, board-vci-wiring): +1 ham `stock_snapshot` tren stock_image
  — consumer DAU TIEN goi bundle /opt/direct_fetch.py (vnd_index_snapshot +
  vci_symbols). CHUA hen lich, CHUA deploy; xem work/CONSUMER_SPEC.md.
  (P0 02/11 da hen lich */5 trong gio phien cho stock_snapshot.)

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


# Persistent volume for state (D1 backups, temp files)

# Image with all dependencies


# (Nhat ban nhap: dinh nghia `app` day len truoc khoai wiring duoi day vi
#  no dung @app.function — thu tu nay khong anh huong Modal.)

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



def publish_ohlcv_daily(symbols: tuple = QUOTE_UNIVERSE):
    """PA-3a: refresh nen ngay (chart 1D) mot lan moi phien, sau EOD.

    Ham hep, CHI phat lane `ohlcv` — khong khoi phuc nguyen
    publish_snapshot (de khong keo theo indices/quotes_patch da bi
    khai tu 28/10) va khong cham lane intraday (PA-1 lo)."""
    base_dir = os.environ.get("DIRECT_FETCH_DIR", DIRECT_FETCH_DIR)
    _use_direct_fetch(base_dir)               # nap bundle tu /opt
    import source_router as rt                # /opt da nam tren sys.path

    payload = build_ohlcv_daily_payload(symbols, rt)
    if not payload["ohlcv"]:
        # Run that bai hoan toan -> raise de dashboard Modal hien Failed
        # (same policy publish_snapshot dung cho lane cua no).
        raise RuntimeError("publish_ohlcv_daily: khong lay duoc nen ma nao")
    result = _post_publish(payload)
    print(f"publish_ohlcv_daily: {len(payload['ohlcv'])} ma -> {result}",
          flush=True)
    return result


def publish_ohlcv_intraday(symbols: tuple = QUOTE_UNIVERSE):
    """PA-3b+PA-4a: refresh nen ngay trong phien, nen hom nay theo BO THU.

    Tai sao cron rieng, khong them ohlcv vao stock_snapshot:
      - stock_snapshot chay */5 = 47 lan/gi o; nhung 47x rt.ohlcv moi 5
        phut la nang can nguon (KBS) khong can thiet -> */15 du cho
        "nen formed" nhay theo phien.
      - Tach lane giu don lap that bai: loi ohlcv khong lam chet lane
        quotes/indices realtime.
    Payload rong -> KHONG POST (giu file cu), khac voi EOD (EOD raise de
    dashboard Modal bao Failed vi no la ban chot cua ca phien)."""
    base_dir = os.environ.get("DIRECT_FETCH_DIR", DIRECT_FETCH_DIR)
    _use_direct_fetch(base_dir)               # nap bundle tu /opt
    import source_router as rt                # /opt da nam tren sys.path

    payload = build_ohlcv_daily_payload(symbols, rt)
    MIN_BARS = 100                            # >= 100 phien moi du de ghi de
    kept = {s: b for s, b in payload["ohlcv"].items() if len(b) >= MIN_BARS}
    dropped = len(payload["ohlcv"]) - len(kept)
    if dropped:
        print(f"publish_ohlcv_intraday: bo {dropped} ma nen < {MIN_BARS} phien "
              f"(tranh wipe lich su)", flush=True)
    payload["ohlcv"] = kept
    if not kept:
        print("publish_ohlcv_intraday: khong co nen du dai -> giu file cu "
              "(khong POST)", flush=True)
        return {"skipped": True, "reason": "no_full_history"}
    # PA-4a: overlay nen hom nay tu bo thu (1m buckets). Loi -> giu KBS.
    try:
        from datetime import datetime, timedelta, timezone
        today_iso = datetime.now(timezone(timedelta(hours=7))).date().isoformat()
        stats = apply_collector_today(payload, today_iso)
        print(f"publish_ohlcv_intraday: PA-4a collector overlay "
              f"{len(stats)}/{len(kept)} ma, hom nay={today_iso}", flush=True)
    except Exception as e:  # noqa: BLE001 — loi overlay khong chan POST
        print(f"publish_ohlcv_intraday: PA-4a overlay loi "
              f"({str(e)[:120]}) -> giu KBS formed", flush=True)
    result = _post_publish(payload)
    print(f"publish_ohlcv_intraday: {len(kept)} ma -> {result}", flush=True)
    return result


def publish_ohlcv_index_intraday():
    """PA-3c: refresh nen ngay chi so trong phien (chart 1D chi so).

    KHONG cham stock_snapshot (lane gia realtime */5 dang chay dung,
    nen chi so Van nam ngoai no nhu PA-3b) va KHONG cham suat slow
    17:00 cua collector (ban chot VCI, ghi de phia sau)."""
    base_dir = os.environ.get("DIRECT_FETCH_DIR", DIRECT_FETCH_DIR)
    _use_direct_fetch(base_dir)               # nap bundle tu /opt
    import direct_fetch as df                 # /opt da nam tren sys.path

    payload = build_index_ohlcv_payload(df)
    if not payload["ohlcv"]:
        print("publish_ohlcv_index_intraday: khong chi so nao qua gate -> "
              "giu file cu (khong POST)", flush=True)
        return {"skipped": True, "reason": "no_index_passed_xcheck"}
    result = _post_publish(payload)
    print(f"publish_ohlcv_index_intraday: {len(payload['ohlcv'])} chi so "
          f"-> {result}", flush=True)
    return result


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

    # (LightVela: local disk is persistent, no volume commit)




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
    backup_dir = os.environ.get("CRON_BACKUP_DIR", os.path.expanduser("~/backups/d1"))
    os.makedirs(backup_dir, exist_ok=True)
    key = os.path.join(backup_dir, f"{today}.json")
    with open(key, "wb") as f:
        f.write(data)
    print(f"Backup: {len(tables)} tables, {len(data)} bytes -> {key}")

    olds = sorted(glob.glob(os.path.join(backup_dir, "*.json")))
    for old_key in olds[:-KEEP]:
        os.remove(old_key)
        print(f"  deleted old: {old_key}")

    # (LightVela: local disk is persistent, no volume commit)


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


def finhay_price_crosscheck():
    sys.path.insert(0, "/opt")
    import finhay_crosscheck

    doc = finhay_crosscheck.run(finhay_crosscheck.parse_cfg())
    if not doc:
        return None
    s = doc["summary"]
    print(f"finhay_price_crosscheck: compared={s['compared']} ok={s['counts'].get('ok', 0)} "
          f"warn={s['counts'].get('warn', 0)} alert={len(s['alert_symbols'])} "
          f"escalated={s['escalated_symbols']} maxDiff={s['max_abs_diff_pct']}% "
          f"refFlags={s['ref_flags']} calls={s['finhay_calls']}", flush=True)
    if s["escalated_symbols"]:
        _finhay_alert(
            "finhay_price_crosscheck",
            f"{len(s['escalated_symbols'])} ma lech gia >=2 luot lien tiep: "
            + ", ".join(
                f"{r['symbol']} {r['diff_vnd']}d ({r['diff_pct']}%)"
                for r in doc["rows"] if r.get("escalated")),
        )
    return s


def _finhay_alert(fn: str, detail: str) -> None:
    """Gui canh bao qua /api/internal/modal-alert (Worker -> Telegram), cung secret
    nhu _post_publish. Loi mang thi lang — canh bao khong duoc lam chet luot doi chieu."""
    import json
    import urllib.request

    secret = os.environ.get("STOCK_PUBLISH_SECRET", "")
    if not secret:
        print("finhay_alert: khong co STOCK_PUBLISH_SECRET -> bo qua", flush=True)
        return
    body = json.dumps({"fn": fn, "detail": detail[:900]}).encode()
    req = urllib.request.Request(FINHAY_ALERT_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "X-Publish-Secret": secret,
                                          "X-Internal-Secret": secret,
                                          "User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"finhay_alert -> {resp.read().decode()[:120]}", flush=True)
    except Exception as e:  # noqa: BLE001 - fail-open
        print(f"finhay_alert loi (fail-open): {str(e)[:120]}", flush=True)


# ==================== LightVela runner (no Modal) ====================
# Secrets: read from env at runtime. STOCK_PUBLISH_SECRET may also come
# from a raw-value file (0600) via STOCK_PUBLISH_SECRET_FILE; the file
# content is used as-is (stripped), never printed or logged.

def _load_publish_secret():
    """Ensure STOCK_PUBLISH_SECRET is in env, loading it from a raw-value
    file when the env var is absent. Returns True when available."""
    if os.environ.get("STOCK_PUBLISH_SECRET"):
        return True
    path = os.environ.get(
        "STOCK_PUBLISH_SECRET_FILE",
        os.path.expanduser("~/.stockapp_publish"))
    try:
        with open(path, "r", encoding="utf-8") as fh:
            val = fh.read().strip()
        if val:
            os.environ["STOCK_PUBLISH_SECRET"] = val
            return True
    except OSError:
        pass
    return False


def _run_ohlcv(mode: str):
    """Merged OHLCV (PA-3b + PA-3c + daily EOD) in ONE function.

    intraday: stocks (MIN_BARS guard + PA-4a collector overlay) + indices,
      POST stocks then indices; empty -> skip gracefully (exit 0).
    eod: stocks only (no guard, no overlay — pure KBS, the EOD final);
      empty -> exit 1 (strict, like the old publish_ohlcv_daily which
      raised so the dashboard showed Failed). Indices are NOT posted in
      eod mode: their EOD final comes from the collector slow run."""
    _load_publish_secret()
    base_dir = os.environ.get("DIRECT_FETCH_DIR", DIRECT_FETCH_DIR)
    _use_direct_fetch(base_dir)
    import source_router as rt

    from datetime import datetime, timedelta, timezone
    today_iso = datetime.now(timezone(timedelta(hours=7))).date().isoformat()

    if mode == "eod":
        payload = build_ohlcv_daily_payload(QUOTE_UNIVERSE, rt)
        if not payload["ohlcv"]:
            print("ohlcv eod: khong lay duoc nen ma nao (strict, exit 1)",
                  flush=True)
            return 1
        result = _post_publish(payload)
        print(f"ohlcv eod: {len(payload['ohlcv'])} ma -> {result}", flush=True)
        return 0

    # intraday
    import direct_fetch as df
    payload = build_ohlcv_daily_payload(QUOTE_UNIVERSE, rt)
    MIN_BARS = 100
    kept = {s: b for s, b in payload["ohlcv"].items() if len(b) >= MIN_BARS}
    dropped = len(payload["ohlcv"]) - len(kept)
    if dropped:
        print(f"ohlcv intraday: bo {dropped} ma nen < {MIN_BARS} phien",
              flush=True)
    payload["ohlcv"] = kept
    if kept:
        try:
            stats = apply_collector_today(payload, today_iso)
            print(f"ohlcv intraday: PA-4a collector overlay "
                  f"{len(stats)}/{len(kept)} ma, hom nay={today_iso}",
                  flush=True)
        except Exception as e:  # noqa: BLE001 - overlay loi khong chan POST
            print(f"ohlcv intraday: PA-4a overlay loi "
                  f"({str(e)[:120]}) -> giu KBS formed", flush=True)
        result = _post_publish(payload)
        print(f"ohlcv intraday: {len(kept)} ma -> {result}", flush=True)
    else:
        print("ohlcv intraday: khong co nen du dai -> giu file cu",
              flush=True)

    idx_payload = build_index_ohlcv_payload(df)
    if not idx_payload["ohlcv"]:
        print("ohlcv intraday: khong chi so nao qua gate -> giu file cu",
              flush=True)
        return 0
    result = _post_publish(idx_payload)
    print(f"ohlcv intraday: {len(idx_payload['ohlcv'])} chi so -> {result}",
          flush=True)
    return 0


def _run_finhay_crosscheck():
    """Standalone finhay crosscheck + the escalation alert the old Modal
    function did (the module's own main() does not send it)."""
    _load_publish_secret()
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import finhay_crosscheck

    doc = finhay_crosscheck.run(finhay_crosscheck.parse_cfg())
    if not doc:
        return 0
    s = doc["summary"]
    print(f"finhay_price_crosscheck: compared={s['compared']} "
          f"ok={s['counts'].get('ok', 0)} warn={s['counts'].get('warn', 0)} "
          f"alert={len(s['alert_symbols'])} "
          f"escalated={s['escalated_symbols']} "
          f"maxDiff={s['max_abs_diff_pct']}% refFlags={s['ref_flags']} "
          f"calls={s['finhay_calls']}", flush=True)
    if s["escalated_symbols"]:
        _finhay_alert(
            "finhay_price_crosscheck",
            f"{len(s['escalated_symbols'])} ma lech gia >=2 luot lien tiep: "
            + ", ".join(
                f"{r['symbol']} {r['diff_vnd']}d ({r['diff_pct']}%)"
                for r in doc["rows"] if r.get("escalated")),
        )
    return 0


_LOCK_KEEPALIVE = []


def _acquire_job_lock(job):
    """flock-style singleton per job name (F5, IMPL-PLAN B1).

    Hom nay LightVela la owner DUY NHAT cua moi job nen day chi la no-op.
    Muc dich: bao hiem cho mot cutover tuong lai khi hai runtime (Modal +
    LightVela) cung goi 1 lane — ngan hai process ghi de quotes.json /
    phien ban cua nhau (lost-update). Non-blocking:

      - tra ve file handle dang GIU LOCK → chay job thong thuong (fd duoc
        giu trong _LOCK_KEEPALIVE den khi process thoat, flock tu dong
        Release khi dong file/diet process);
      - tra "BUSY" → mot instance khac dang chay, bo qua luot nay;
      - tra None → khong thiet lap duoc lock (khong co thu muc / quyen).
        FAIL-OPEN: van chay job — freeze lane con hai hon chen lant, va
        hom nay lock chi la bao hiem nen that bai cap lock khong duoc
        dung du lieu."""
    import fcntl
    lock_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".locks")
    try:
        os.makedirs(lock_dir, exist_ok=True)
        fh = open(os.path.join(lock_dir, f"{job}.lock"), "w")
    except OSError:
        return None
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return "BUSY"
    _LOCK_KEEPALIVE.append(fh)
    return fh


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(
        description="Pocket Personal crons (LightVela, no Modal)")
    sub = ap.add_subparsers(dest="job", required=True)
    sub.add_parser("stock_snapshot")
    o = sub.add_parser("ohlcv")
    o.add_argument("--mode", choices=["intraday", "eod"], default="intraday")
    m = sub.add_parser("maintenance")
    m.add_argument("--mode", choices=["books", "backup"], required=True)
    sub.add_parser("finhay_crosscheck")
    args = ap.parse_args(argv)

    lock = _acquire_job_lock(args.job)
    if lock == "BUSY":
        print(f"[cron_jobs] {args.job}: mot instance khac dang giu flock, "
              f"bo qua luot chay nay (tranh ghi de cua hai runtime)",
              flush=True)
        return 0

    if args.job == "stock_snapshot":
        _load_publish_secret()
        stock_snapshot()
        return 0
    if args.job == "ohlcv":
        return _run_ohlcv(args.mode)
    if args.job == "maintenance":
        if args.mode == "books":
            book_processor()
        else:
            d1_backup()
        return 0
    if args.job == "finhay_crosscheck":
        return _run_finhay_crosscheck()
    return 2


if __name__ == "__main__":
    sys.exit(main())
