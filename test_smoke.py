#!/usr/bin/env python3
"""Smoke tests for the InstaBox full-universe collector trial.

Stub-only: every gate talks to a local stub server on 127.0.0.1.
No external network, no secrets, no real brokers. Run:
    python3 test_smoke.py
Exit code 0 = all cases pass.
"""

import asyncio
import json
import math
import os
import sqlite3
import struct
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, HERE)  # vendored websockets lives beside collector.py

import collector as C  # noqa: E402

from websockets.asyncio.server import serve as ws_serve  # noqa: E402

ICT = C.ICT
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}"
          + (f" -- {detail}" if detail and not cond else ""), flush=True)


# ------------------------------------------------------------ encoders

def enc_varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def enc_field(no, wt, value):
    out = bytearray(enc_varint((no << 3) | wt))
    if wt == 0:
        out += enc_varint(value)
    elif wt == 2:
        raw = value if isinstance(value, bytes) else value.encode()
        out += enc_varint(len(raw)) + raw
    return bytes(out)


def enc_msg(fields):
    out = bytearray()
    for no, wt, value in fields:
        out += enc_field(no, wt, value)
    return bytes(out)


def enc_rem(n):
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def mqtt_publish(topic, payload, version=3):
    body = struct.pack(">H", len(topic)) + topic.encode()
    if version == 5:
        body += b"\x00"  # properties length 0
    body += payload
    return b"\x30" + enc_rem(len(body)) + body


def zz(n):
    return (n << 1) ^ (n >> 63)


TS_0905 = int(datetime(2026, 10, 28, 9, 5, 0, tzinfo=ICT).timestamp())
TS_0906 = int(datetime(2026, 10, 28, 9, 6, 0, tzinfo=ICT).timestamp())


# ------------------------------------------------------- MQTT 3.1.1 stub

async def mqtt311_stub_handler(ws, script, seen):
    """script: list of (topic, payload) to publish after SUBSCRIBE."""
    msg = await ws.recv()
    assert isinstance(msg, bytes) and msg[0] == 0x10, "expected CONNECT"
    await ws.send(b"\x20\x02\x00\x00")  # CONNACK ok
    msg = await ws.recv()
    assert isinstance(msg, bytes) and (msg[0] >> 4) == 0x08, \
        "expected SUBSCRIBE"
    # parse topics
    rem, pos = C._read_remaining(msg, 1)
    pkt_id = struct.unpack(">H", msg[pos:pos + 2])[0]
    pos += 2
    topics = []
    end = pos + rem - 2
    while pos < end:
        tlen = struct.unpack(">H", msg[pos:pos + 2])[0]
        pos += 2
        topics.append(msg[pos:pos + tlen].decode())
        pos += tlen + 1
    seen["topics"] = topics
    seen["pkt_id"] = pkt_id
    await ws.send(b"\x90\x03" + struct.pack(">H", pkt_id) + b"\x00")
    for topic, payload in script:
        await ws.send(mqtt_publish(topic, payload, version=3))
    # stay open until the client goes away
    try:
        async for _ in ws:
            pass
    except Exception:
        pass


def dnse_script():
    inner_info = enc_msg([
        (13, 0, 21500), (22, 0, 500), (25, 0, 10), (17, 0, 100),
        (58, 0, 2), (18, 0, 200), (59, 0, 4), (20, 0, 800), (60, 0, 1000)])
    info = enc_msg([(41, 2, inner_info)])
    inner_tick = enc_msg([
        (7, 2, enc_msg([(1, 0, TS_0905)])),
        (5, 0, 21500), (6, 0, 100), (10, 0, 500)])
    tick = enc_msg([(45, 2, inner_tick)])
    return [
        ("quotes/krx/mdds/stockinfo/v1/roundlot/symbol/VCB", info),
        ("quotes/krx/mdds/tick/v1/roundlot/symbol/VCB", tick),
    ]


