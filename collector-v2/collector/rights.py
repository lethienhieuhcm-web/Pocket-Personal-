"""Lich quyen cho consumer (§3.5 dac ta, bo sung Q6 Phuong an B).

Doc file lich versioned (corporate_actions.json) — KHONG fetch, KHONG
Telegram. Chi lay su kien co ex_date == session_date; consumer gan co
ex_date/corp_action len envelope. File thieu -> {} (log LOUD o caller).
File hong -> loi ro rang, khong doan.
"""
import json


def load_rights_calendar(path, session_date):
    """Tra ve {SYM: kind} cho cac su kien ex_date == session_date."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    actions = data.get("actions")
    if not isinstance(actions, list):
        raise ValueError(f"{path}: thieu actions[]")
    out = {}
    for a in actions:
        if a.get("ex_date") != session_date:
            continue
        sym = str(a.get("symbol", "")).upper()
        if not sym:
            continue
        kind = a.get("kind") or "event"
        out[sym] = kind
    return out
