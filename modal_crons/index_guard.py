#!/usr/bin/env python3
"""index_guard — guard stale cho lane chi so (IMPL-PLAN B1 / F4, 04/11).

Lich su (REEVAL §3.10): `source_router.index_snapshot` goi
`import index_guard` (dong 204) nhung file nay TON TAI CA trong repo
lan image Modal (image copy co 4 file, khong co index_guard). Vi vay
import LUON tung ImportError -> nhanh except fail-open chay, pop
`_date_mismatch` (router dat o :181) va `setdefault stale=False`. Ket
qua: snapshot chet cua phien cuoc duoc dan dau lai la "tuoi" (fail-open
ma xoa bang chung). Lenh doc §3.10 — "ship index_guard for real".

Ham nay dat `stale` / `age_s` / `suspect` tu truong `time` (ngay nguon)
doi chieu ngay phien (`now`, ICT) va GIU LAI `_date_mismatch` tren
dong stale. Do phan giai cua `time` chi den HOP NGAY (YYYY-MM-DD,
khong co gio), `age_s` laCHAN LUOI theo so ngay lech × 86400 — du cho
noi tieu thu nhan dien "du lieu hom qua", khong phai so do chinh xac.

Thu nghiem: python3 modal_crons/tests/test_index_guard.py
Khong mang, khong secret, stdlib only.
"""
from datetime import date, datetime, timedelta, timezone

ICT = timezone(timedelta(hours=7))
DAY_S = 86400


def _session_date(now):
    d = now.date() if isinstance(now, datetime) else now
    return d


def apply_index_guard(rows, now=None):
    """Dat stale/age_s/suspect cho tung dong theo `time` vs ngay phien.

    - `stale`  : True khi ngay nguon khac ngay phien (row do phien cu
                 hoac ngay khong xac dinh duoc).
    - `age_s`  : chan luoi tuoi theo ngay (so ngay lech × 86400); None
                 khi khong parse duoc ngay nguon.
    - `suspect`: True khi row stale VAN con gia tri change/pct — day
                 chinh la che do nguy hiem cua fail-open (so cu duoc
                 phat nhu so hom nay). Row stale da duoc _normalize
                 null hoa change/pct thi suspect=False (van stale).
    - `_date_mismatch` (router dat o source_router.py:181): KHONG bi
                 xoa. Doi voi row stale, no la bang chung du lieu lech
                 ngay — phai song qua guard.
    """
    if now is None:
        now = datetime.now(ICT)
    session = _session_date(now).isoformat()
    for r in rows:
        rd = str(r.get("time") or "")[:10]
        try:
            d = date.fromisoformat(rd)
            delta_days = (_session_date(now) - d).days
        except ValueError:
            d = None
            delta_days = None
        stale = (rd != session)
        r["stale"] = bool(stale)
        if delta_days is not None and delta_days >= 0:
            r["age_s"] = delta_days * DAY_S
        else:
            r["age_s"] = None
        has_move = r.get("change") is not None or r.get("pct_change") is not None
        r["suspect"] = bool(stale and has_move)
        # _date_mismatch duoc GIU NGUYEN (khong pop): bang chung lech
        # ngay phai ton tai tren row stale sau khi guard chay.
    return rows
