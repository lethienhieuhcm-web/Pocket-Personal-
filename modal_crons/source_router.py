#!/usr/bin/env python3
"""Lop dinh tuyen nguon du lieu — TUCHU-95 muc 2A (20/10/2026).

Truoc day cac script goi thang tung nguon (kbs_ohlcv, vci_symbols,
Market().ohlcv...) — doi nguon phai sua code nhieu noi. Nay moi loai
du lieu co MOT ham chung o day; ben duoi la chuoi nguon uu tien +
failover tu dong. Doi/them nguon = sua CHAINS (cau hinh), khong sua
noi tieu thu.

Moi ham tra (data, source): source la nguon THUC TE da dung, de noi
tieu thu ghi vao nhan nguon (_prov) — endpoint /api/stock/version
hien san.

Dinh dang chuan:
- ohlcv: [{date, open, high, low, close, volume}] TANG dan theo ngay,
  gia NGHIN dong (chuan DB/frontend cua he).
- price_board: {symbol: {close, change, pct_change, volume, value_vnd,
  foreign_buy_volume, foreign_sell_volume, foreign_buy_value,
  foreign_sell_value, ...}} — truong nao nguon khong co thi thieu key.
- market_status: {"is_trading": bool}.

Trang thai chuoi (sau Dot 0 parity, 20/10):
- ohlcv: KBS dat tuyet doi -> chinh; vnstock fallback (cap 100 phien).
- price_board: KBS chinh, VCI Trading du phong nong.
- market_status: suy tu lich + dau thoi gian bang gia (derived) chinh,
  vnstock fallback.
- index: VNDirect dchart chinh (snapshot kem prev_close), vnstock fallback.
- events: LAT LAI tu Dot 3 (doanh nghiep <- VCI IQ truc tiep, nhom
  giao dich co dong lon/noi bo giu vnstock — xem events()).
  profile/statements: van vnstock (BCTC KBS lan cot ky — Dot 4
  ket luan am tinh; ho so da lat 2/5 phan o publish_snapshot).
"""
import time
from datetime import date, datetime, timedelta, timezone

ICT = timezone(timedelta(hours=7))

CHAINS = {
    "ohlcv": ["kbs", "vnstock"],
    "intraday": ["vnd", "kbs", "vnstock"],
    "index": ["vnd", "vnstock"],
    "price_board": ["kbs", "vci"],
    "market_status": ["derived", "vnstock"],
    "events": ["hybrid"],
    "profile": ["vnstock"],
    "statements": ["vnstock"],
    "listing": ["vnd", "vnstock"],
    "sectors": ["codebook", "vnstock"],
    "proprietary_day": ["finfo", "vietstock", "pdf"],
}


def _run_chain(kind, adapters):
    """Chay theo CHAINS[kind], tra (data, source). Nguon loi/rong thi
    thu nguon ke. Het chuoi van loi -> raise loi cuoi."""
    last_err = None
    for name in CHAINS[kind]:
        fn = adapters.get(name)
        if fn is None:
            continue
        try:
            data = fn()
            if data is None or data == [] or data == {}:
                raise ValueError(f"{name}: rong")
            return data, name
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"[router:{kind}] {name} loi: {str(e)[:100]} -> thu nguon ke",
                  flush=True)
    raise RuntimeError(f"[router:{kind}] het nguon: {last_err}")


# ---------------------------------------------------------------- OHLCV
def _ohlcv_kbs(symbol, start, end):
    from direct_fetch import kbs_ohlcv
    rows = kbs_ohlcv(symbol, start, end)
    out = []
    for r in rows or []:
        try:
            out.append({
                "date": str(r.get("time") or "")[:10],
                "open": (r.get("open") or 0) / 1000,
                "high": (r.get("high") or 0) / 1000,
                "low": (r.get("low") or 0) / 1000,
                "close": (r.get("close") or 0) / 1000,
                "volume": int(r.get("volume") or 0),
            })
        except (TypeError, ValueError):
            continue
    out.sort(key=lambda x: x["date"])
    return out