def ssi_script():
    stock = enc_msg([
        (17, 0, 21500), (18, 0, 1000), (19, 0, 90500),
        (22, 0, 21000), (23, 0, 22000), (24, 0, 20500),
        (25, 0, 21200), (26, 0, 5000), (27, 0, 107500),
        (70, 0, 1000), (71, 0, 2100), (72, 0, 2000),
        (73, 0, 4200), (83, 0, zz(8000)), (89, 2, "VCB")])
    le_item = enc_msg([
        (1, 0, 21500), (2, 0, 100), (3, 0, 5000),
        (4, 2, "09:05:01"), (6, 2, "B"), (10, 0, 90501)])
    le = enc_msg([(1, 2, le_item)])
    pe_item = enc_msg([
        (3, 2, "VCB"), (4, 0, 50), (5, 0, 1075), (6, 0, 21500),
        (9, 2, "09:05:02"), (14, 0, 30), (15, 0, 60),
        (16, 0, 40), (17, 0, 80), (18, 0, zz(8000))])
    pe = enc_msg([(1, 2, pe_item)])
    return [
        ("s/VCB/MAIN", stock),
        ("l/VCB/MAIN", le),
        ("pe", pe),
    ]


# --------------------------------------------------------- MQTT 5 stub

async def mqtt5_stub_handler(ws, script, seen):
    msg = await ws.recv()
    assert isinstance(msg, bytes) and msg[0] == 0x10, "expected CONNECT"
    assert msg[8] == 5, f"expected MQTT level 5, got {msg[8]}"
    await ws.send(b"\x20\x03\x00\x00\x00")  # CONNACK v5 ok
    msg = await ws.recv()
    assert isinstance(msg, bytes) and (msg[0] >> 4) == 0x08, \
        "expected SUBSCRIBE"
    rem, pos = C._read_remaining(msg, 1)
    pos += 2  # packet id
    pos += 1  # properties length 0
    topics = []
    end = 1 + len(enc_rem(rem)) + rem
    while pos < end:
        tlen = struct.unpack(">H", msg[pos:pos + 2])[0]
        pos += 2
        topics.append(msg[pos:pos + tlen].decode())
        pos += tlen + 1
    seen["topics"] = topics
    await ws.send(b"\x90\x03\x00\x01\x00")
    for topic, payload in script:
        await ws.send(mqtt_publish(topic, payload, version=5))
    try:
        async for _ in ws:
            pass
    except Exception:
        pass


def vnd_encode(text):
    return "".join(chr(ord(c) - i % 5) for i, c in enumerate(text))


def vnd_script():
    st = "ST|VCB|09:05:01|x|21.5|100|ext"
    sma_parts = ["SMA", "VCB", "", "", "100", "200", "", "",
                 "5", "500", "21.5", "", "", "", "1000", "800"]
    sma = "|".join(sma_parts)
    body = json.dumps([vnd_encode(st), vnd_encode(sma)])
    return [("T/10/VCB", f"d|T/10/VCB:{body}".encode())]


# ------------------------------------------------------- Socket.IO stub

async def sio_stub_handler(ws, on_events, script, seen):
    await ws.send(
        '0{"sid":"stub","upgrades":[],"pingInterval":25000,'
        '"pingTimeout":20000}')
    got40 = False
    async for msg in ws:
        if not isinstance(msg, str):
            continue
        if msg == "40" and not got40:
            got40 = True
            await ws.send('40{"sid":"stub"}')
            continue
        if msg == "2":
            await ws.send("3")
            continue
        if msg.startswith("42"):
            arr = json.loads(msg[2:])
            on_events.append(arr)
            seen["events"] = on_events
            continue
        if msg.startswith("40"):
            continue
    # connection closed; nothing more to do


async def sio_kbs_driver(ws, script, seen):
    """Wait until subscribe events arrive, then push the script."""
    events = []

    async def _handler():
        await ws.send(
            '0{"sid":"stub","upgrades":[],"pingInterval":25000,'
            '"pingTimeout":20000}')
        async for msg in ws:
            if not isinstance(msg, str):
                continue
            if msg == "40":
                await ws.send('40{"sid":"stub"}')
            elif msg == "2":
                await ws.send("3")
            elif msg.startswith("42"):
                arr = json.loads(msg[2:])
                events.append(arr)
                seen["events"] = events
                if any(a[0] in ("msg", "regs") for a in events):
                    break
        for event, payload in script:
            await ws.send("42" + json.dumps([event, payload],
                                            ensure_ascii=False))
        # Engine.IO ping -> client must answer pong "3" (skip any
        # further subscribe frames the client may still send first)
        await ws.send("2")
        seen["pong"] = False
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                pong = await asyncio.wait_for(
                    ws.recv(), deadline - time.time())
            except asyncio.TimeoutError:
                break
            if pong == "3":
                seen["pong"] = True
                break
        try:
            async for _ in ws:
                pass
        except Exception:
            pass

    await _handler()


