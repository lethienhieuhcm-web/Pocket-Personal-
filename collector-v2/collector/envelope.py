"""Event envelope chuan (§3.2). Gate task chi duoc day envelope nay vao queue.

ts = thoi gian SO cua tin (epoch). Tin nao cong khong cho ts thi ts = recv_ts
+ co ts_synthetic. recv_ts = gio nhan (epoch). Ca hai deu bat buoc.
"""
from dataclasses import dataclass, field


@dataclass
class Envelope:
    gate: str
    kind: str  # match | snapshot | put | index
    sym: str
    ts: float
    recv_ts: float
    price: float = None
    vol: float = None
    acc: float = None
    fields: dict = field(default_factory=dict)
    field_src: dict = field(default_factory=dict)
    seq: int = 0
    ts_synthetic: bool = False
    restated: bool = False

    def minute(self):
        """Phut cua ts (epoch, lam tron xuong phut). Guard T1/T3 dung cai nay."""
        return int(self.ts // 60) * 60

    def to_dict(self):
        """Dang JSON-serializable de ghi WAL / truyen qua queue dang dict."""
        return {"gate": self.gate, "kind": self.kind, "sym": self.sym,
                "ts": self.ts, "recv_ts": self.recv_ts, "price": self.price,
                "vol": self.vol, "acc": self.acc, "fields": self.fields,
                "field_src": self.field_src, "seq": self.seq,
                "ts_synthetic": self.ts_synthetic, "restated": self.restated}

    @classmethod
    def from_dict(cls, d):
        return cls(gate=d["gate"], kind=d["kind"], sym=d["sym"],
                   ts=float(d["ts"]), recv_ts=float(d["recv_ts"]),
                   price=d.get("price"), vol=d.get("vol"), acc=d.get("acc"),
                   fields=dict(d.get("fields") or {}),
                   field_src=dict(d.get("field_src") or {}),
                   seq=int(d.get("seq") or 0),
                   ts_synthetic=bool(d.get("ts_synthetic")),
                   restated=bool(d.get("restated")))


def envelope_from_raw(gate, rec, seq=0, fieldmap_data=None):
    """Chuyen 1 dong raw (file vm-pull 28/10 hoac ban ghi da parse) -> Envelope.

    KHONG scale lai gia tri: file raw vm-pull da duoc collector thu scale
    (bang chung: total_value UIC 88.000.000 VND). Scale trong field map chi
    danh cho parser ban tin tho GĐ1+.
    """
    from .fieldmap import translate_snapshot

    kind = rec.get("kind")
    if kind not in ("match", "snap", "snapshot", "put", "index"):
        raise ValueError(f"kind la: {kind!r}")
    kind = "snapshot" if kind == "snap" else kind
    recv_ts = float(rec["recv"])
    if "ts" in rec and rec["ts"] is not None:
        ts = float(rec["ts"])
        ts_synthetic = False
    elif "as_of" in rec and rec["as_of"] is not None:
        ts = float(rec["as_of"])
        ts_synthetic = False
    else:
        ts = recv_ts
        ts_synthetic = True
    env = Envelope(
        gate=gate,
        kind=kind,
        sym=str(rec["sym"]).upper(),
        ts=ts,
        recv_ts=recv_ts,
        seq=seq,
        ts_synthetic=ts_synthetic,
    )
    if kind == "match":
        env.price = rec.get("p")
        env.vol = rec.get("v")
        env.acc = rec.get("acc")
    else:
        snap_keys = {k: v for k, v in rec.items()
                     if k not in ("kind", "sym", "recv", "ts", "as_of")}
        env.fields, env.field_src = translate_snapshot(gate, snap_keys, fieldmap_data)
    return env