def _ohlcv_vnstock(symbol, start, end):
    from vnstock import Market
    df = Market().equity(symbol=symbol).ohlcv(start=start, end=end)
    out = []
    if df is not None:
        for r in df.to_dict(orient="records"):
            t = r.get("time")
            t = t[:10] if isinstance(t, str) else str(t)[:10]
            try:
                out.append({"date": t, "open": float(r["open"]),
                            "high": float(r["high"]), "low": float(r["low"]),
                            "close": float(r["close"]),
                            "volume": int(r.get("volume") or 0)})
            except (KeyError, TypeError, ValueError):
                continue
    out.sort(key=lambda x: x["date"])
    return out


def ohlcv(symbol, start, end):
    """OHLCV ngay chuan hoa (nghin dong, tang dan)."""
    return _run_chain("ohlcv", {
        "kbs": lambda: _ohlcv_kbs(symbol, start, end),
        "vnstock": lambda: _ohlcv_vnstock(symbol, start, end),
    })


# ---------------------------------------------------------------- index
def _index_vnd(symbols):
    from direct_fetch import vnd_index_snapshot
    rows = vnd_index_snapshot()
    by = {r["symbol"]: r for r in rows or []}
    out = []
    for sym in symbols:
        # snapshot tra khoa day du (HNXIndex...); phong khi doi dang thi
        # thu ca dang rut gon cua dchart (HNX/UPCOM)
        r = by.get(sym) or by.get({"HNXIndex": "HNX",
                                   "UPCOMIndex": "UPCOM"}.get(sym, ""))
        if not r:
            continue
        out.append({"symbol": sym, "close": r.get("close"),
                    "open": r.get("open"), "high": r.get("high"),
                    "low": r.get("low"),
                    "volume": r.get("volume"), "time": r.get("time"),
                    "change": r.get("change"), "pct_change": r.get("pct_change"),
                    "prev_close": r.get("prev_close"),
                    "prev_date": r.get("prev_date")})
    return out


def _index_vnstock(symbols, start, end):
    from vnstock import Market
    out = []
    for sym in symbols:
        try:
            df = Market().index(symbol=sym).ohlcv(start=start, end=end)
        except Exception as e:  # noqa: BLE001 — loi 1 ma khong chet ca lo
            print(f"[router:index] vnstock {sym} loi: {str(e)[:100]}",
                  flush=True)
            continue
        recs = df.to_dict(orient="records") if df is not None else []
        item = {"symbol": sym}
        if recs:
            last = recs[-1]
            item.update({"close": last.get("close"),
                         "volume": last.get("volume"),
                         "time": str(last.get("time") or "")[:10]})
            if len(recs) >= 2 and recs[-2].get("close"):
                prev, cur = recs[-2]["close"], recs[-1]["close"]
                item["prev_close"] = prev
                item["change"] = round(cur - prev, 2)
                item["pct_change"] = round((cur - prev) / prev * 100, 2)
        out.append(item)
        time.sleep(2)
    return [x for x in out if x.get("close") is not None]


def _normalize_index_dates(rows, today_str):
    """Neu ngay nguon != hom nay (ICT): change/pct tinh theo moc ngay
    cua nguon se thanh so cua phien cu doi lot phien nay (bug 20/10).
    Dat None — thieu trung thuc — va danh dau de guard gan stale."""
    for r in rows:
        d = str(r.get("time") or "")[:10]
        r["time"] = d
        if d != today_str:
            r["change"] = None
            r["pct_change"] = None
            r["_date_mismatch"] = True
    return rows