def kbs_script():
    stock = json.dumps({"CP": 21500, "TT": 5000, "TV": 107500000,
                        "FB": 1000, "FS": 2000, "FR": 8000, "FO": 10000})
    trade = json.dumps({"FMP": 21500, "FV": 100, "AVO": 5000,
                        "FT": "09:05:01"})
    return [("PUB", f"STOCK:VCB {stock}"),
            ("PUB", f"TRADE:VCB {trade}")]


def vps_script():
    stock = {"data": {"id": 3220, "sym": "VCB", "lastPrice": 21.5,
                      "totalVol": 500, "lastVol": 10, "time": "09:05:01"}}
    board = {"data": {"id": 3250, "symbol": "VCB", "fBVol": 100,
                      "fSVolume": 200, "fBValue": 1000, "fSValue": 2000,
                      "fRoom": 800}}
    return [("stock", stock), ("board", board)]


# ------------------------------------------------------- CONNECT proxy

class ConnectProxyStub:
    """Minimal TCP proxy: handles absolute-form ws:// requests (plain
    WS through a proxy) by forwarding to the target, and CONNECT
    tunnels (wss://) by replying 200 then piping bytes. Records every
    request target it saw."""

    def __init__(self):
        self.seen = []
        self.server = None
        self.port = None

    async def start(self):
        self.server = await asyncio.start_server(
            self._handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self.port

    async def _pipe(self, reader, writer):
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _handle(self, reader, writer):
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except asyncio.IncompleteReadError:
            writer.close()
            return
        line = head.split(b"\r\n", 1)[0].decode("latin-1")
        parts = line.split(" ")
        method, target = parts[0], parts[1]
        self.seen.append((method, target))
        if method == "CONNECT":
            host, _, port = target.partition(":")
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            target_reader, target_writer = await asyncio.open_connection(
                host, int(port))
            await asyncio.gather(
                self._pipe(reader, target_writer),
                self._pipe(target_reader, writer))
            return
        # absolute-form ws:// request: rewrite to origin-form, forward
        assert target.startswith("ws://"), f"unexpected target {target}"
        rest = target[len("ws://"):]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        port = int(port or 80)
        new_head = head.replace(
            line.encode("latin-1"),
            f"GET /{path} HTTP/1.1".encode("latin-1"), 1)
        target_reader, target_writer = await asyncio.open_connection(
            host, port)
        target_writer.write(new_head)
        await target_writer.drain()
        await asyncio.gather(
            self._pipe(reader, target_writer),
            self._pipe(target_reader, writer))

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()

# ------------------------------------------------------------ cases

async def test_window_logic():
    def dt(y, mo, d, h, mi):
        return datetime(y, mo, d, h, mi, tzinfo=ICT)
    s, e = C.current_or_next_window(dt(2026, 10, 26, 7, 0))
    check("window: Mon early -> same day",
          (s.hour, s.minute) == (8, 50) and s.day == 26)
    s, e = C.current_or_next_window(dt(2026, 10, 26, 10, 0))
    check("window: Mon mid-session -> same day", s.day == 26)
    s, e = C.current_or_next_window(dt(2026, 10, 26, 15, 5))
    check("window: Mon at close -> Tue", s.day == 27)
    s, e = C.current_or_next_window(dt(2026, 10, 31, 12, 0))
    check("window: Sat -> Mon Nov 2",
          s.day == 2 and s.month == 11 and s.weekday() == 0)
    s, e = C.current_or_next_window(dt(2026, 11, 1, 12, 0))
    check("window: Sun -> Mon Nov 2", s.day == 2 and s.month == 11)
    check("session_date", C.session_date(dt(2026, 10, 28, 9, 0)) == "20261028")
    check("session_epoch",
          C.session_epoch(dt(2026, 10, 28, 12, 0), "09:17:54")
          == datetime(2026, 10, 28, 9, 17, 54,
                      tzinfo=ICT).timestamp())
    check("session_epoch bad input -> now",
          abs(C.session_epoch(dt(2026, 10, 28, 12, 0), "xx")
              - time.time()) < 5)


async def test_protobuf():
    msg = enc_msg([
        (17, 0, 21500), (26, 0, 5000), (83, 0, zz(8000)),
        (89, 2, "VCB")])
    d = C.decode_protobuf(msg, C.SSI_STOCK_SPEC)
    check("protobuf: SSI stock fields",
          d.get("matchedPrice") == 21500
          and d.get("nmTotalTradedQty") == 5000
          and d.get("remainForeignQtty") == 8000
          and d.get("stockSymbol") == "VCB", str(d))
    inner = enc_msg([(13, 0, 21500), (22, 0, 500)])
    outer = enc_msg([(41, 2, inner)])
    d2 = C.decode_protobuf(outer, {})
    m = C._nested(d2, "f41")
    check("protobuf: DNSE-style nesting",
          C._pnum(m, "f13") == 21500 and C._pnum(m, "f22", 10) == 5000,
          str(d2))
    # unknown length-delimited field holding a plain string: no crash
    d3 = C.decode_protobuf(enc_msg([(4, 2, "VCB")]), {})
    check("protobuf: unknown string field tolerated",
          isinstance(d3.get("f4"), (dict, str)))
    # zigzag negative
    d4 = C.decode_protobuf(enc_msg([(1, 0, zz(-3))]), {1: ("v", "Z")})
    check("protobuf: zigzag negative", d4.get("v") == -3, str(d4))


async def test_mqtt_packets():
    pkt = C.mqtt311_connect("cid1", "u", "p")
    parsed = C.parse_mqtt_packet(pkt, 3)
    check("mqtt311: CONNECT parses whole",
          parsed is not None and parsed[0] == 1
          and parsed[3] == len(pkt))
    sub = C.mqtt311_subscribe(7, ["a/b", "c/d"])
    parsed = C.parse_mqtt_packet(sub, 3)
    check("mqtt311: SUBSCRIBE parses whole",
          parsed is not None and parsed[0] == 8
          and parsed[3] == len(sub))
    p5 = C.mqtt5_connect("cid1", "key123")
    check("mqtt5: CONNECT flags with user",
          p5[8] == 5 and p5[9] == 0x82, f"flags={p5[9]:#x}")
    p5b = C.mqtt5_connect("cid1", "")
    check("mqtt5: CONNECT flags anonymous", p5b[9] == 0x02)
    pub1 = mqtt_publish("t/a", b"hello", version=3)
    pub2 = mqtt_publish("t/b", b"world", version=3)
    buf = pub1 + pub2
    r1 = C.parse_mqtt_packet(buf, 3)
    r2 = C.parse_mqtt_packet(buf[r1[3]:], 3)
    check("mqtt: two packets in one buffer",
          r1[1] == "t/a" and r1[2] == b"hello"
          and r2[1] == "t/b" and r2[2] == b"world")
    half = pub1[:4]
    check("mqtt: split packet -> None",
          C.parse_mqtt_packet(half, 3) is None)
    pub5 = mqtt_publish("t/c", b"data", version=5)
    r5 = C.parse_mqtt_packet(pub5, 5)
    check("mqtt5: PUBLISH properties skipped",
          r5[1] == "t/c" and r5[2] == b"data", str(r5))


async def test_validity():
    stats = {}
    snap = C.clean_snapshot("dnse", {
        "last": 21.5, "total_volume": -5, "room": 999999,
        "total_room": 10000, "buy_volume": float("nan"),
        "sell_volume": 2 ** 63, "total_value": 1e9,
        "buy_value": float("inf")}, stats)
    check("validity: bad values dropped",
          snap.get("last") == 21.5 and snap.get("total_value") == 1e9
          and "total_volume" not in snap and "room" not in snap
          and "buy_volume" not in snap and "sell_volume" not in snap
          and "buy_value" not in snap, str(snap))
    check("validity: counters",
          stats["dnse"]["sentinel"] == 4
          and stats["dnse"]["range"] == 1, str(stats))
    snap2 = C.clean_snapshot("dnse", {"total_volume": 5.0}, {})
    check("validity: integral float -> int",
          snap2["total_volume"] == 5
          and isinstance(snap2["total_volume"], int))


async def test_core_dedup_buckets(tmpdir):
    core = C.Core(tmpdir, "20261028", {})
    base = TS_0905
    ticks = [(base + 10, 21.5, 100), (base + 20, 21.8, 50),
             (base + 5, 21.2, 30), (base + 30, 21.6, 20)]
    for i, (ts, p, v) in enumerate(ticks):
        core.apply_match("dnse", "VCB", ts, p, v, 1000 + i, time.time())
    b = core.buckets["dnse"]["VCB"][base // 60 * 60]
    check("bucket: OHLCV by event time",
          b[0] == 21.2 and b[1] == 21.8 and b[2] == 21.2
          and b[3] == 21.6 and b[4] == 200
          and b[5] == base + 5 and b[6] == base + 30, str(b))
    # late tick into an earlier minute
    core.apply_match("dnse", "VCB", base + 70, 21.7, 10, 2000,
                     time.time())
    core.apply_match("dnse", "VCB", base + 15, 21.4, 5, 2001,
                     time.time())
    check("bucket: late tick counted",
          core.tick_stats["dnse"]["late"] == 1)
    # dedup: duplicate acc dropped
    core.apply_match("dnse", "VCB", base + 40, 21.5, 10, 1000,
                     time.time())
    check("dedup: duplicate acc dropped",
          core.tick_stats["dnse"]["dup_dropped"] == 1)
    # 70 distinct accs -> 64 kept; oldest evicted and seen as new again
    for acc in range(3000, 3070):
        core.apply_match("dnse", "VCB", base + 50, 21.5, 1, acc,
                         time.time())
    check("dedup: 64 kept",
          len(core._seen[("dnse", "VCB")]) == 64)
    before = core.matches
    core.apply_match("dnse", "VCB", base + 50, 21.5, 1, 3000,
                     time.time())
    check("dedup: evicted acc counts as new",
          core.matches == before + 1
          and core.tick_stats["dnse"]["dup_dropped"] == 1)
    core.apply_match("dnse", "VCB", base + 50, 21.5, 1, 3069,
                     time.time())
    check("dedup: kept acc still dropped",
          core.tick_stats["dnse"]["dup_dropped"] == 2)
    # snapshot validity at core layer
    core.apply_snapshot("dnse", "VCB", {
        "last": 21.5, "total_volume": -3, "buy_volume": 100}, time.time())
    check("core snapshot: bad field skipped, good kept",
          core.snaps["dnse"]["VCB"].get("buy_volume") == 100
          and "total_volume" not in core.snaps["dnse"]["VCB"])
    core.flush()
    # SQLite round-trip
    con = sqlite3.connect(os.path.join(tmpdir, "session.db"))
    rows = con.execute(
        "SELECT open, high, low, close, volume FROM gate_buckets"
        " WHERE gate='dnse' AND symbol='VCB'").fetchall()
    check("sqlite: gate_buckets written", len(rows) >= 1, str(rows))
    candles = con.execute(
        "SELECT symbol, minute, open, high, low, close, volume, source,"
        " session_date FROM candles WHERE symbol='VCB'").fetchall()
    check("sqlite: merged candles written", len(candles) >= 1, str(candles))
    cols = [r[1] for r in con.execute("PRAGMA table_info(candles)")]
    check("sqlite: candles schema is D1-friendly",
          cols == C.CANDLES_COLUMNS, str(cols))
    con.close()
    core.db.close()
    # resume into a fresh Core on the same dir
    core2 = C.Core(tmpdir, "20261028", {})
    b2 = core2.buckets["dnse"]["VCB"][base // 60 * 60]
    check("resume: buckets restored",
          b2[4] == b[4] and b2[3] == b[3])
    check("resume: dedup trimmed to 64",
          len(core2._seen[("dnse", "VCB")]) == 64)
    core2.db.close()


async def test_merged_foreign(tmpdir):
    core = C.Core(tmpdir, "20261028", {})
    now = time.time()
    core.apply_snapshot("dnse", "VCB", {
        "last": 21.5, "total_volume": 5000, "buy_volume": 1000,
        "room": 8000, "total_room": 10000}, now)
    core.apply_snapshot("vps", "VCB", {
        "buy_volume": 1100, "sell_volume": 2000, "room": 8100}, now)
    core.apply_snapshot("kbs", "VCB", {"buy_volume": 9999}, now)
    core.apply_snapshot("ssi-mqtt", "VCB", {"buy_volume": 8888}, now)
    core.apply_snapshot("kbs", "FPT", {"buy_volume": 500}, now)
    core.apply_snapshot("dnse", "GVR", {"last": 21.0}, now)
    core.apply_snapshot("vps", "GVR", {"total_volume": 700}, now)
    merged = core.merged_foreign()
    vcb = merged.get("VCB", {})
    check("merged foreign: DNSE wins, VPS fills gaps",
          vcb.get("buy_volume") == 1000
          and vcb.get("sell_volume") == 2000
          and vcb.get("room") == 8000
          and vcb.get("field_src", {}).get("sell_volume") == "vps"
          and vcb.get("field_src", {}).get("buy_volume") == "dnse"
          and vcb.get("normalized") is True
          and vcb.get("src") == "dnse", str(vcb))
    check("merged foreign: KBS/SSI excluded, flagged",
          "kbs" in vcb.get("excluded", {})
          and "ssi-mqtt" in vcb.get("excluded", {}))
    check("merged foreign: KBS-only symbol absent",
          "FPT" not in merged)
    check("merged foreign: missing field filled, no 0-fill",
          merged["GVR"].get("total_volume") == 700
          and "buy_volume" not in merged["GVR"], str(merged.get("GVR")))
    core.db.close()


async def test_config_resolvers():
    old_user, old_pw = os.environ.get("SSI_USER"), os.environ.get("SSI_PW")
    os.environ["SSI_USER"] = "env_u"
    os.environ["SSI_PW"] = "env_p"
    try:
        src, ep, u, p = C.resolve_ssi_config()
        check("ssi config: env wins",
              src == "env" and u == "env_u" and p == "env_p")
    finally:
        if old_user is None:
            os.environ.pop("SSI_USER", None)
        else:
            os.environ["SSI_USER"] = old_user
        if old_pw is None:
            os.environ.pop("SSI_PW", None)
        else:
            os.environ["SSI_PW"] = old_pw

    def bundle_fetcher(url):
        if url.endswith(".js"):
            return ('var x=1; MQTT_USERNAME="bundle_u";'
                    'MQTT_PASSWORD="bundle_p";'
                    'MQTT_ENDPOINT="wss://bundle.invalid/mqtt";')
        return '<html><script src="/static/app.js"></script></html>'

    src, ep, u, p = C.resolve_ssi_config(fetcher=bundle_fetcher)
    check("ssi config: bundle scrape",
          src == "bundle" and ep == "wss://bundle.invalid/mqtt"
          and u == "bundle_u" and p == "bundle_p",
          f"{src} {ep}")

    def failing_fetcher(url):
        raise ConnectionError("down")

    src, ep, u, p = C.resolve_ssi_config(fetcher=failing_fetcher)
    check("ssi config: snapshot fallback",
          src == "snapshot" and (ep, u, p) == C.SSI_SNAPSHOT)

    def vnd_fetcher(url):
        if "main." in url:
            return ('xx PRICE_STREAMING_API_KEY = "aaaaaaaaaaaaaaaa",'
                    ' "bbbbbbbbbbbbbbbb"; yy')
        return '<html><script src="static/js/main.abcdef01.js"></script></html>'

    check("vndirect key: 2nd hex string",
          C.resolve_vndirect_key(fetcher=vnd_fetcher)
          == "bbbbbbbbbbbbbbbb")
    check("vndirect key: failure -> anonymous",
          C.resolve_vndirect_key(fetcher=failing_fetcher) == "")


async def test_ssi_proxy():
    # stub MQTT 3.1.1 server for SSI
    seen = {}
    script = ssi_script()
    server = await ws_serve(
        lambda ws: mqtt311_stub_handler(ws, script, seen),
        "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    proxy = ConnectProxyStub()
    proxy_port = await proxy.start()

    async def run_gate(proxy_arg, seconds=4):
        queue = asyncio.Queue()
        stop = asyncio.Event()
        gate = C.SsiGate(
            [{"symbol": "VCB", "exchange": "HOSE"}],
            queue, stop, {},
            url=f"ws://127.0.0.1:{port}/mqtt",
            proxy=proxy_arg,
            config_resolver=lambda: ("test", "wss://unused.invalid/mqtt",
                                     "u", "p"))
        task = asyncio.create_task(gate.run())
        await asyncio.sleep(seconds)
        stop.set()
        try:
            await asyncio.wait_for(task, timeout=15)
        except asyncio.TimeoutError:
            task.cancel()
        got = []
        while not queue.empty():
            got.append(queue.get_nowait())
        return got, gate.stats

    # A: proxy set -> traffic goes through the proxy stub
    before = len(proxy.seen)
    got, stats = await run_gate(f"http://127.0.0.1:{proxy_port}")
    kinds = [g[0] for g in got]
    check("ssi proxy set: events received through proxy",
          "snap" in kinds and "match" in kinds and "put" in kinds,
          str(kinds))
    check("ssi proxy set: proxy saw the request",
          len(proxy.seen) > before
          and f"127.0.0.1:{port}" in proxy.seen[-1][1],
          str(proxy.seen))
    snap = next(g for g in got if g[0] == "snap")
    check("ssi proxy set: snapshot values",
          snap[3].get("last") == 21.5
          and snap[3].get("room") == 8000
          and snap[3].get("buy_volume") == 1000, str(snap[3]))
    # B: proxy unset -> direct, proxy stub sees nothing new
    before = len(proxy.seen)
    got2, _ = await run_gate("")
    check("ssi proxy unset: events received direct",
          any(g[0] == "snap" for g in got2))
    check("ssi proxy unset: proxy saw nothing",
          len(proxy.seen) == before, str(proxy.seen))
    await proxy.stop()
    server.close()
    await server.wait_closed()

async def test_end_to_end(tmpdir):
    rows = json.load(open(os.path.join(HERE, "universe_full.json")))
    by_sym = {r["symbol"]: r for r in rows}
    upcom = next(r for r in rows if r.get("exchange") == "UPCOM")
    universe = [by_sym["VCB"], by_sym["SHB"], upcom]
    upcom_sym = upcom["symbol"]

    dnse_seen, ssi_seen, vnd_seen = {}, {}, {}
    kbs_seen, vps_seen = {}, {}
    servers = []
    dnse_server = await ws_serve(
        lambda ws: mqtt311_stub_handler(ws, dnse_script(), dnse_seen),
        "127.0.0.1", 0)
    servers.append(dnse_server)
    ssi_server = await ws_serve(
        lambda ws: mqtt311_stub_handler(ws, ssi_script(), ssi_seen),
        "127.0.0.1", 0)
    servers.append(ssi_server)
    vnd_server = await ws_serve(
        lambda ws: mqtt5_stub_handler(ws, vnd_script(), vnd_seen),
        "127.0.0.1", 0)
    servers.append(vnd_server)

    async def kbs_handler(ws):
        await sio_kbs_driver(ws, kbs_script(), kbs_seen)

    async def vps_handler(ws):
        await sio_kbs_driver(ws, vps_script(), vps_seen)

    kbs_server = await ws_serve(kbs_handler, "127.0.0.1", 0)
    servers.append(kbs_server)
    vps_server = await ws_serve(vps_handler, "127.0.0.1", 0)
    servers.append(vps_server)

    def url(server):
        return f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    endpoints = {
        "dnse": url(dnse_server) + "/wss",
        "ssi-mqtt": url(ssi_server) + "/mqtt",
        "vndirect": url(vnd_server) + "/mqtt",
        "kbs": url(kbs_server) + "/socket.io/?EIO=4&transport=websocket",
        "vps": url(vps_server) + "/socket.io/?EIO=4&transport=websocket",
    }
    summary = await C.run_session(
        universe, tmpdir, endpoints=endpoints, ssi_proxy="",
        minutes=0.1,
        ssi_config_resolver=lambda: ("test", "wss://unused.invalid/mqtt",
                                     "u", "p"),
        vnd_key_resolver=lambda: "")
    for server in servers:
        server.close()
        await server.wait_closed()

    sess_dirs = [d for d in os.listdir(tmpdir)
                 if os.path.isdir(os.path.join(tmpdir, d))]
    check("e2e: session dir created", len(sess_dirs) == 1, str(sess_dirs))
    outdir = os.path.join(tmpdir, sess_dirs[0])
    db_path = os.path.join(outdir, "session.db")
    con = sqlite3.connect(db_path)
    n_candles = con.execute("SELECT COUNT(*) FROM candles").fetchone()[0]
    n_buckets = con.execute(
        "SELECT COUNT(*) FROM gate_buckets").fetchone()[0]
    n_snaps = con.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
    n_dedup = con.execute("SELECT COUNT(*) FROM dedup").fetchone()[0]
    con.close()
    check("e2e: candles + buckets + snapshots + dedup in SQLite",
          n_candles >= 1 and n_buckets >= 3 and n_snaps >= 3
          and n_dedup >= 1,
          f"candles={n_candles} buckets={n_buckets} snaps={n_snaps} "
          f"dedup={n_dedup}")
    raws = {f: os.path.getsize(os.path.join(outdir, f))
            for f in os.listdir(outdir) if f.startswith("raw_")}
    check("e2e: raw JSONL per gate, all non-empty",
          len(raws) == 5 and all(v > 0 for v in raws.values()),
          str(raws))
    for name in ("foreign_merged.json", "checkpoint.json",
                 "load.jsonl", "summary.json"):
        check(f"e2e: {name} written",
              os.path.exists(os.path.join(outdir, name)))
    merged = json.load(open(os.path.join(outdir, "foreign_merged.json")))
    check("e2e: merged foreign normalized from DNSE",
          merged.get("VCB", {}).get("normalized") is True
          and merged["VCB"].get("src") == "dnse", str(merged.get("VCB")))
    check("e2e: summary counts matches",
          summary.get("matches_total", 0) >= 4,
          str(summary.get("matches_total")))
    check("e2e: DNSE subscribed all 3 symbols",
          any("symbol/VCB" in t for t in dnse_seen.get("topics", []))
          and any(f"symbol/{upcom_sym}" in t
                  for t in dnse_seen.get("topics", [])),
          str(dnse_seen.get("topics", [])[:4]))
    check("e2e: SSI subscribed s/l topics + pe",
          any(t == "s/VCB/MAIN" for t in ssi_seen.get("topics", []))
          and "pe" in ssi_seen.get("topics", []))
    vnd_topics = vnd_seen.get("topics", [])
    check("e2e: VNDirect has no UPCOM topic (floor undetermined)",
          not any(t.endswith("/" + upcom_sym) for t in vnd_topics)
          and any("T/10/VCB" in t for t in vnd_topics),
          str(vnd_topics))
    check("e2e: KBS got USER + sub events",
          any(a[0] == "USER" for a in kbs_seen.get("events", []))
          and any(a[0] == "msg" for a in kbs_seen.get("events", [])))
    check("e2e: Engine.IO pong answered by both SIO gates",
          kbs_seen.get("pong") is True and vps_seen.get("pong") is True,
          f"kbs={kbs_seen.get('pong')} vps={vps_seen.get('pong')}")
    check("e2e: VPS got regs join with all symbols",
          any(a[0] == "regs" and upcom_sym in a[1]
              for a in vps_seen.get("events", [])))


async def main():
    await test_window_logic()
    await test_protobuf()
    await test_mqtt_packets()
    await test_validity()
    with tempfile.TemporaryDirectory() as tmpdir:
        await test_core_dedup_buckets(tmpdir)
    with tempfile.TemporaryDirectory() as tmpdir:
        await test_merged_foreign(tmpdir)
    await test_config_resolvers()
    await test_ssi_proxy()
    with tempfile.TemporaryDirectory() as tmpdir:
        await test_end_to_end(tmpdir)
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} PASS")
    if failed:
        for name, _, detail in failed:
            print(f"FAILED: {name} {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
