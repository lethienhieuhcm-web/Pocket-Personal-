"""Giao thuc DNSE: topic MQTT + payload protobuf -> Envelope.

Khung nay chi giai ma ban tin; vong noi/socket/reconnect/WAL/queue nam o
gate task (commit sau). He so scale lay tu field_map.json — khong ghi cung
trong code, khong doan (scale=None thi loi ro rang).
"""
from . import protobuf
from .envelope import Envelope
from .fieldmap import load_map, translate_snapshot

GATE = "dnse"
TOPIC_PREFIX = "quotes/krx/mdds"


def topics_for(symbols):
    """2 topic cho moi ma: stockinfo (snapshot) + tick (match)."""
    topics = []
    for sym in symbols:
        s = str(sym).upper()
        topics.append(f"{TOPIC_PREFIX}/stockinfo/v1/roundlot/symbol/{s}")
        topics.append(f"{TOPIC_PREFIX}/tick/v1/roundlot/symbol/{s}")
    return topics


def _nested(node, key):
    v = node.get(key)
    if isinstance(v, list) and v and isinstance(v[0], dict):
        return v[0]
    return v if isinstance(v, dict) else {}


def _num(node, key, scale):
    if scale is None:
        raise ValueError(f"scale CHUA DO cho {key} — doi chieu ban tin tho")
    v = node.get(key)
    if isinstance(v, list):
        v = v[0] if v else None
    if isinstance(v, (int, float)):
        return v * scale
    return None


def _scale(data, raw_code):
    return data["gates"][GATE]["fields"][raw_code]["scale"]


def parse_message(topic, payload, recv_ts, seq=0, fieldmap_data=None):
    """Giai ma 1 ban tin MQTT cua DNSE -> Envelope, hoac None neu bo.
    Snapshot rong (khong truong nao co gia tri) -> None.
    Match thieu gia hoac khoi luong -> None."""
    data = fieldmap_data or load_map()
    decoded = protobuf.decode(payload, {})
    sym = topic.rsplit("/", 1)[-1].upper()
    if "stockinfo" in topic:
        m = _nested(decoded, "f41")
        snap_alias = {
            "last": _num(m, "f13", _scale(data, "f13")),
            "total_volume": _num(m, "f22", _scale(data, "f22")),
            "total_value": _num(m, "f25", _scale(data, "f25")),
            "buy_volume": _num(m, "f17", _scale(data, "f17")),
            "buy_value": _num(m, "f58", _scale(data, "f58")),
            "sell_volume": _num(m, "f18", _scale(data, "f18")),
            "sell_value": _num(m, "f59", _scale(data, "f59")),
            "room": _num(m, "f20", _scale(data, "f20")),
            "total_room": _num(m, "f60", _scale(data, "f60")),
        }
        if all(v is None for v in snap_alias.values()):
            return None
        fields, field_src = translate_snapshot(GATE, snap_alias, data)
        return Envelope(gate=GATE, kind="snapshot", sym=sym, ts=recv_ts,
                        recv_ts=recv_ts, fields=fields, field_src=field_src,
                        seq=seq, ts_synthetic=True)
    if "/tick/" in topic:
        m = _nested(decoded, "f45")
        ts_node = _nested(m, "f7")
        ts = _num(ts_node, "f1", 1)
        price = _num(m, "f5", _scale(data, "f5"))
        vol = _num(m, "f6", _scale(data, "f6"))
        acc = _num(m, "f10", _scale(data, "f10"))
        if not price or not vol:
            return None
        return Envelope(gate=GATE, kind="match", sym=sym,
                        ts=ts if ts is not None else recv_ts,
                        recv_ts=recv_ts, price=price, vol=vol, acc=acc,
                        seq=seq, ts_synthetic=ts is None)
    return None