def index_snapshot(symbols):
    """Snapshot chi so — hop dong ban ghi (Dot A+B, Chot 22/10):
    {symbol, close, open, high, low, volume, time(ngay nguon), change,
    pct_change, prev_close, prev_date, source, as_of, stale, age_s,
    suspect}. Guard (index_guard) gan stale/age_s/suspect; loi guard
    thi fail-open: publish khong guard kem log."""
    end = date.today().isoformat()
    start = (date.today() - timedelta(days=10)).isoformat()
    rows, src = _run_chain("index", {
        "vnd": lambda: _index_vnd(symbols),
        "vnstock": lambda: _index_vnstock(symbols, start, end),
    })
    now_ict = datetime.now(ICT)
    _normalize_index_dates(rows, now_ict.date().isoformat())
    fetched_at = now_ict.isoformat(timespec="seconds")
    for r in rows:
        r["source"] = src
        r["as_of"] = fetched_at
    try:
        import index_guard
        rows = index_guard.apply_index_guard(rows, now=now_ict)
    except Exception as e:  # noqa: BLE001 — fail-open, khong chet lane
        print(f"[router:index] guard loi (fail-open): {str(e)[:150]}",
              flush=True)
        for r in rows:
            r.pop("_date_mismatch", None)
            r.setdefault("stale", False)
            r.setdefault("age_s", None)
            r.setdefault("suspect", False)
    return rows, src


# ---------------------------------------------------------------- price board
def _board_kbs(symbols):
    from direct_fetch import kbs_price_board, vci_symbols
    out = {}
    for i in range(0, len(symbols), 10):  # chunk 10: goi lon hay dut ket noi
        out.update(kbs_price_board(symbols[i:i + 10]))
    # Bang gia KBS khong co gia tri mua/ban NN (FO/FR la han muc/room tinh
    # bang CP — xem kbs_price_board) -> dien 2 truong gia tri tu VCI
    # (foreignBuyValue/SellValue that cua phien). VCI chet thi giu None:
    # thieu trung thuc, khong bia so.
    missing = [s for s, q in out.items()
               if q.get("foreign_buy_value") is None
               or q.get("foreign_sell_value") is None]
    if missing:
        try:
            for i in range(0, len(missing), 100):  # VCI nhan lo 100 ma/lan
                raw = vci_symbols(missing[i:i + 100]) or {}
                for sym, vq in raw.items():
                    if sym not in out:
                        continue
                    if out[sym].get("foreign_buy_value") is None:
                        out[sym]["foreign_buy_value"] = vq.get("foreign_buy_value")
                    if out[sym].get("foreign_sell_value") is None:
                        out[sym]["foreign_sell_value"] = vq.get("foreign_sell_value")
        except Exception:  # noqa: BLE001
            pass
    return out


def _board_vci(symbols):
    from direct_fetch import vci_symbols
    out = {}
    for i in range(0, len(symbols), 100):  # VCI nhan lo 100 ma/lan
        raw = vci_symbols(symbols[i:i + 100])
        for sym, q in (raw or {}).items():
            close = q.get("close")
            open_ = q.get("open")
            # vci_symbols KHONG tra change/pct_change/value_vnd (chi tra
            # open/high/low/close/avg_price/volume/value + foreign_*), nen
            # tinh o day. change = close - open (matchPrice - openPrice);
            # thieu open HOAC close -> None (khong bia 0).
            change = (close - open_) if (close is not None
                                         and open_ is not None) else None
            # pct = change/open; guard open None/0 -> None.
            pct_change = (round(change / open_ * 100, 2)
                          if (change is not None and open_) else None)
            # value = accumulatedValue cua VCI tinh bang TRIEU DONG, khong
            # phai dong. Bang chung probe live 01/11 (doi chieu KBS cung
            # ma/phien): VIC accumulatedValue=1.196.775,19 vs KBS
            # TV=1.196.775.190.000 dong; HPG 526.501,595 vs 526.501.595.000;
            # FPT 300.410,92 vs 300.410.920.000 -> tso le 1e6. DB
            # screener_cache.value_vnd dung truc tiep gia tri KBS (TV, dong
            # thuong) nen VCI phai x1e6 de cung don vi. value None -> None.
            val = q.get("value")
            value_vnd = (val * 1_000_000) if val is not None else None
            out[sym] = {
                "close": close, "change": change,
                "pct_change": pct_change, "volume": q.get("volume"),
                "value_vnd": value_vnd,
                # vci_symbols tra "exchange" (board HSX -> HOSE); consumer
                # screener/instabox_counterpart doc key nay (None truoc day).
                # (Plan them 01/11: diem chan deploy so 2.)
                "exchange": q.get("exchange"),
                "foreign_buy_volume": q.get("foreign_buy_volume"),
                "foreign_sell_volume": q.get("foreign_sell_volume"),
                "foreign_buy_value": q.get("foreign_buy_value"),
                "foreign_sell_value": q.get("foreign_sell_value"),
            }
    return out


