"""SQLite session store (§6 dac ta): session.db che do WAL, synchronous=FULL.

Bang: gate_buckets (nen 1 phut cua 1 cong: [o,h,l,c,v,fts,lts]),
snapshots (snapshot moi nhat moi cong/ma), dedup (acc + fallback key, toan
phien), preopen (doan acc dau phien), restatements (bucket T3 da flush roi
moi sua), gaps (down/up cua cong), meta.
Chi consumer thread duoc goi flush()/ghi — khong lock, 1 writer.
"""
import json
import os
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS gate_buckets(
  gate TEXT NOT NULL, sym TEXT NOT NULL, minute INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL, v REAL, fts REAL, lts REAL,
  restated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(gate, sym, minute));
CREATE TABLE IF NOT EXISTS snapshots(
  gate TEXT NOT NULL, sym TEXT NOT NULL, as_of REAL NOT NULL,
  fields_json TEXT NOT NULL, field_src_json TEXT NOT NULL,
  PRIMARY KEY(gate, sym));
CREATE TABLE IF NOT EXISTS dedup(
  gate TEXT NOT NULL, sym TEXT NOT NULL, kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL, PRIMARY KEY(gate, sym, kind, dedup_key));
CREATE TABLE IF NOT EXISTS preopen(
  gate TEXT NOT NULL, sym TEXT NOT NULL, segment INTEGER NOT NULL,
  first_acc REAL NOT NULL, first_recv_ts REAL NOT NULL, first_ts REAL NOT NULL,
  resets INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(gate, sym, segment));
CREATE TABLE IF NOT EXISTS restatements(
  gate TEXT NOT NULL, sym TEXT NOT NULL, minute INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL, v REAL, fts REAL, lts REAL,
  restated_at REAL NOT NULL,
  PRIMARY KEY(gate, sym, minute));
CREATE TABLE IF NOT EXISTS gaps(
  gate TEXT NOT NULL, down_ts REAL NOT NULL, up_ts REAL,
  seconds REAL, error TEXT, msgs_lost_unknown INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


class SessionStore:
    def __init__(self, db_path):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        # Chi consumer thread duoc dung connection nay (1 writer, khong lock).
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=FULL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self):
        self.conn.close()

    # -- ghi batch (goi theo chu ky flush) --
    def flush_buckets(self, buckets):
        """buckets: {(gate, sym, minute): (o,h,l,c,v,fts,lts,restated)}."""
        self.conn.executemany(
            "INSERT INTO gate_buckets(gate,sym,minute,o,h,l,c,v,fts,lts,restated)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(gate,sym,minute) DO UPDATE SET"
            " o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,v=excluded.v,"
            " fts=excluded.fts,lts=excluded.lts,restated=excluded.restated",
            [(g, s, m, *vals) for (g, s, m), vals in buckets.items()])
        self.conn.commit()

    def flush_snapshots(self, snapshots):
        """snapshots: {(gate, sym): (as_of, fields, field_src)}."""
        self.conn.executemany(
            "INSERT INTO snapshots(gate,sym,as_of,fields_json,field_src_json)"
            " VALUES(?,?,?,?,?)"
            " ON CONFLICT(gate,sym) DO UPDATE SET as_of=excluded.as_of,"
            " fields_json=excluded.fields_json,field_src_json=excluded.field_src_json",
            [(g, s, a, json.dumps(f, ensure_ascii=False),
              json.dumps(fs, ensure_ascii=False))
             for (g, s), (a, f, fs) in snapshots.items()])
        self.conn.commit()

    def flush_dedup(self, keys):
        """keys: {(gate, sym, kind, dedup_key)} — INSERT OR IGNORE."""
        self.conn.executemany(
            "INSERT OR IGNORE INTO dedup(gate,sym,kind,dedup_key) VALUES(?,?,?,?)",
            list(keys))
        self.conn.commit()

    def flush_preopen(self, segments):
        """segments: {(gate, sym, segment): (first_acc, first_recv_ts, first_ts, resets)}."""
        self.conn.executemany(
            "INSERT INTO preopen(gate,sym,segment,first_acc,first_recv_ts,first_ts,resets)"
            " VALUES(?,?,?,?,?,?,?)"
            " ON CONFLICT(gate,sym,segment) DO UPDATE SET"
            " first_acc=excluded.first_acc,first_recv_ts=excluded.first_recv_ts,"
            " first_ts=excluded.first_ts,resets=excluded.resets",
            [(g, s, seg, *vals) for (g, s, seg), vals in segments.items()])
        self.conn.commit()

    def add_restatement(self, gate, sym, minute, bucket, restated_at):
        self.conn.execute(
            "INSERT OR REPLACE INTO restatements"
            "(gate,sym,minute,o,h,l,c,v,fts,lts,restated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (gate, sym, minute, *bucket, restated_at))
        self.conn.commit()

    def add_gap(self, gate, down_ts, up_ts, seconds, error):
        self.conn.execute(
            "INSERT INTO gaps(gate,down_ts,up_ts,seconds,error,msgs_lost_unknown)"
            " VALUES(?,?,?,?,?,1)", (gate, down_ts, up_ts, seconds, error))
        self.conn.commit()

    def set_meta(self, key, value):
        self.conn.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)",
                          (key, json.dumps(value, ensure_ascii=False)))
        self.conn.commit()

    # -- nap lai (resume) --
    def load_buckets(self):
        out = {}
        for g, s, m, o, h, l, c, v, fts, lts, r in self.conn.execute(
                "SELECT gate,sym,minute,o,h,l,c,v,fts,lts,restated FROM gate_buckets"):
            out[(g, s, m)] = (o, h, l, c, v, fts, lts, r)
        return out

    def load_snapshots(self):
        out = {}
        for g, s, a, fj, fsj in self.conn.execute(
                "SELECT gate,sym,as_of,fields_json,field_src_json FROM snapshots"):
            out[(g, s)] = (a, json.loads(fj), json.loads(fsj))
        return out

    def load_dedup_keys(self):
        return {(g, s, k, d) for g, s, k, d in self.conn.execute(
            "SELECT gate,sym,kind,dedup_key FROM dedup")}

    def load_preopen(self):
        out = {}
        for g, s, seg, fa, frt, ft, r in self.conn.execute(
                "SELECT gate,sym,segment,first_acc,first_recv_ts,first_ts,resets"
                " FROM preopen"):
            out[(g, s, seg)] = (fa, frt, ft, r)
        return out

    def load_meta(self, key, default=None):
        row = self.conn.execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default
