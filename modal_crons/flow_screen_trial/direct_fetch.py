#!/usr/bin/env python3
"""Fetch truc tiep tu upstream API, KHONG qua vnstock.

Nguon (dang la public API ma web/app cua chinh cac cong ty chung khoan goi):
- VietCap IQ:  https://iq.vietcap.com.vn/api/iq-insight-service/v1/...
- KBS IIS:     https://kbbuddywts.kbsec.com.vn/iis-server/investment/...

Phat hien tu viec mo binary vnstock 5.1.0 (_core.abi3.so) + source 4.0.9.
Muc dich: tu chu du lieu (chien luoc 4 lop) — vnstock chi la "duong ong thay duoc".

Quy tac:
- Chi GET cac endpoint public, volume thap (nhu trinh duyet thuong).
- Khong vuot auth, khong ne anti-bot: endpoint nao doi auth thi bo qua, ghi ro.
- Tra ve list/dict thuan Python (khong phu thuoc pandas).

Tai lieu chi tiet: ~/workspace/your_files/vnstock-v5-binary-chitiet.md
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import time
import http.client
import urllib.request
import urllib.parse

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
TIMEOUT = 25


def _get(url: str, params: dict | None = None, retries: int = 2) -> dict:
    """GET JSON, tu dong giai nen gzip, retry don gian."""
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": UA,
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip, deflate",
                },
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                try:
                    raw = resp.read()
                except http.client.IncompleteRead as e:
                    raw = e.partial  # proxy cat connection — lay phan da nhan
                enc = resp.headers.get("Content-Encoding", "")
                if "gzip" in enc:
                    import gzip

                    try:
                        raw = gzip.decompress(raw)
                    except Exception:
                        # gzip dut doan -> bo qua lan nay, retry
                        raise
                return json.loads(raw.decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - retry moi thu
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET failed after {retries + 1} tries: {url}: {last_err}")


# ---------------------------------------------------------------- VietCap IQ

_VCI_IQ = "https://iq.vietcap.com.vn/api/iq-insight-service/v1"


def vci_shareholder_rows(symbol: str) -> list[dict]:
    """Co dong + lanh dao kem so CP tu VCI IQ (duong vnstock ban 4):
    GET /v1/company/{sym}/shareholder. Moi dong: ownerName, ownerCode,
    positionName (co neu la lanh dao), quantity, percentage (PHAN SO
    0..1), ownerType (INDIVIDUAL/CORPORATE), updateDate.
    Parity mo lai Dot 4+3 (21/10/2026): so dong + quantity + ca moc
    updateDate khop TUYET DOI ban vnstock 5 o FPT/VCB/HPG/MBB/MWG."""
    data = _get(f"{_VCI_IQ}/company/{symbol}/shareholder")
    rows = data.get("data")
    return rows if isinstance(rows, list) else []


def vci_relationship(symbol: str) -> dict:
    """Cong ty con + lien ket tu VCI IQ: GET /v1/company/{sym}/
    relationship -> {subsidiaries: [...], affiliates: [...]}; moi
    dong co rightOrganCode (= sub_symbol cua vnstock, khop tuyet doi),
    rightOrganNameVi, ownedQuantity, ownedPercentage (phan so)."""
    data = _get(f"{_VCI_IQ}/company/{symbol}/relationship")
    d = data.get("data")
    return d if isinstance(d, dict) else {}


def vci_index_history(index: str = "VNINDEX", limit: int = 30) -> list[dict]:
    """Lich su chi so: ngay, open/high/low/close, volume, value.

    Tuong duong route: market.index.ohlcv / market.index.price_history
    """
    data = _get(
        f"{_VCI_IQ}/market-indices/history",
        {"index": index, "page": 0, "size": limit},
    )
    content = (data.get("data") or {}).get("content") or []
    out = []
    for r in content:
        out.append(
            {
                "date": r.get("tradingDate"),
                "open": r.get("openIndex"),
                "high": r.get("highestIndex"),
                "low": r.get("lowestIndex"),
                "close": r.get("closeIndex") or r.get("indexValue"),
                "change": r.get("indexChange"),
                "pct_change": r.get("percentIndexChange"),
                "volume": r.get("totalMatchVolume"),
                "value": r.get("totalMatchValue"),
            }
        )
    return out


_DCHART = "https://dchart-api.vndirect.com.vn/dchart/history"
# Chi so app -> ma tren VNDirect dchart (HNX/UPCOM khong co hau to "Index")
_VND_INDEX_SYMBOLS = [
    ("VNINDEX", "VNINDEX"),
    ("VN30", "VN30"),
    ("HNXIndex", "HNX"),
    ("UPCOMIndex", "UPCOM"),
    # Chi so nganh (Dot B, Chot 22/10) — kenh dchart da kiem chung 21/10
    # + 22/10: du 6 ma, nen ngay song, cung dang STOCKMARKET_INDEX_SECTOR.
    ("VNFIN", "VNFIN"),
    ("VNREAL", "VNREAL"),
    ("VNIT", "VNIT"),
    ("VNIND", "VNIND"),
    ("VNMAT", "VNMAT"),
    ("VNCONS", "VNCONS"),
]


def vnd_index_snapshot() -> list[dict]:
    """Snapshot 4 chi so tu VNDirect dchart (feed bieu do truc tiep, cap nhat theo phut).

    2026-10-20: thay vci_index_history cho khau realtime — VCI IQ history la
    feed EOD (cham 1 ngay, sap xep GIAM dan moi nhat truoc) nen poller boc
    nham so cua phien cu lam so hom nay. dchart tra nen ngay (resolution=D):
    nen cuoi = hom nay (close = gia tri hien tai, volume = tong phien),
    nen truoc = phien hom qua lam moc tinh change.
    KY THUAT: chi gui User-Agent — gui kem "Accept: application/json" la
    server tra 406. Loi tung chi so khong duoc lam chet cac chi so con lai.
    Tra ve rows dung contract app: {symbol, close, volume, time, change,
    pct_change} + prev_close/prev_date de poller doi chieu cheo voi VCI.
    """
    from datetime import datetime, timezone, timedelta

    now = int(time.time())
    frm = now - 10 * 86400
    out = []
    for app_sym, dc_sym in _VND_INDEX_SYMBOLS:
        url = f"{_DCHART}?symbol={dc_sym}&resolution=D&from={frm}&to={now}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
                if "gzip" in resp.headers.get("Content-Encoding", ""):
                    import gzip

                    raw = gzip.decompress(raw)
            d = json.loads(raw)
            ts, cs, vs = d.get("t") or [], d.get("c") or [], d.get("v") or []
            os_, hs, ls = d.get("o") or [], d.get("h") or [], d.get("l") or []
            if len(ts) < 2 or len(cs) < 2:
                continue

            def _last_f(arr):
                try:
                    return float(arr[-1])
                except Exception:  # noqa: BLE001
                    return None
            vn = timezone(timedelta(hours=7))
            last_date = datetime.fromtimestamp(ts[-1], vn).date().isoformat()
            prev_date = datetime.fromtimestamp(ts[-2], vn).date().isoformat()
            close = float(cs[-1])
            prev_close = float(cs[-2])
            chg = round(close - prev_close, 2)
            pct = round(chg / prev_close * 100, 2) if prev_close else 0
            out.append(
                {
                    "symbol": app_sym,
                    "close": close,
                    "open": _last_f(os_),
                    "high": _last_f(hs),
                    "low": _last_f(ls),
                    "volume": float(vs[-1]) if vs else None,
                    "time": last_date,
                    "change": chg,
                    "pct_change": pct,
                    "prev_close": prev_close,
                    "prev_date": prev_date,
                }
            )
        except Exception:  # noqa: BLE001 — loi 1 chi so khong duoc lam chet cac chi so con lai
            continue
    return out


def vci_company(symbol: str) -> dict:
    """Snapshot cong ty: gia hien tai, von hoa... (khong auth)."""
    data = _get(f"{_VCI_IQ}/company/{symbol.upper()}")
    return data.get("data") or {}


def vci_events_symbol(symbol: str, days_back: int = 3300,
                      days_fwd: int = 90) -> list:
    """Su kien cua 1 ma tu VCI IQ (/v1/events?ticker=..., phan trang
    page/size, moi nhat truoc; cua so mac dinh ~9 nam — vnstock boc
    lai dung nguon nay nhung IQ cho loc thang theo ticker).
    Tra list item tho (camelCase)."""
    from datetime import date, timedelta
    today = date.today()
    frm = (today - timedelta(days=days_back)).isoformat()
    to = (today + timedelta(days=days_fwd)).isoformat()
    out, page = [], 0
    while True:
        d = _get(f"{_VCI_IQ}/events",
                 {"fromDate": frm, "toDate": to,
                  "ticker": symbol.upper(), "page": page, "size": 1000})
        data = (d or {}).get("data") or {}
        content = data.get("content") or []
        out.extend(content)
        if data.get("last") or not content:
            return out
        page += 1


# ---------------------------------------------------------------- KBS

_KBS_IIS = "https://kbbuddywts.kbsec.com.vn/iis-server/investment"

# Loai bao cao tai chinh KBS
REPORT_TYPES = {
    "CDKT": "balance_sheet",  # Can doi ke toan
    "KQKD": "income_statement",  # Ket qua kinh doanh
    "LCTT": "cash_flow",  # Luu chuyen tien te
    "CSTC": "ratios",  # Chi so tai chinh
}


def kbs_financial(
    symbol: str,
    report_type: str = "KQKD",
    period_type: int = 2,
    page_size: int = 4,
) -> dict:
    """Bao cao tai chinh tu KBS.

    report_type: CDKT | KQKD | LCTT | CSTC
    period_type: 1 = nam, 2 = quy
    Tra ve: {"periods": [...], "rows": [{"name", "name_en", "level", "values": [...]}, ...]}

    Moi values[i] ung voi periods[i] (Value1..ValueN theo thu tu Head).
    Don vi: nghin VND (unit=1000) — giong vnstock 4.0.9.
    """
    rt = report_type.upper()
    if rt not in REPORT_TYPES:
        raise ValueError(f"report_type phai la mot trong {list(REPORT_TYPES)}")
    params: dict = {
        "page": 1,
        "pageSize": page_size,
        "type": rt,
        "unit": 1000,
        "termtype": period_type,
        "languageid": 1,
    }
    if rt == "LCTT":
        # Cash flow dung ten param khac (theo source 4.0.9)
        params.pop("languageid")
        params["code"] = symbol.upper()
        params["termType"] = period_type
    data = _get(f"{_KBS_IIS}/stock/finance-info/{symbol.upper()}", params)

    periods = []
    for h in data.get("Head") or []:
        periods.append(
            {
                "term": h.get("TermCode"),
                "year": h.get("YearPeriod"),
                "begin": h.get("PeriodBegin"),
                "end": h.get("PeriodEnd"),
                "report_date": (h.get("ReportDate") or "")[:10],
                "united": h.get("United"),
                "audited": h.get("AuditedStatus"),
            }
        )
    rows = []
    content = data.get("Content") or {}
    for _component, items in content.items():
        for it in items or []:
            values = [it.get(f"Value{i + 1}") for i in range(len(periods))]
            rows.append(
                {
                    "name": (it.get("Name") or "").strip(),
                    "name_en": (it.get("NameEn") or "").strip(),
                    "level": it.get("Levels"),
                    "parent_id": it.get("ParentReportNormID"),
                    "values": values,
                }
            )
    return {"periods": periods, "rows": rows}


def kbs_find_row(fin: dict, keyword: str) -> dict | None:
    """Tim dong bao cao theo tu khoa (tieng Viet hoac Anh)."""
    kw = keyword.lower()
    for r in fin["rows"]:
        if kw in r["name"].lower() or kw in r["name_en"].lower():
            return r
    return None


# ---------------------------------------------------------------- CLI test nhanh

# ---------------------------------------------------------------- KBS OHLCV / price board / company

_KBS_INTERVAL = {
    "1m": "1P", "5m": "5P", "15m": "15P", "30m": "30P",
    "1h": "60P", "1d": "day", "1w": "week", "1M": "month",
}


def kbs_ohlcv(
    symbol: str,
    start: str,
    end: str,
    interval: str = "1d",
) -> list[dict]:
    """OHLCV co phieu tu KBS. start/end: 'YYYY-MM-DD'.

    Tuong duong route: market.equity.ohlcv
    """
    suffix = _KBS_INTERVAL.get(interval, "day")

    def fmt(d: str) -> str:  # YYYY-MM-DD -> DD-MM-YYYY
        y, m, dd = d.split("-")
        return f"{dd}-{m}-{y}"

    data = _get(
        f"{_KBS_IIS}/stocks/{symbol.upper()}/data_{suffix}",
        {"sdate": fmt(start), "edate": fmt(end)},
    )
    rows = data.get(f"data_{suffix}") or []
    return [
        {
            "time": r.get("t"),
            "open": r.get("o"),
            "high": r.get("h"),
            "low": r.get("l"),
            "close": r.get("c"),
            "volume": r.get("v"),
            "value": r.get("va"),
        }
        for r in rows
    ]


def _kbs_depth(r: dict, pk: str, vk: str):
    """3 buoc gia KBS (B/V mua, S/U ban) -> [[gia, KL], ...] chuan so.

    Sua goc 22/10/2026: truoc day adapter tra tuple tho (gia co the la
    chuoi "34150.0") va giu ca buoc chet (gia None/0) -> frontend
    Number(tuple) = NaN in thang ra trang chi tiet. Chuan moi: gia/KL
    la so that, buoc khong gia bi loai, ca phia rong -> None
    (missing_policy='na': thieu thi ghi thieu, khong bia so).
    """
    steps = []
    for i in (1, 2, 3):
        try:
            p = float(r.get(f"{pk}{i}"))
        except (TypeError, ValueError):
            continue
        if p <= 0:
            continue
        try:
            v = int(float(r.get(f"{vk}{i}")))
        except (TypeError, ValueError):
            v = None
        steps.append([int(p) if p == int(p) else p, v])
    return steps or None


def kbs_price_board(symbols: list[str]) -> dict[str, dict]:
    """Bang gia realtime tu KBS (POST /stock/iss).

    Tuong duong route: market.equity.quote (+ foreign_flow qua FB/FS)
    Tra ve dict {symbol: quote}, quote gom cac field chuan.
    """
    import urllib.request as _urlreq

    url = f"{_KBS_IIS}/stock/iss"
    body = json.dumps({"code": ",".join(s.upper() for s in symbols)}).encode()
    req = _urlreq.Request(
        url,
        data=body,
        headers={
            "User-Agent": UA,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
            "x-lang": "vi",
        },
    )
    last_err = None
    rows: list = []
    for _ in range(3):
        try:
            with _urlreq.urlopen(req, timeout=TIMEOUT) as resp:
                try:
                    raw = resp.read()
                except http.client.IncompleteRead as e:
                    raw = e.partial  # proxy cat connection — lay phan da nhan
                if "gzip" in resp.headers.get("Content-Encoding", ""):
                    import gzip

                    raw = gzip.decompress(raw)
                rows = json.loads(raw.decode("utf-8"))
            last_err = None
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(2)
    if last_err is not None:
        raise RuntimeError(f"kbs_price_board failed: {last_err}")
    out: dict[str, dict] = {}
    for r in rows or []:
        sym = r.get("SB")
        if not sym:
            continue
        out[sym] = {
            "symbol": sym,
            "exchange": r.get("EX"),
            "date": r.get("TD"),
            "time": r.get("IT"),
            "reference": r.get("RE"),
            "floor": r.get("FL"),
            "ceiling": r.get("CL"),
            "open": r.get("OP"),
            "high": r.get("HI"),
            "low": r.get("LO"),
            "close": r.get("CP"),
            "change": r.get("CH"),
            "pct_change": r.get("CHP"),
            "volume": r.get("TT"),
            "value": r.get("TV"),
            "avg_price": r.get("AP"),
            "bid": _kbs_depth(r, "B", "V"),
            "ask": _kbs_depth(r, "S", "U"),
            # Khoi ngoai: FB/FS la KL mua/ban that cua phien.
            # FO/FR KHONG phai gia tri giao dich (sua goc 21/10/2026, doi
            # chieu so that: FPT FO = 49% x co phieu luu hanh, VCB FO =
            # 30% x luu hanh — khop tung co phieu): FO = han muc so huu NN
            # (CP), FR = room con lai (CP). Bang gia KBS khong co gia tri
            # mua/ban NN -> de None; router dien gia tri that tu VCI.
            "foreign_buy_volume": r.get("FB"),
            "foreign_sell_volume": r.get("FS"),
            "foreign_buy_value": None,
            "foreign_sell_value": None,
            "foreign_limit_shares": r.get("FO"),
            "foreign_room_shares": r.get("FR"),
            "foreign_owned_shares": (
                r.get("FO") - r.get("FR")
                if isinstance(r.get("FO"), (int, float))
                and isinstance(r.get("FR"), (int, float))
                else None
            ),
        }
    return out


def kbs_company_profile(symbol: str) -> dict:
    """Ho so cong ty tu KBS. Tuong duong: fundamental.company.info"""
    data = _get(f"{_KBS_IIS}/stockinfo/profile/{symbol.upper()}")
    return data if isinstance(data, dict) else {}


def kbs_company_events(symbol: str, page_size: int = 10) -> list[dict]:
    """Su kien doanh nghiep tu KBS. Tuong duong: fundamental.company.events"""
    data = _get(
        f"{_KBS_IIS}/stockinfo/event/{symbol.upper()}",
        {"l": 1, "p": 1, "s": page_size},
    )
    return data if isinstance(data, list) else []


# ---------------------------------------------------------------- VNDirect finfo

_FINFO = "https://api-finfo.vndirect.com.vn/v4"


def vnd_listing() -> list[dict]:
    """Danh sach ma listed toan thi truong tu VNDirect finfo (TUCHU-95 Dot 2).

    Verify 2026-10-20 bang request that: 1.519 ma, khop tuyet doi
    baseline vnstock theo san (HOSE 406 / HNX 299 / UPCOM 814).
    Chu y: host la api-finfo (host finfo-api cu khong toi duoc),
    q noi dieu kien bang "~" (dau phay lam hong bo loc).
    """
    data = _get(f"{_FINFO}/stocks",
                {"q": "type:STOCK~status:listed", "size": 2000})
    rows = (data or {}).get("data") or []
    out = []
    for r in rows:
        if not r.get("code"):
            continue
        out.append({
            "symbol": r["code"],
            "exchange": r.get("floor"),
            "name": r.get("companyName"),
            "name_en": r.get("companyNameEng"),
            "isin": r.get("isin"),
            "index_code": r.get("indexCode"),
            "listed_date": r.get("listedDate"),
        })
    return out


def finfo_proprietary_day(date_iso: str) -> list[dict]:
    """Tu doanh TOAN THI TRUONG 1 ngay tu VNDirect finfo (3 san).

    Verify 2026-10-20: doi chieu cheo PDF HOSE + Vietstock khop
    100% tren mau. Don vi: dong. HNX thuong tre ~1 ngay, UPCOM
    thua — do dac tinh nguon, khong phai loi.
    KY THUAT QUAN TRONG: phai goi 1 LAN voi size >= totalElements
    (440 ngay 20/10). Phan trang endpoint nay KHONG on dinh (moi
    dong cung 1 ngay -> sort date vo nghia, cac trang chong nhau /
    trung 90%) — ban phan trang tung tra so ma dao dong 111-171.
    Chuan hoa ve shape kho tu doanh: {symbol, floor, trade_date,
    buy_volume, sell_volume, net_volume, buy_value_vnd,
    sell_value_vnd, net_value_vnd}.
    """
    data = _get(f"{_FINFO}/proprietary_trading",
                {"q": f"date:{date_iso}", "sort": "date:desc",
                 "size": 1000}, retries=4)
    total = (data or {}).get("totalElements") or 0
    rows = (data or {}).get("data") or []
    if total and len(rows) < total:
        raise RuntimeError(
            f"finfo proprietary {date_iso}: {len(rows)}/{total} dong "
            "(size 1000 chua du — bao de nang size)")
    out = []
    _seen = set()
    for r in rows:
        if r.get("type") != "STOCK" or not r.get("code"):
            continue
        if r["code"] in _seen:
            continue
        _seen.add(r["code"])
        bv, sv = int(r.get("buyingVol") or 0), int(r.get("sellingVol") or 0)
        bval = int(round(r.get("buyingVal") or 0))
        sval = int(round(r.get("sellingVal") or 0))
        if bv == 0 and sv == 0:
            continue  # dong 0 (ma co trong tap ngay nhung khong GD)
        out.append({
            "symbol": r["code"], "floor": r.get("floor"),
            "trade_date": date_iso,
            "buy_volume": bv, "sell_volume": sv,
            "net_volume": bv - sv,
            "buy_value_vnd": bval, "sell_value_vnd": sval,
            "net_value_vnd": bval - sval,
        })
    return out


def finfo_proprietary_symbol(symbol: str, size: int = 1500) -> list[dict]:
    """Lich su tu doanh cua 1 ma tu VNDirect finfo (dung backfill).
    Cung shape chuan hoa nhu finfo_proprietary_day. Goi 1 lan voi
    size lon (mac dinh 1500 — FPT tong 1.087 dong) vi phan trang
    endpoint nay khong on dinh."""
    data = _get(f"{_FINFO}/proprietary_trading",
                {"q": f"code:{symbol.upper()}", "sort": "date:desc",
                 "size": size}, retries=4)
    total = (data or {}).get("totalElements") or 0
    rows = (data or {}).get("data") or []
    if total and len(rows) < min(total, size):
        raise RuntimeError(
            f"finfo proprietary {symbol}: {len(rows)}/{total} dong")
    out = []
    for r in rows:
        if r.get("type") != "STOCK":
            continue
        bv, sv = int(r.get("buyingVol") or 0), int(r.get("sellingVol") or 0)
        bval = int(round(r.get("buyingVal") or 0))
        sval = int(round(r.get("sellingVal") or 0))
        if bv == 0 and sv == 0:
            continue  # dong 0 — ngay khong phat sinh GD tu doanh
        out.append({
            "symbol": symbol.upper(), "floor": r.get("floor"),
            "trade_date": r.get("date"),
            "buy_volume": bv, "sell_volume": sv,
            "net_volume": bv - sv,
            "buy_value_vnd": bval, "sell_value_vnd": sval,
            "net_value_vnd": bval - sval,
        })
    return out


_VS_BASE = "https://finance.vietstock.vn"


def vietstock_proprietary_day(date_iso: str) -> list[dict]:
    """Tu doanh toan thi truong 1 ngay tu VietstockFinance (du phong /
    doi chieu cho finfo). Co che: GET trang ket-qua-giao-dich bang
    cookie jar an danh -> lay __RequestVerificationToken -> POST
    KQGDGiaoDichTuDoanhPaging cho catID 1=HOSE, 2=HNX, 3=UPCOM.
    Gia tri goc la TRIEU dong -> nhan 1e6. Dung cac truong TONG
    (KLBuy_Total/GTSell_Total/GTBuy_Total/GTSell_Total = khop lenh +
    thoa thuan): kiem chung 20/10 FRT (ban thoa thuan 500.000) cho
    thay FINFO va PDF HOSE deu dung so TONG nay. Phan trang 50
    dong/trang. Tra cung shape chuan hoa."""
    import http.cookiejar
    import re
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cj))
    page = opener.open(urllib.request.Request(
        f"{_VS_BASE}/ket-qua-giao-dich?tab=gd-td&exchange=1",
        headers={"User-Agent": UA}), timeout=TIMEOUT).read().decode(
            "utf-8", "ignore")
    m = re.search(
        r'__RequestVerificationToken[^>]*?value="?([^"\s>]+)"?', page)
    if not m:
        raise RuntimeError("vietstock: khong lay duoc token")
    token = m.group(1)
    floors = {1: "HOSE", 2: "HNX", 3: "UPCOM"}
    out = []
    for cat, floor in floors.items():
        page_no = 1
        while True:
            body = urllib.parse.urlencode({
                "page": page_no, "pageSize": 50, "catID": cat,
                "date": date_iso, "__RequestVerificationToken": token,
            }).encode()
            req = urllib.request.Request(
                f"{_VS_BASE}/data/KQGDGiaoDichTuDoanhPaging", data=body,
                headers={"User-Agent": UA,
                         "Content-Type":
                             "application/x-www-form-urlencoded"})
            resp = opener.open(req, timeout=TIMEOUT).read().decode(
                "utf-8", "ignore")
            d = json.loads(resp)
            rows = d[1] if isinstance(d, list) and len(d) > 1 else []
            for r in rows:
                bv = int(r.get("KLBuy_Total") or 0)
                sv = int(r.get("KLSell_Total") or 0)
                bval = int(round((r.get("GTBuy_Total") or 0) * 1_000_000))
                sval = int(round((r.get("GTSell_Total") or 0) * 1_000_000))
                out.append({
                    "symbol": r.get("StockCode"), "floor": floor,
                    "trade_date": date_iso,
                    "buy_volume": bv, "sell_volume": sv,
                    "net_volume": bv - sv,
                    "buy_value_vnd": bval, "sell_value_vnd": sval,
                    "net_value_vnd": bval - sval,
                })
            if len(rows) < 50:
                break
            page_no += 1
    return out


# ---------------------------------------------------------------- VietCap trading (POST API)

_VCI_TRADING = "https://trading.vietcap.com.vn"


def vci_symbols(symbols: list[str]) -> dict[str, dict]:
    """Thong tin + bang gia + khoi ngoai tu VietCap trading (POST).

    Tuong duong route: market.equity.quote, market.equity.foreign_flow
    Tra ve {symbol: {listing, quote, foreign, shares_outstanding}}.
    """
    import urllib.request as _urlreq

    url = f"{_VCI_TRADING}/api/price/symbols/getList"
    body = json.dumps({"symbols": [s.upper() for s in symbols]}).encode()
    headers = {
        "User-Agent": UA,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Referer": "https://trading.vietcap.com.vn/",
    }
    import http.client as _httpc

    last_err: Exception | None = None
    rows: list = []
    for _ in range(3):
        try:
            req = _urlreq.Request(url, data=body, headers=headers)
            with _urlreq.urlopen(req, timeout=TIMEOUT) as resp:
                try:
                    raw = resp.read()
                except _httpc.IncompleteRead as e:
                    raw = e.partial  # proxy cat connection giua chung — lay phan da nhan
                if "gzip" in resp.headers.get("Content-Encoding", ""):
                    import gzip

                    raw = gzip.decompress(raw)
                rows = json.loads(raw.decode("utf-8"))
            last_err = None
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(2)
    if last_err is not None:
        raise RuntimeError(f"vci_symbols failed: {last_err}")
    out: dict[str, dict] = {}
    for r in rows or []:
        info = r.get("listingInfo") or {}
        mp = r.get("matchPrice") or {}
        sym = info.get("symbol")
        if not sym:
            continue
        out[sym] = {
            "symbol": sym,
            "name": info.get("organName"),
            "name_en": info.get("enOrganName"),
            "exchange": "HOSE" if info.get("board") == "HSX" else info.get("board"),
            "reference": info.get("refPrice"),
            "floor": info.get("floor"),
            "ceiling": info.get("ceiling"),
            "shares_outstanding": info.get("listedShare"),
            "open": mp.get("openPrice"),
            "high": mp.get("highest"),
            "low": mp.get("lowest"),
            "close": mp.get("matchPrice"),
            "avg_price": mp.get("avgMatchPrice"),
            "volume": mp.get("accumulatedVolume"),
            "value": mp.get("accumulatedValue"),
            # khoi ngoai — tuong duong market.equity.foreign_flow
            "foreign_buy_volume": mp.get("foreignBuyVolume"),
            "foreign_sell_volume": mp.get("foreignSellVolume"),
            "foreign_buy_value": mp.get("foreignBuyValue"),
            "foreign_sell_value": mp.get("foreignSellValue"),
        }
    return out


# ---------------------------------------------------------------------------
# VI MO (Tier 2, Henrry Chot T2-1 20/10/2026) — nguon chinh thong, verify
# bang request that 20/10/2026 (scratch/macro-probe + macro-legacy-probe):
# SBV ty gia trung tam, VCB ty gia thuong mai, SJC vang, NY Fed EFFR,
# US Treasury loi suat. Moi ham tra ve du lieu chuan hoa thuan Python.
# ---------------------------------------------------------------------------

_SBV_FX_URL = "https://sbv.gov.vn/t%E1%BB%B7-gi%C3%A1"


def sbv_fx_center(retries=4):
    """Ty gia trung tam USD/VND tu trang cong bo cua NHNN (HTML server
    render). Trang chi hien thong bao moi nhat -> lich su tich luy theo
    ngay chay. Tra {date, rate, notice} hoac None."""
    html = None
    for _ in range(retries):
        try:
            req = urllib.request.Request(_SBV_FX_URL, headers={
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "vi-VN,vi;q=0.9"})
            with urllib.request.urlopen(req, timeout=40) as r:
                html = r.read().decode("utf-8", "replace")
            if len(html) > 5000 and "Đô la Mỹ" in html:
                break
            html = None
        except Exception:  # noqa: BLE001
            html = None
        time.sleep(3)
    if not html:
        return None
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text)
    m = re.search(
        r"áp dụng cho ngày (\d{1,2})/(\d{1,2})/(\d{4}).{0,200}?"
        r"1 Đô la Mỹ = ([\d.]+) VND", text)
    if not m:
        return None
    d, mo, y, rate = m.groups()
    notice = ""
    mn = re.search(r"Số văn bản (\S+)", text)
    if mn:
        notice = mn.group(1)
    return {"date": f"{y}-{int(mo):02d}-{int(d):02d}",
            "rate": int(rate.replace(".", "")), "notice": notice}


def vcb_fx_day(date_iso):
    """Ty gia Vietcombank theo ngay (Excel API chinh thuc cua VCB —
    cung duong vnstock ban 3/4 dung): JSON {Data: base64 xlsx}.
    Tra [{code, buy_cash, buy_transfer, sell}] (don vi VND, JPY/100
    theo dung cach VCB cong bo) hoac []."""
    url = ("https://www.vietcombank.com.vn/api/exchangerates/"
           f"exportexcel?date={date_iso}")
    raw = _get(url)
    if not raw or not raw.get("Data"):
        return []
    import pandas as pd
    xls = base64.b64decode(raw["Data"])
    df = pd.read_excel(io.BytesIO(xls), sheet_name="ExchangeRate")
    df = df.iloc[2:-4]
    out = []
    for _, r in df.iterrows():
        vals = list(r)
        if len(vals) < 5 or not isinstance(vals[0], str):
            continue

        def _num(v):
            try:
                return float(str(v).replace(",", ""))
            except (TypeError, ValueError):
                return None
        out.append({"code": vals[0].strip(),
                    "buy_cash": _num(vals[2]),
                    "buy_transfer": _num(vals[3]),
                    "sell": _num(vals[4])})
    return [r for r in out if r["sell"]]


def sjc_gold_day(date_iso):
    """Gia vang SJC theo ngay tu dich vu gia truc tiep cua SJC
    (PriceService.ashx, method GetSJCGoldPriceByDate — cung duong
    vnstock ban 3/4 dung; du lieu tu 2016). Tra toan bo dong
    [{type, branch, buy, sell}] (VND/luong) hoac []."""
    y, m, d = date_iso.split("-")
    body = {"method": "GetSJCGoldPriceByDate",
            "toDate": f"{d}/{m}/{y}"}
    import requests
    for _ in range(4):
        try:
            r = requests.post(
                "https://sjc.com.vn/GoldPrice/Services/PriceService.ashx",
                data=body, headers={"User-Agent": UA}, timeout=30)
            data = r.json()
            if data.get("success"):
                return [{"type": x.get("TypeName"),
                         "branch": x.get("BranchName"),
                         "buy": x.get("BuyValue"),
                         "sell": x.get("SellValue")}
                        for x in data.get("data", [])]
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)
    return []


def sjc_gold_main(rows):
    """Chon dong gia chinh tu bang SJC theo ngay: uu tien chi nhanh
    Ho Chi Minh; khong co thi lay cap (mua, ban) pho bien nhat cua
    loai 'Vang SJC 1L, 10L, 1KG' (gia SJC 1L gan nhu dong nhat toan
    quoc — verify 20/10/2026: 10/10 chi nhanh cung 139,6/142,6)."""
    cand = [r for r in rows or []
            if r.get("type") and "SJC 1L" in r["type"]]
    if not cand:
        return None
    for r in cand:
        if r.get("branch") == "Hồ Chí Minh":
            return r
    from collections import Counter
    pair = Counter((r["buy"], r["sell"]) for r in cand).most_common(1)
    buy, sell = pair[0][0]
    return {"type": cand[0]["type"], "branch": "modal",
            "buy": buy, "sell": sell}


def vangtoday_gold(date_iso=None):
    """Gia vang SJC qua aggregator vang.today (JSON) — nguon DOI CHIEU
    cho SJC truc tiep. Khong truyen ngay = gia hien tai; co ngay =
    moc dong cua cua ngay do. Tra {buy, sell, xau} hoac None."""
    url = "https://www.vang.today/api/prices?type=SJL1L10"
    if date_iso:
        url += f"&date={date_iso}"
    raw = _get(url)
    if not raw:
        return None
    entries = raw.get("entries") or []
    if date_iso and entries:
        last = entries[-1]
        return {"buy": last.get("buy"), "sell": last.get("sell")}
    cur = raw.get("current") or raw
    buy = cur.get("buy") or cur.get("buyPrice")
    sell = cur.get("sell") or cur.get("sellPrice")
    if buy is None:
        return None
    return {"buy": buy, "sell": sell}


def nyfed_effr(start_iso, end_iso):
    """EFFR + khoang lai suat muc tieu FED tu API NY Fed (khong key).
    Tra [{date, effr, target_from, target_to}] tang dan theo ngay."""
    url = ("https://markets.newyorkfed.org/api/rates/unsecured/effr/"
           f"search.json?startDate={start_iso}&endDate={end_iso}"
           "&type=daily")
    raw = _get(url)
    rows = []
    for r in (raw or {}).get("refRates", []):
        if r.get("type") != "EFFR":
            continue
        rows.append({"date": r.get("effectiveDate"),
                     "effr": r.get("percentRate"),
                     "target_from": r.get("targetRateFrom"),
                     "target_to": r.get("targetRateTo")})
    return sorted([r for r in rows if r["date"]],
                  key=lambda r: r["date"])


def _treasury_rows_from_xml(xml_text):
    import xml.etree.ElementTree as ET
    out = []
    root = ET.fromstring(xml_text)
    for g in root.iter("G_NEW_DATE"):
        d = g.findtext("BID_CURVE_DATE")

        def _v(tag):
            el = g.find(f".//{tag}")
            t = el.text if el is not None else None
            try:
                return float(t) if t else None
            except ValueError:
                return None
        if not d:
            continue
        mon = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5,
               "JUN": 6, "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10,
               "NOV": 11, "DEC": 12}
        dd, mm, yy = d.split("-")
        out.append({
            "date": f"20{yy}-{mon[mm.upper()]:02d}-{int(dd):02d}",
            "y2": _v("BC_2YEAR"), "y10": _v("BC_10YEAR"),
            "y30": _v("BC_30YEAR")})
    return out


def treasury_yields_current():
    """Loi suat trai phieu My thang hien tai tu yield.xml chinh thuc
    cua Bo Tai chinh My. Tra [{date, y2, y10, y30}] tang dan."""
    url = ("https://home.treasury.gov/sites/default/files/"
           "interest-rates/yield.xml")
    for _ in range(3):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                xml = r.read().decode("utf-8", "replace")
            rows = _treasury_rows_from_xml(xml)
            if rows:
                return sorted(rows, key=lambda r: r["date"])
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)
    return []


def treasury_yields_month(yyyymm):
    """Loi suat 1 thang qua trang TextView cua Treasury (cho backfill
    sau). yyyymm dang '202501'. Tra [{date, y2, y10, y30}]."""
    url = ("https://home.treasury.gov/resource-center/data-chart-center/"
           "interest-rates/TextView?type=daily_treasury_yield_curve"
           f"&field_tdr_date_value_month={yyyymm}")
    for _ in range(3):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                html = r.read().decode("utf-8", "replace")
            rows = []
            ths = [re.sub(r"<[^>]+>", "", c).strip()
                   for c in re.findall(r"<th[^>]*>(.*?)</th>", html,
                                       re.S)]
            # Bang TextView gom nhieu khoi: khoi loi suat par nam sau
            # cot '1 Mo' (verify 20/10/2026: header co 26 cot, khoi
            # par o chi so 12..25). Map cot theo TEN sau moc '1 Mo'.
            try:
                base = ths.index("1 Mo")
                i2 = ths.index("2 Yr", base)
                i10 = ths.index("10 Yr", base)
                i30 = ths.index("30 Yr", base)
            except ValueError:
                return []
            for tr in re.findall(r"<tr>(.*?)</tr>", html, re.S):
                cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
                cells = [re.sub(r"<[^>]+>", "", c).strip()
                         for c in cells]
                if len(cells) <= i30 or not re.match(
                        r"\d{2}/\d{2}/\d{4}", cells[0] or ""):
                    continue
                mm, dd, yy = cells[0].split("/")

                def _f(v):
                    try:
                        return float(v)
                    except ValueError:
                        return None
                rows.append({"date": f"{yy}-{mm}-{dd}",
                             "y2": _f(cells[i2]), "y10": _f(cells[i10]),
                             "y30": _f(cells[i30])})
            if rows:
                return sorted(rows, key=lambda r: r["date"])
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)
    return []


# ---------------------------------------------------------------------------
# VI MO DOT 2 — collector NT4 dau tien (21/10/2026, Lan C): ket qua
# dau thau THI TRUONG MO cua SBV (mua ky han / reverse repo). Trang
# "Nghiep vu thi truong mo" cua sbv.gov.vn dang bang KET QUA moi
# nhat (server-render, co ngay) — chi co diem moi nhat, lich su
# tich luy theo ngay chay (dung mau sbv_fx_center). Probe sau
# 21/10/2026: www.sbv.gov.vn 200 voi UA trinh duyet; cong thong ke
# dttktt.sbv.gov.vn (trang lai suat lien ngan hang) KHONG toi duoc
# tu sandbox (000 nhu GSO) — xem bao cao Dot 2 Lan C.
# ---------------------------------------------------------------------------

_SBV_OMO_URL = ("https://sbv.gov.vn/vi/nghi%E1%BB%87p-v%E1%BB%A5-"
                "th%E1%BB%8B-tr%C6%B0%E1%BB%9Dng-m%E1%BB%9F")


def _vn_num(s):
    """So dinh dang Viet: '1.234,56' -> 1234.56; ',00' -> 0.0
    (SBV bo so 0 dau khi in 0,00); '' / '-' -> None."""
    if s is None:
        return None
    s = str(s).strip().replace("\xa0", "")
    if s in ("", "-", "--"):
        return None
    if s.startswith(","):
        s = "0" + s
    if s.startswith("."):
        s = "0" + s
    try:
        return float(s.replace(".", "").replace(",", "."))
    except ValueError:
        return None


def sbv_omo_latest(retries=4):
    """Ket qua dau thau thi truong mo moi nhat tu SBV: bang 'Mua ky
    han' theo ky han (7/14/35/91 ngay...). Tra
    {date, rows: [{tenor_days, members_bid, members_won,
    volume_ty, rate_pct}], total_volume_ty} hoac None.
    volume_ty = ty dong; rate_pct = %/nam. Ngay khong co giao dich
    trung thau SBV van dang bang voi so 0 — giu nguyen so cong bo,
    khong dien dien."""
    html = None
    for _ in range(retries):
        try:
            req = urllib.request.Request(_SBV_OMO_URL, headers={
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "vi-VN,vi;q=0.9"})
            with urllib.request.urlopen(req, timeout=40) as r:
                html = r.read().decode("utf-8", "replace")
            if "KẾT QUẢ ĐẤU THẦU THỊ TRƯỜNG MỞ" in html:
                break
            html = None
        except Exception:  # noqa: BLE001
            html = None
        time.sleep(3)
    if not html:
        return None
    # Ngay nam trong <div class="ls01-date"> tach rieng SAU the
    # tieu de (HTML that 21/10/2026) — tim trong doan sau moc tieu
    # de, khong noi truc tiep "MO</h4>...Ngay" bang \s*.
    seg = html[html.find("KẾT QUẢ ĐẤU THẦU THỊ TRƯỜNG MỞ"):]
    m = re.search(
        r"Ngày (\d{1,2}) tháng (\d{1,2}) năm (\d{4})", seg[:2000])
    if not m:
        return None
    d, mo, y = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    date_iso = f"{y:04d}-{mo:02d}-{d:02d}"
    tm = re.search(r"<table.*?</table>", seg, re.S)
    if not tm:
        return None
    rows = []
    total = None
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", tm.group(0), re.S):
        cells = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ",
                                            c)).strip()
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        if not cells:
            continue
        mt = re.search(r"Kỳ hạn (\d+) ngày", cells[0])
        if mt and len(cells) >= 4:
            mb = mw = None
            mm = re.match(r"(\d+)\s*/\s*(\d+)", cells[1] or "")
            if mm:
                mb, mw = int(mm.group(1)), int(mm.group(2))
            rows.append({
                "tenor_days": int(mt.group(1)),
                "members_bid": mb, "members_won": mw,
                "volume_ty": _vn_num(cells[2]),
                "rate_pct": _vn_num(cells[3])})
        elif "Tổng cộng" in (cells[0] or "") and len(cells) >= 3:
            total = _vn_num(cells[2])
    if not rows:
        return None
    return {"date": date_iso, "rows": rows, "total_volume_ty": total}


if __name__ == "__main__":
    import sys

    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "index":
        rows = vci_index_history(sys.argv[2] if len(sys.argv) > 2 else "VNINDEX", 3)
        for r in rows:
            print(r["date"], r["close"], r["volume"])
    elif cmd == "company":
        c = vci_company(sys.argv[2])
        print(json.dumps(c, indent=1, ensure_ascii=False)[:800])
    elif cmd == "fin":
        sym = sys.argv[2] if len(sys.argv) > 2 else "FPT"
        rt = sys.argv[3] if len(sys.argv) > 3 else "KQKD"
        fin = kbs_financial(sym, rt)
        print("periods:", [(p["term"], p["year"]) for p in fin["periods"]])
        for kw in ("doanh thu bán hàng", "lợi nhuận sau thuế", "tổng cộng tài sản"):
            r = kbs_find_row(fin, kw)
            if r:
                print(r["name"][:50], "->", r["values"])
    elif cmd == "ohlcv":
        sym = sys.argv[2] if len(sys.argv) > 2 else "FPT"
        for r in kbs_ohlcv(sym, "2026-10-14", "2026-10-16"):
            print(r)
    elif cmd == "board":
        syms = sys.argv[2].split(",") if len(sys.argv) > 2 else ["FPT"]
        for s, q in kbs_price_board(syms).items():
            print(s, q["close"], q["change"], "FB:", q["foreign_buy_volume"],
                  "FS:", q["foreign_sell_volume"])
    elif cmd == "events":
        sym = sys.argv[2] if len(sys.argv) > 2 else "FPT"
        evs = kbs_company_events(sym)
        print(f"{len(evs)} events")
        for e in evs[:3]:
            print(json.dumps(e, ensure_ascii=False)[:200])
    else:
        print("usage: direct_fetch.py [index [SYM] | company SYM | fin SYM [TYPE] |"
              " ohlcv SYM | board SYM1,SYM2 | events SYM]")