def price_board(symbols, prefer=None):
    """Bang gia nhieu ma. KBS chinh (gia + KL NN + room), gia tri mua/ban
    NN dien tu VCI (bang gia KBS khong co 2 truong nay), VCI du phong.
    prefer="vci": dao thu tu chuoi cho noi tieu thu can lo lon re
    (vd fetch_foreign_daily quet ~640 ma — VCI nhan 100 ma/lan)."""
    adapters = {
        "kbs": lambda: _board_kbs(symbols),
        "vci": lambda: _board_vci(symbols),
    }
    if prefer and prefer in adapters:
        order = [prefer] + [s for s in CHAINS["price_board"] if s != prefer]
        last_err = None
        for name in order:
            try:
                data = adapters[name]()
                if data:
                    return data, name
                raise ValueError(f"{name}: rong")
            except Exception as e:  # noqa: BLE001
                last_err = e
                print(f"[router:price_board] {name} loi: {str(e)[:100]}",
                      flush=True)
        raise RuntimeError(f"[router:price_board] het nguon: {last_err}")
    return _run_chain("price_board", adapters)


def index_history(symbol, limit=80):
    """Lich su dong cua chi so (EOD) cho MA dai han (market_regime).
    VCI IQ: cap nhat sau phien + tra GIAM dan (moi nhat truoc) — router
    DAO VE TANG DAN theo chuan chung cua lop dinh tuyen. (Bay da biet:
    noi tieu thu lay phan tu cuoi lam gia moi nhat se nhan gia CU NHAT —
    tung can ca realtime_poller lan market_regime.)"""
    from direct_fetch import vci_index_history
    rows = vci_index_history(symbol, limit) or []
    rows = sorted(rows, key=lambda r: str(r.get("time") or r.get("date") or ""))
    return rows, "vci"


# ---------------------------------------------------------------- intraday
_DCHART_RES = {"15m": "15", "1H": "60"}
_KBS_IV = {"15m": "15m", "1H": "1h"}


def _intraday_vnd(symbol, interval, count):
    import json as _json
    import urllib.request
    res = _DCHART_RES[interval]
    to = int(time.time())
    frm = to - 10 * 86400
    url = (f"https://dchart-api.vndirect.com.vn/dchart/history"
           f"?symbol={symbol}&resolution={res}&from={frm}&to={to}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    d = _json.loads(urllib.request.urlopen(req, timeout=30).read())
    out = []
    for i, t in enumerate(d.get("t") or []):
        dt = datetime.fromtimestamp(t, ICT)
        try:
            out.append({"t": dt.strftime("%Y-%m-%dT%H:%M"),
                        "o": float(d["o"][i]), "h": float(d["h"][i]),
                        "l": float(d["l"][i]), "c": float(d["c"][i]),
                        "v": int(d["v"][i] or 0)})
        except (TypeError, ValueError, IndexError):
            continue
    return out[-count:]


def _intraday_kbs(symbol, interval, count):
    from direct_fetch import kbs_ohlcv
    end = date.today()
    start = end - timedelta(days=10)
    rows = kbs_ohlcv(symbol, start.isoformat(), end.isoformat(),
                     _KBS_IV[interval])
    out = []
    for r in rows or []:
        try:
            out.append({"t": str(r.get("time") or "")[:16].replace(" ", "T"),
                        "o": (r.get("open") or 0) / 1000,
                        "h": (r.get("high") or 0) / 1000,
                        "l": (r.get("low") or 0) / 1000,
                        "c": (r.get("close") or 0) / 1000,
                        "v": int(r.get("volume") or 0)})
        except (TypeError, ValueError):
            continue
    out.sort(key=lambda x: x["t"])
    return out[-count:]


def _intraday_vnstock(symbol, interval, count):
    from vnstock import Market
    df = Market().equity(symbol=symbol).ohlcv(interval=interval, count=count)
    out = []
    if df is not None:
        for r in df.to_dict(orient="records"):
            t = r.get("time")
            t = t.isoformat() if hasattr(t, "isoformat") else str(t)
            try:
                out.append({"t": t[:16], "o": float(r["open"]),
                            "h": float(r["high"]), "l": float(r["low"]),
                            "c": float(r["close"]),
                            "v": int(r.get("volume") or 0)})
            except (KeyError, TypeError, ValueError):
                continue
    out.sort(key=lambda x: x["t"])
    return out


def intraday(symbol, interval, count=80):
    """Nen intraday (1H/15m): [{t,o,h,l,c,v}] tang dan, gia nghin dong.
    Chuoi: VNDirect dchart -> KBS -> vnstock (probe 20/10: VND va KBS
    khop nhau tuyet doi ca so nen lan gia dong cua)."""
    if interval not in _DCHART_RES:
        raise ValueError(f"interval khong ho tro: {interval}")
    return _run_chain("intraday", {
        "vnd": lambda: _intraday_vnd(symbol, interval, count),
        "kbs": lambda: _intraday_kbs(symbol, interval, count),
        "vnstock": lambda: _intraday_vnstock(symbol, interval, count),
    })


# ---------------------------------------------------------------- market status
def _status_derived():
    now = datetime.now(ICT)
    if now.weekday() >= 5:
        return {"is_trading": False}
    hm = (now.hour, now.minute)
    if not ((9, 0) <= hm < (11, 30) or (13, 0) <= hm < (15, 0)):
        return {"is_trading": False}
    # Trong cua so gio: xac nhan bang dau thoi gian bang gia (nghi le ->
    # bang gia khong co du lieu hom nay -> khong giao dich).
    try:
        board, _ = price_board(["FPT"])
        q = board.get("FPT") or {}
        # Board tra date kieu DD/MM/YYYY ("21/10/2026"), time kieu HH:MM:SS
        # ("09:28:53") -> phai chuan hoa ve ISO truoc khi so voi today.
        raw = str(q.get("date") or q.get("time") or "")[:10]
        if "/" in raw:  # DD/MM/YYYY
            d = raw.split("/")
            t = f"{d[2]}-{d[1].zfill(2)}-{d[0].zfill(2)}" if len(d) == 3 else ""
        else:  # ISO YYYY-MM-DD
            t = raw
        if t and t != now.date().isoformat():
            return {"is_trading": False}
    except Exception:  # noqa: BLE001
        pass  # khong xac nhan duoc bang gia -> tin lich
    return {"is_trading": True}


def _status_vnstock():
    from vnstock import Reference
    st = Reference().market.status()
    recs = st.to_dict(orient="records") if hasattr(st, "to_dict") else []
    if recs and "is_trading_hour" in recs[0]:  # 4.x
        return {"is_trading": bool(recs[0].get("is_trading_hour"))}
    if recs and "status" in recs[0]:  # 5.x
        return {"is_trading": any(
            str(r.get("status") or "").upper() not in ("CLOSED", "CLOSE", "")
            for r in recs if r.get("asset_type") in (None, "EQUITY"))}
    return {"is_trading": True}


def market_status():
    """{"is_trading": bool} — derived (lich + bang gia) chinh, vnstock sau."""
    return _run_chain("market_status", {
        "derived": _status_derived,
        "vnstock": _status_vnstock,
    })


# ---------------------------------------------------------------- cac diem con vnstock (Dot 0 chua qua cong)
def _clean(records):
    """Don ban ghi DataFrame -> dang san sang JSON: NaN -> None,
    Timestamp/datetime -> chuoi ISO (publish dung json.dumps thuong,
    khong co default=str — thieu buoc nay la vo publish)."""
    import math
    out = []
    for rec in records or []:
        clean = {}
        for k, v in rec.items():
            if v is None:
                clean[k] = None
            elif isinstance(v, float) and math.isnan(v):
                clean[k] = None
            elif hasattr(v, "isoformat"):
                try:
                    clean[k] = v.isoformat()
                except Exception:  # noqa: BLE001
                    clean[k] = str(v)
            else:
                clean[k] = v
        out.append(clean)
    return out


_IQ_EV_CACHE = {}
_TRADING_CAT = "MAJOR_SHAREHOLDER_TRADING"


def _iq_events_for(symbol):
    """Su kien DOANH NGHIEP cua 1 ma tu VCI IQ truc tiep (cache 1h
    trong tien trinh, keo theo ticker nen re), chuan hoa ve dung
    shape ban ghi vnstock. Nhom giao dich co dong lon/noi bo
    (category MAJOR_SHAREHOLDER_TRADING) KHONG lay o day — xem events()."""
    import time as _time
    hit = _IQ_EV_CACHE.get(symbol)
    if hit and _time.time() - hit[0] < 3600:
        return hit[1]
    import direct_fetch as df
    recs = []
    for e in df.vci_events_symbol(symbol):
        if e.get("category") == _TRADING_CAT:
            continue
        recs.append({
            "id": e.get("id"), "symbol": symbol,
            "event_name_vi": e.get("eventNameVi"),
            "event_name_en": e.get("eventNameEn"),
            "event_title_vi": e.get("eventTitleVi"),
            "event_title_en": e.get("eventTitleEn"),
            "event_code": e.get("eventCode"),
            "category": e.get("category"),
            "display_date1": e.get("displayDate1"),
            "display_date2": e.get("displayDate2"),
            "public_date": e.get("publicDate"),
            "exright_date": e.get("exrightDate"),
            "record_date": e.get("recordDate"),
            "exercise_ratio": e.get("exerciseRatio"),
            "value_per_share": e.get("valuePerShare"),
            "payout_date": None,
        })
    _IQ_EV_CACHE[symbol] = (_time.time(), recs)
    return recs


def events(symbol):
    """Su kien cong ty — LAT LAI (TUCHU-95 Dot 3, Henrry Chot 21:53
    20/10): su kien doanh nghiep (co tuc/phat hanh/dai hoi...) tu VCI
    IQ TRUC TIEP; nhom giao dich co dong lon/nguoi noi bo giu vnstock
    (tieu de nhom nay do vnstock tu ghep tu truong cau truc, IQ khong
    tra du truong de ghep lai giong het). Hai nguon dung chung he id
    + category nen gop khong trung. Mot nguon loi thi nguon kia van
    chay (vnstock het quota van dang duoc phan doanh nghiep)."""
    def _vn():
        from vnstock import Reference
        df = Reference().company(symbol=symbol).events(source="vci")
        return _clean(df.to_dict(orient="records")) if df is not None else []
    vn_recs = None
    try:
        vn_recs = _vn()
    except BaseException:  # noqa: BLE001 — ke ca SystemExit (rate limit)
        vn_recs = None
    iq_recs = None
    try:
        iq_recs = _iq_events_for(symbol)
    except Exception:  # noqa: BLE001
        iq_recs = None
    if vn_recs is None and iq_recs is None:
        return [], "none"
    if iq_recs is None:
        return vn_recs, "vnstock"
    if vn_recs is None:
        return iq_recs, "vci"
    trading = [r for r in vn_recs if r.get("category") == _TRADING_CAT]
    # IQ khong co payout_date (ngay chi tra co tuc) — vnstock co theo
    # cung id su kien: lam giau lai cho ban ghi IQ de khong mat truong.
    # Chi lay gia tri dang chuoi ngay ISO that (bo NaT/None lan vao).
    pay = {}
    for r in vn_recs:
        v = r.get("payout_date")
        if r.get("id") and isinstance(v, str) and len(v) >= 10 \
                and v[:4].isdigit():
            pay[r["id"]] = v
    for r in iq_recs:
        if not r.get("payout_date") and pay.get(r.get("id")):
            r["payout_date"] = pay[r["id"]]
    seen, merged = set(), []
    for r in list(iq_recs) + trading:
        k = r.get("id") or (r.get("event_title_vi"),
                            r.get("display_date1"))
        if k not in seen:
            seen.add(k)
            merged.append(r)
    merged.sort(key=lambda r: str(r.get("display_date1") or ""),
                reverse=True)
    return merged, "hybrid"


def listing():
    """Danh sach ma theo san. TUCHU-95 Dot 2: VNDirect finfo truc tiep
    (1.519 ma, khop baseline tung san), vnstock du phong."""
    def _vnd():
        import direct_fetch as df
        rows = df.vnd_listing()
        return rows if rows else []
    def _vn():
        from vnstock import Reference
        df = Reference().equity.list_by_exchange()
        return _clean(df.to_dict(orient="records")) if df is not None else []
    return _run_chain("listing", {"vnd": _vnd, "vnstock": _vn})


# ------------------------------------------------------- Tu doanh (ngay)
def _pdf_proprietary(date_iso):
    """Tu doanh HOSE tu PDF so (CafeF CDN) — tang cuoi cua chuoi +
    chuan doi chieu. Tra list shape chuan hoa nhu finfo."""
    import tempfile
    import urllib.request
    from datetime import datetime
    import parse_proprietary_pdf as pp
    d = datetime.strptime(date_iso, "%Y-%m-%d").date()
    url = pp.build_url(d)
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (compatible; "
                                   "StockApp/1.0)"})
    with tempfile.NamedTemporaryFile(suffix=".pdf",
                                     delete=False) as tf:
        with urllib.request.urlopen(req, timeout=120) as r:
            tf.write(r.read())
        path = tf.name
    data = pp.parse_pdf_file(path, date_iso)
    out = []
    for sym, e in (data or {}).items():
        out.append({
            "symbol": sym, "floor": "HOSE", "trade_date": date_iso,
            "buy_volume": e.get("buy_volume"),
            "sell_volume": e.get("sell_volume"),
            "net_volume": e.get("net_volume"),
            "buy_value_vnd": e.get("buy_value_vnd"),
            "sell_value_vnd": e.get("sell_value_vnd"),
            "net_value_vnd": e.get("net_value_vnd"),
        })
    return out


def proprietary_day(date_iso):
    """Tu doanh toan thi truong 1 ngay (3 san), shape chuan hoa.
    Chuoi: finfo (day du) -> vietstock (endpoint khoa cung 50 ma
    dau moi san — du phong mot phan) -> PDF HOSE. Tra (rows, src)."""
    import direct_fetch as df
    return _run_chain("proprietary_day", {
        "finfo": lambda: df.finfo_proprietary_day(date_iso),
        "vietstock": lambda: df.vietstock_proprietary_day(date_iso),
        "pdf": lambda: _pdf_proprietary(date_iso)})


def sectors():
    """Ban do nganh symbol -> icb_name. TUCHU-95 Dot 2: codebook ICB
    cache (data/icb_codebook.json — symbol->icb_code_lv2 tu VCI IQ,
    code->ten nganh), vnstock du phong."""
    def _cb():
        import json as _json
        import os as _os
        p = _os.path.expanduser("~/workspace/stock-app/data/icb_codebook.json")
        cb = _json.load(open(p, encoding="utf-8"))
        names = cb.get("names") or {}
        return [{"symbol": s, "icb_code_lv2": c,
                 "icb_name": (names.get(c) or {}).get("vi", "")}
                for s, c in (cb.get("by_symbol") or {}).items()]
    def _vn():
        from vnstock import Reference
        df = Reference().industry.sectors()
        return _clean(df.to_dict(orient="records")) if df is not None else []
    return _run_chain("sectors", {"codebook": _cb, "vnstock": _vn})
