#!/usr/bin/env python3
"""Full-universe tick collector trial (InstaBox).

Fresh implementation written for the trial Chot 13:46 28/10/2026. It does
NOT reuse the Modal collector code: only wire-protocol facts (broker
hosts, topics, auth flows, message layouts, field scales) were read from
the old code, and only the foreign-normalization RULES were taken from
the best-gate map. Everything here is new code.

Architecture (from the open-source collector pattern: one task per feed,
a shared queue, no work inside receive callbacks, reconnect with
backoff, batched local writes):
  - one asyncio task per gate (DNSE, KBS, VNDirect, VPS direct; SSI via
    the SSI_PROXY_URL HTTP CONNECT proxy when set),
  - normalized ticks go onto one shared asyncio.Queue,
  - one core task aggregates 1-minute OHLCV buckets + snapshots, and
    flushes to local disk every 60 s,
  - local disk sink ONLY: raw JSONL per gate, SQLite buckets/snapshots,
    checkpoint + load + gap logs. No network publish during the session.
  - the ONLY secret is SSI_PROXY_URL from the environment. It is never
    written to any file or log.

Session window: weekdays (Mon-Fri) 08:50-15:05 ICT, derived from the
clock at runtime, never hardcoded to a date.
"""

import asyncio
import json
import math
import os
import random
import re
import resource
import signal
import sqlite3
import struct
import sys
import time
import urllib.request
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ICT = timezone(timedelta(hours=7))

# ---------------------------------------------------------------- config

GATES = ("dnse", "kbs", "vndirect", "vps", "ssi-mqtt")
# Bucket merge priority (highest first). The best-gate restriction
# applies ONLY to merged foreign flow, never to candles.
GATE_PRIORITY = ["dnse", "kbs", "vndirect", "vps", "ssi-mqtt"]
# Gates whose foreign snapshots are proven to equal the TOTAL standard
# (matched + negotiated). KBS and SSI foreign snapshots are stored
# per-gate for comparison but NEVER merged into the total.
NORMALIZED_GATES = ["dnse", "vndirect", "vps"]

FLUSH_SEC = 60
QUEUE_MAX = 50000
DEDUP_KEEP = 64          # trade ids kept per (gate, symbol)
WINDOW_START = (8, 50)   # 08:50 ICT
WINDOW_END = (15, 5)     # 15:05 ICT
LATE_DEEP_SEC = 120
ABSURD_CAP = 2 ** 62

QTY_FIELDS = ("total_volume", "total_value", "buy_volume", "buy_value",
              "sell_volume", "sell_value", "room", "total_room")
SNAP_FIELDS = ("last",) + QTY_FIELDS

# VNDirect MQTT floor codes, read from the old collector: HOSE "10",
# SHB (HNX) "02". No UPCOM floor code could be determined from the code
# read, so UPCOM symbols are NOT subscribed on VNDirect (they are still
# covered by the other four gates). Guessing a code would fabricate
# protocol facts; the gap is recorded in the session summary.
VND_FLOOR = {"HOSE": "10", "HNX": "02"}


# ---------------------------------------------------------------- time

def now_ict():
    return datetime.now(ICT)


def session_date(dt):
    return dt.strftime("%Y%m%d")


def is_weekday(dt):
    return dt.weekday() < 5


def window_bounds(day):
    start = day.replace(hour=WINDOW_START[0], minute=WINDOW_START[1],
                        second=0, microsecond=0)
    end = day.replace(hour=WINDOW_END[0], minute=WINDOW_END[1],
                      second=0, microsecond=0)
    return start, end


def current_or_next_window(now):
    """(start, end) of the session window to run: the one containing
    `now`, else the next weekday window."""
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    for ahead in range(0, 8):
        cand = day + timedelta(days=ahead)
        if not is_weekday(cand):
            continue
        start, end = window_bounds(cand)
        if now < end:
            return start, end
    raise RuntimeError("no weekday window in the next 8 days")


def session_epoch(dt, hhmmss):
    """'HH:MM:SS' (ICT session clock) -> epoch seconds."""
    try:
        h, m, s = (int(x) for x in hhmmss.split(":")[:3])
    except (ValueError, AttributeError, TypeError):
        return time.time()
    base = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    return base.timestamp() + h * 3600 + m * 60 + s


def minute_label(ts):
    return datetime.fromtimestamp(ts, ICT).strftime("%Y-%m-%dT%H:%M")


def to_float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------- validity gate

def clean_qty(gate, key, value, room_cap, stats):
    """Shared validity rule for snapshot quantity fields: NaN/inf,
    negative, or absurd values are dropped and counted; room above the
    total-room cap is dropped and counted. Returns int when integral."""
    if value is None:
        return None
    try:
        fv = float(value)
    except (TypeError, ValueError):
        return None
    st = stats.setdefault(gate, {"sentinel": 0, "range": 0})
    if math.isnan(fv) or math.isinf(fv) or fv < 0 or abs(fv) >= ABSURD_CAP:
        st["sentinel"] += 1
        return None
    out = int(fv) if fv == int(fv) else fv
    if key == "room" and room_cap is not None and out > room_cap:
        st["range"] += 1
        return None
    return out


def clean_snapshot(gate, snap, stats):
    """Layer-1 validity, applied at the adapter before the event is
    queued: bad quantity values never reach aggregator state."""
    cap = snap.get("total_room")
    if cap is not None:
        cap = clean_qty(gate, "total_room", cap, None, stats)
    out = {}
    for k, v in snap.items():
        if v is None:
            continue
        if k in QTY_FIELDS:
            v = clean_qty(gate, k, v, cap if k == "room" else None, stats)
            if v is None:
                continue
        out[k] = v
    return out


# ------------------------------------------------------------- protobuf

def read_varint(buf, pos):
    shift = 0
    val = 0
    while True:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7


def write_varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def decode_protobuf(buf, spec):
    """Minimal protobuf wire decoder.

    spec: {field_no: (name, kind)}; kind 'i'/'u' varint, 'z'/'Z'
    zigzag varint, 's' UTF-8 string, 'f' float32, 'd' float64,
    'n' repeated nested message with sub-spec in spec[2].
    Unknown fields are kept as f<no> (nested decode attempted for
    length-delimited fields, placeholder on failure)."""
    out = {}
    pos = 0
    while pos < len(buf):
        tag, pos = read_varint(buf, pos)
        no, wt = tag >> 3, tag & 7
        field = spec.get(no)
        if wt == 0:
            v, pos = read_varint(buf, pos)
            if field is None:
                out[f"f{no}"] = v
                continue
            name, kind = field[0], field[1]
            if kind in ("z", "Z"):
                v = (v >> 1) ^ -(v & 1)
            out[name] = v
        elif wt == 2:
            ln, pos = read_varint(buf, pos)
            raw = buf[pos:pos + ln]
            pos += ln
            if field is None:
                try:
                    out[f"f{no}"] = decode_protobuf(raw, {})
                except Exception:
                    out[f"f{no}"] = f"<{ln}b>"
                continue
            name, kind = field[0], field[1]
            if kind == "s":
                out[name] = raw.decode("utf-8", "replace")
            elif kind == "n":
                out.setdefault(name, []).append(
                    decode_protobuf(raw, field[2]))
            else:
                out[name] = raw
        elif wt == 5:
            v = struct.unpack("<f", buf[pos:pos + 4])[0]
            pos += 4
            out[field[0] if field else f"f{no}"] = v
        elif wt == 1:
            v = struct.unpack("<d", buf[pos:pos + 8])[0]
            pos += 8
            out[field[0] if field else f"f{no}"] = v
        else:
            break
    return out


def encode_protobuf(pairs):
    """Test/small helper: pairs of (field_no, wire_type, value). Only
    used by the smoke-test stubs via import; the collector never sends
    protobuf."""
    out = bytearray()
    for no, wt, value in pairs:
        out += write_varint((no << 3) | wt)
        if wt == 0:
            out += write_varint(value)
        elif wt == 2:
            raw = value if isinstance(value, bytes) else value.encode()
            out += write_varint(len(raw)) + raw
        elif wt == 5:
            out += struct.pack("<f", value)
        elif wt == 1:
            out += struct.pack("<d", value)
    return bytes(out)


# ------------------------------------------------------- MQTT wire format

def _enc_str(s):
    b = s.encode()
    return struct.pack(">H", len(b)) + b


def _enc_remaining(n):
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _read_remaining(buf, pos):
    mult = 1
    rem = 0
    while True:
        b = buf[pos]
        pos += 1
        rem += (b & 0x7F) * mult
        if not (b & 0x80):
            return rem, pos
        mult *= 128


def mqtt311_connect(cid, user, pw, keepalive=60):
    body = (_enc_str("MQTT") + bytes([4, 0xC2])
            + struct.pack(">H", keepalive)
            + _enc_str(cid) + _enc_str(user) + _enc_str(pw))
    return b"\x10" + _enc_remaining(len(body)) + body


def mqtt311_subscribe(pkt_id, topics):
    body = struct.pack(">H", pkt_id)
    for t in topics:
        body += _enc_str(t) + b"\x00"
    return b"\x82" + _enc_remaining(len(body)) + body


def mqtt5_connect(cid, user, keepalive=60):
    flags = 0x82 if user else 0x02  # username flag + clean start
    body = (_enc_str("MQTT") + bytes([5, flags])
            + struct.pack(">H", keepalive) + b"\x00")  # properties len 0
    payload = _enc_str(cid)
    if user:
        payload += _enc_str(user)
    body += payload
    return b"\x10" + _enc_remaining(len(body)) + body


def mqtt5_subscribe(pkt_id, topics):
    body = struct.pack(">H", pkt_id) + b"\x00"  # properties len 0
    for t in topics:
        body += _enc_str(t) + b"\x00"
    return b"\x82" + _enc_remaining(len(body)) + body


def parse_mqtt_packet(buf, version):
    """Extract one complete MQTT packet from buf.
    Returns (packet_type, topic, payload, consumed) or None if the
    buffer does not hold a complete packet yet."""
    if len(buf) < 2:
        return None
    try:
        rem, pos = _read_remaining(buf, 1)
    except IndexError:
        return None
    end = pos + rem
    if len(buf) < end:
        return None
    ptype = buf[0] >> 4
    if ptype == 2:  # CONNACK
        if version == 5:
            reason = buf[pos + 1] if pos + 1 < end else 1
            return (2, None, bytes([reason]), end)
        rc = buf[pos + 1] if pos + 1 < end else 1
        return (2, None, bytes([rc]), end)
    if ptype != 3:  # PUBLISH only; acks/pings are skipped by caller
        return (ptype, None, b"", end)
    p = pos
    tlen = struct.unpack(">H", buf[p:p + 2])[0]
    p += 2
    topic = buf[p:p + tlen].decode("utf-8", "replace")
    p += tlen
    if buf[0] & 0x06:  # QoS > 0: packet id
        p += 2
    if version == 5:
        plen, p = _read_remaining(buf, p)
        p += plen
    return (3, topic, buf[p:end], end)


PINGREQ = b"\xc0\x00"

# ------------------------------------------------------------ transports

class MqttConnection:
    """MQTT 3.1.1 or 5.0 over a websocket. One connection: connect,
    subscribe, then yield (topic, payload) for PUBLISH packets.
    Reconnect/backoff lives in the gate task, not here."""

    def __init__(self, url, version, client_id, user, password, topics,
                 origin=None, proxy=None, subprotocol="mqtt"):
        self.url = url
        self.version = version
        self.client_id = client_id
        self.user = user
        self.password = password
        self.topics = topics
        self.origin = origin
        self.proxy = proxy
        self.subprotocol = subprotocol

    async def stream(self, stop, on_ready=None, silent_sec=0,
                     silent_active=None):
        """Async generator of (topic, payload). Raises on any protocol
        or transport error so the gate task can reconnect. on_ready is
        awaited once the subscription is accepted. When silent_sec > 0
        and no message arrives for that long while silent_active()
        is true, raises so the gate task reconnects."""
        from websockets.asyncio.client import connect
        kw = {}
        if self.proxy:
            kw["proxy"] = self.proxy
        headers = {"User-Agent": "Mozilla/5.0"}
        async with connect(
                self.url, subprotocols=[self.subprotocol],
                open_timeout=20, ping_interval=None,
                additional_headers=headers, max_size=8 * 1024 * 1024,
                origin=self.origin, **kw) as ws:
            if self.version == 5:
                await ws.send(mqtt5_connect(self.client_id, self.user))
            else:
                await ws.send(mqtt311_connect(
                    self.client_id, self.user, self.password))
            first = await asyncio.wait_for(ws.recv(), 20)
            if not isinstance(first, bytes):
                raise ConnectionError("CONNACK not binary")
            parsed = parse_mqtt_packet(first, self.version)
            if parsed is None or parsed[0] != 2 or parsed[2] != b"\x00":
                raise ConnectionError(f"CONNACK refused: {first!r:.40}")
            if self.version == 5:
                await ws.send(mqtt5_subscribe(1, self.topics))
            else:
                await ws.send(mqtt311_subscribe(1, self.topics))
            if on_ready is not None:
                await on_ready()
            buf = bytearray()
            last_ping = time.time()
            last_rx = time.time()
            while not stop.is_set():
                if time.time() - last_ping > 25:
                    await ws.send(PINGREQ)
                    last_ping = time.time()
                try:
                    msg = await asyncio.wait_for(ws.recv(), 10)
                except asyncio.TimeoutError:
                    await ws.send(PINGREQ)
                    last_ping = time.time()
                    if silent_sec and time.time() - last_rx > silent_sec \
                            and (silent_active is None or silent_active()):
                        raise ConnectionError(
                            f"silent watchdog: "
                            f"{round(time.time() - last_rx)}s no message")
                    continue
                if not isinstance(msg, bytes) or not msg:
                    continue
                last_rx = time.time()
                buf += msg
                while True:
                    parsed = parse_mqtt_packet(bytes(buf), self.version)
                    if parsed is None:
                        break
                    ptype, topic, payload, consumed = parsed
                    del buf[:consumed]
                    if ptype == 3 and topic is not None:
                        yield topic, payload


class SioConnection:
    """Minimal Socket.IO client on Engine.IO v4: open -> 40, ping 2
    -> pong 3, 40 -> connected callback, 42[event, payload] -> events."""

    def __init__(self, url, origin=None):
        self.url = url
        self.origin = origin
        self._ws = None

    async def send_event(self, event, payload):
        if self._ws is not None:
            await self._ws.send("42" + json.dumps(
                [event, payload], ensure_ascii=False))

    async def stream(self, stop, on_connected):
        """Async generator of (event, payload). Raises on transport
        error or 30 s of silence so the gate task can reconnect."""
        from websockets.asyncio.client import connect
        headers = {"User-Agent": "Mozilla/5.0"}
        async with connect(
                self.url, ping_interval=None, open_timeout=20,
                max_size=16 * 1024 * 1024,
                additional_headers=headers,
                origin=self.origin) as ws:
            self._ws = ws
            last_rx = time.time()
            while not stop.is_set():
                try:
                    msg = await asyncio.wait_for(ws.recv(), 5)
                except asyncio.TimeoutError:
                    if stop.is_set():
                        return
                    if time.time() - last_rx > 30:
                        raise ConnectionError("idle 30s")
                    continue
                last_rx = time.time()
                if isinstance(msg, bytes):
                    continue
                if msg.startswith("0"):
                    await ws.send("40")
                elif msg == "2":
                    await ws.send("3")
                elif msg.startswith("40"):
                    await on_connected(self)
                elif msg.startswith("42"):
                    try:
                        arr = json.loads(msg[2:])
                        yield arr[0], arr[1] if len(arr) > 1 else None
                    except (ValueError, IndexError, TypeError):
                        continue


# ------------------------------------------------------- gate statistics

class GateStats:
    def __init__(self, name):
        self.name = name
        self.msgs = 0
        self.matches = 0
        self.snapshots = 0
        self.puts = 0
        self.connected = False
        self.last_error = ""
        self.last_msg = 0.0
        self.gaps = []          # [{down, up, seconds, error}]
        self._down_since = None
        self._down_error = ""

    def mark_up(self):
        if self._down_since is not None:
            up = time.time()
            self.gaps.append({
                "down": datetime.fromtimestamp(
                    self._down_since, ICT).strftime("%H:%M:%S"),
                "up": datetime.fromtimestamp(up, ICT).strftime("%H:%M:%S"),
                "seconds": round(up - self._down_since, 1),
                "error": self._down_error})
            self._down_since = None
        self.connected = True

    def mark_down(self, error):
        if self._down_since is None:
            self._down_since = time.time()
            self._down_error = error
        self.connected = False
        self.last_error = error

    def close_open_gap(self):
        if self._down_since is not None:
            self.gaps.append({
                "down": datetime.fromtimestamp(
                    self._down_since, ICT).strftime("%H:%M:%S"),
                "up": None,
                "seconds": None,
                "error": self._down_error})
            self._down_since = None


BACKOFF_SEQ = (2, 5, 15, 30, 60)


class BaseGate:
    """One asyncio task: reconnect loop with backoff + gap logging.
    Subclasses implement stream() and feed parsed events into the
    shared queue. Parsing only happens here; aggregation lives in
    the core task."""

    name = "gate"

    def __init__(self, universe, queue, stop, validity_stats):
        self.universe = universe
        self.queue = queue
        self.stop = stop
        self.validity_stats = validity_stats
        self.stats = GateStats(self.name)

    async def run(self):
        attempt = 0
        while not self.stop.is_set():
            try:
                await self.stream()
                if self.stop.is_set():
                    break
                raise ConnectionError("stream ended without stop")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reconnect on all
                err = f"{type(exc).__name__}: {str(exc)[:120]}"
                self.stats.mark_down(err)
                print(f"[{self.name}] loi: {err}", flush=True)
                if self.stop.is_set():
                    break
                wait = BACKOFF_SEQ[min(attempt, len(BACKOFF_SEQ) - 1)]
                attempt += 1
                try:
                    await asyncio.wait_for(self.stop.wait(), wait)
                except asyncio.TimeoutError:
                    pass
                else:
                    break
        self.stats.close_open_gap()

    async def stream(self):
        raise NotImplementedError

    async def emit(self, event):
        await self.queue.put(event)


# ------------------------------------------------------------ SSI config

SSI_SNAPSHOT = ("wss://price-streaming.ssi.com.vn/mqtt",
                "mqtt-ssi", "mqtt-ssi")
SSI_STOCK_SPEC = {
    17: ("matchedPrice", "i"), 18: ("matchedVolume", "i"),
    19: ("matchedTime", "i"), 22: ("openPrice", "i"),
    23: ("highest", "i"), 24: ("lowest", "i"),
    25: ("avgPrice", "i"), 26: ("nmTotalTradedQty", "i"),
    27: ("nmTotalTradedValue", "i"),
    70: ("buyForeignQtty", "i"), 71: ("buyForeignValue", "i"),
    72: ("sellForeignQtty", "i"), 73: ("sellForeignValue", "i"),
    83: ("remainForeignQtty", "Z"), 89: ("stockSymbol", "s"),
}
SSI_LE_SPEC = {1: ("items", "n", {
    1: ("price", "u"), 2: ("vol", "u"), 3: ("accumulatedVol", "i"),
    4: ("time", "s"), 6: ("side", "s"), 10: ("sendingTime", "i")})}
SSI_PE_SPEC = {1: ("items", "n", {
    3: ("stockSymbol", "s"), 4: ("vol", "i"), 5: ("val", "i"),
    6: ("price", "i"), 9: ("time", "s"),
    14: ("buyForeignQtty", "i"), 15: ("buyForeignValue", "i"),
    16: ("sellForeignQtty", "i"), 17: ("sellForeignValue", "i"),
    18: ("remainForeignQtty", "Z")})}


def _http_get_text(url, timeout=30):
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def resolve_ssi_config(fetcher=None):
    """(source, endpoint, user, password). Source is 'env', 'bundle',
    or 'snapshot'. Values are NEVER logged; only the source is."""
    fetch = fetcher or _http_get_text
    user = os.environ.get("SSI_USER")
    pw = os.environ.get("SSI_PW")
    if user and pw:
        return "env", SSI_SNAPSHOT[0], user, pw
    try:
        html = fetch("https://fiintrade.ssi.com.vn/")
        assets = re.findall(r'(?:src|href)="([^"]+\.js)"', html)
        for asset in assets:
            url = asset if asset.startswith("http") \
                else "https://fiintrade.ssi.com.vn/" + asset.lstrip("/")
            try:
                js = fetch(url)
            except Exception:
                continue
            m1 = re.search(r'MQTT_USERNAME="([^"]*)"', js)
            m2 = re.search(r'MQTT_PASSWORD="([^"]*)"', js)
            if m1 and m2:
                m3 = re.search(r'MQTT_ENDPOINT="([^"]*)"', js)
                ep = m3.group(1) if m3 else SSI_SNAPSHOT[0]
                return "bundle", ep, m1.group(1), m2.group(1)
    except Exception:
        pass
    return "snapshot", SSI_SNAPSHOT[0], SSI_SNAPSHOT[1], SSI_SNAPSHOT[2]


def resolve_vndirect_key(fetcher=None):
    """Free price-streaming key scraped from the public banggia
    bundle; '' when it cannot be found (the broker also accepts
    anonymous connections). The key value is NEVER logged."""
    fetch = fetcher or _http_get_text
    try:
        html = fetch("https://banggia.vndirect.com.vn/")
        m = re.search(r'static/js/main\.[a-f0-9]+\.js', html)
        if not m:
            return ""
        js = fetch("https://banggia.vndirect.com.vn/" + m.group(0))
        i = js.find("PRICE_STREAMING_API_KEY")
        seg = js[i:i + 400] if i >= 0 else ""
        keys = re.findall(r'"([0-9a-f]{16,})"', seg)
        if keys:
            return keys[1] if len(keys) > 1 else keys[0]
    except Exception:
        pass
    return ""


# ---------------------------------------------------------------- gates

def _nested(node, key):
    """First dict of node[key] when it is a list of dicts, else the
    dict itself, else {} (DNSE protobuf nesting)."""
    v = node.get(key)
    if isinstance(v, list) and v and isinstance(v[0], dict):
        return v[0]
    return v if isinstance(v, dict) else {}


def _pnum(node, key, scale=1):
    v = node.get(key)
    if isinstance(v, list):
        v = v[0] if v else None
    if isinstance(v, (int, float)):
        return v * scale
    return None


class DnseGate(BaseGate):
    name = "dnse"
    URL = "wss://datafeed-krx.dnse.com.vn/wss"

    def __init__(self, universe, queue, stop, validity_stats,
                 url=None):
        super().__init__(universe, queue, stop, validity_stats)
        self.url = url or self.URL

    async def stream(self):
        topics = []
        for row in self.universe:
            s = row["symbol"]
            topics.append(
                f"quotes/krx/mdds/stockinfo/v1/roundlot/symbol/{s}")
            topics.append(
                f"quotes/krx/mdds/tick/v1/roundlot/symbol/{s}")
        async def _ready():
            self.stats.mark_up()

        conn = MqttConnection(
            self.url, 3, "tick-" + "".join(
                random.choices("abcdef0123456789", k=8)),
            "entrade", "entrade", topics,
            origin="https://banggia.dnse.com.vn")
        async for topic, payload in conn.stream(self.stop, _ready):
            self.stats.msgs += 1
            self.stats.last_msg = time.time()
            await self._on_msg(topic, payload)

    async def _on_msg(self, topic, payload):
        try:
            d = decode_protobuf(payload, {})
            if "stockinfo" in topic:
                m = _nested(d, "f41")
                sym = topic.rsplit("/", 1)[-1]
                snap = clean_snapshot(self.name, {
                    "last": _pnum(m, "f13"),
                    "total_volume": _pnum(m, "f22", 10),
                    "total_value": _pnum(m, "f25", 10 ** 9),
                    "buy_volume": _pnum(m, "f17", 10),
                    "buy_value": _pnum(m, "f58", 10 ** 9),
                    "sell_volume": _pnum(m, "f18", 10),
                    "sell_value": _pnum(m, "f59", 10 ** 9),
                    "room": _pnum(m, "f20", 10),
                    "total_room": _pnum(m, "f60", 10),
                }, self.validity_stats)
                self.stats.snapshots += 1
                await self.emit(
                    ("snap", self.name, sym, snap, time.time()))
            elif "/tick/" in topic:
                m = _nested(d, "f45")
                sym = topic.rsplit("/", 1)[-1]
                ts_node = _nested(m, "f7")
                ts = _pnum(ts_node, "f1") or time.time()
                price = _pnum(m, "f5")
                vol = _pnum(m, "f6", 10)
                if price and vol:
                    self.stats.matches += 1
                    await self.emit(
                        ("match", self.name, sym, ts, price, vol,
                         _pnum(m, "f10", 10)))
        except Exception as exc:  # noqa: BLE001
            print(f"[dnse] decode loi {topic}: {str(exc)[:100]}",
                  flush=True)


class KbsGate(BaseGate):
    name = "kbs"
    URL = ("wss://kbbuddyrt.kbsec.com.vn/socket.io/"
           "?EIO=4&transport=websocket")
    USER_ID = "091C222333"  # guest id from the public KB Buddy bundle

    def __init__(self, universe, queue, stop, validity_stats,
                 url=None):
        super().__init__(universe, queue, stop, validity_stats)
        self.url = url or self.URL

    async def stream(self):
        conn = SioConnection(self.url)

        async def _connected(client):
            self.stats.mark_up()
            await client.send_event("USER", self.USER_ID)
            batch = []
            for row in self.universe:
                s = row["symbol"]
                batch += [f"STOCK:{s}", f"TRADE:{s}"]
                if len(batch) >= 16:
                    await client.send_event(
                        "msg", "sub+" + "+".join(batch))
                    batch = []
            if batch:
                await client.send_event("msg", "sub+" + "+".join(batch))
            await client.send_event(
                "msg", "sub+INDEX:VNINDEX+INDEX:VN30")

        async for event, payload in conn.stream(self.stop, _connected):
            self.stats.msgs += 1
            self.stats.last_msg = time.time()
            await self._on_event(event, payload)

    async def _on_event(self, event, payload):
        if event != "PUB" or not isinstance(payload, str):
            return
        try:
            head, _, body = payload.partition(" ")
            typ, _, sym = head.partition(":")
            d = json.loads(body)
            if typ == "STOCK":
                cp = to_float(d.get("CP"))
                snap = clean_snapshot(self.name, {
                    "last": cp / 1000 if cp else None,
                    "total_volume": to_float(d.get("TT")),
                    "total_value": to_float(d.get("TV")),
                    "buy_volume": to_float(d.get("FB")),
                    "sell_volume": to_float(d.get("FS")),
                    "room": to_float(d.get("FR")),
                    "total_room": to_float(d.get("FO")),
                }, self.validity_stats)
                self.stats.snapshots += 1
                await self.emit(
                    ("snap", self.name, sym, snap, time.time()))
            elif typ == "TRADE":
                price = to_float(d.get("FMP"))
                vol = to_float(d.get("FV"))
                if price and vol:
                    self.stats.matches += 1
                    await self.emit(
                        ("match", self.name, sym,
                         session_epoch(now_ict(), d.get("FT", "")),
                         price / 1000, vol, to_float(d.get("AVO"))))
        except Exception as exc:  # noqa: BLE001
            print(f"[kbs] decode loi: {str(exc)[:100]}", flush=True)


class VndirectGate(BaseGate):
    name = "vndirect"
    URL = "wss://price-streaming-free.vndirect.com.vn/mqtt"

    def __init__(self, universe, queue, stop, validity_stats,
                 url=None, key_resolver=None):
        super().__init__(universe, queue, stop, validity_stats)
        self.url = url or self.URL
        self.key_resolver = key_resolver or resolve_vndirect_key
        self._seen_ticks = OrderedDict()

    def _topics(self):
        topics = []
        for row in self.universe:
            sym = row["symbol"]
            floor = VND_FLOOR.get(row.get("exchange"))
            if floor is None:
                continue  # UPCOM floor code undetermined; see header
            topics.append(f"T/{floor}/{sym}")
        topics += ["10/+", "02/+", "MI/10"]
        return topics

    async def stream(self):
        key = self.key_resolver()
        print(f"[vndirect] key: {'found' if key else 'anonymous'}",
              flush=True)
        async def _ready():
            self.stats.mark_up()

        conn = MqttConnection(
            self.url, 5, "free-user-" + "".join(
                random.choices("abcdef0123456789", k=8)),
            key, "", self._topics(),
            origin="https://banggia.vndirect.com.vn")
        async for topic, payload in conn.stream(self.stop, _ready):
            self.stats.msgs += 1
            self.stats.last_msg = time.time()
            await self._on_payload(payload)

    @staticmethod
    def _decode(raw):
        return "".join(chr(ord(c) + i % 5) for i, c in enumerate(raw))

    async def _on_payload(self, payload):
        try:
            text = payload.decode("utf-8", "replace")
            if not text.startswith("d|"):
                return
            _, _, body = text[2:].partition(":")
            msgs = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return
        for raw in msgs if isinstance(msgs, list) else []:
            try:
                await self._on_msg(self._decode(raw))
            except Exception:
                continue

    async def _on_msg(self, text):
        parts = text.split("|")
        kind = parts[0]
        if kind == "ST" and len(parts) >= 6:
            sym = parts[1]
            price, vol = to_float(parts[4]), to_float(parts[5])
            if not price or not vol:
                return
            key = (sym, parts[2], price, vol,
                   parts[6] if len(parts) > 6 else "")
            if key in self._seen_ticks:
                return
            self._seen_ticks[key] = None
            if len(self._seen_ticks) > 65536:
                self._seen_ticks.popitem(last=False)
            self.stats.matches += 1
            await self.emit(
                ("match", self.name, sym,
                 session_epoch(now_ict(), parts[2]),
                 price, vol * 10, None))
        elif kind == "SMA" and len(parts) >= 16:
            sym = parts[1]
            tv = to_float(parts[8])
            snap = clean_snapshot(self.name, {
                "last": to_float(parts[10]),
                "total_volume": (to_float(parts[9]) or 0) * 10
                if to_float(parts[9]) is not None else None,
                "total_value": tv * 10 ** 6
                if tv is not None else None,
                "buy_volume": (to_float(parts[4]) or 0) * 10
                if to_float(parts[4]) is not None else None,
                "sell_volume": (to_float(parts[5]) or 0) * 10
                if to_float(parts[5]) is not None else None,
                "room": (to_float(parts[15]) or 0) * 10
                if to_float(parts[15]) is not None else None,
                "total_room": (to_float(parts[14]) or 0) * 10
                if to_float(parts[14]) is not None else None,
            }, self.validity_stats)
            self.stats.snapshots += 1
            await self.emit(
                ("snap", self.name, sym, snap, time.time()))


class VpsGate(BaseGate):
    name = "vps"
    URL = ("wss://bgdatafeed.vps.com.vn/socket.io/"
           "?EIO=4&transport=websocket")

    def __init__(self, universe, queue, stop, validity_stats,
                 url=None):
        super().__init__(universe, queue, stop, validity_stats)
        self.url = url or self.URL

    async def stream(self):
        conn = SioConnection(self.url)

        async def _connected(client):
            self.stats.mark_up()
            await client.send_event("regs", json.dumps(
                {"action": "join",
                 "list": ",".join(r["symbol"] for r in self.universe)}))

        async for event, payload in conn.stream(self.stop, _connected):
            self.stats.msgs += 1
            self.stats.last_msg = time.time()
            await self._on_event(event, payload)

    async def _on_event(self, event, payload):
        try:
            if event == "stock":
                d = (payload or {}).get("data") or {}
                if d.get("id") != 3220 or not d.get("sym"):
                    return
                sym = d["sym"]
                last = to_float(d.get("lastPrice"))
                tvol = to_float(d.get("totalVol"))
                snap = clean_snapshot(self.name, {
                    "last": last,
                    "total_volume": tvol * 10
                    if tvol is not None else None,
                }, self.validity_stats)
                self.stats.snapshots += 1
                await self.emit(
                    ("snap", self.name, sym, snap, time.time()))
                lvol = to_float(d.get("lastVol"))
                if last and lvol:
                    self.stats.matches += 1
                    await self.emit(
                        ("match", self.name, sym,
                         session_epoch(now_ict(), d.get("time") or ""),
                         last, lvol * 10,
                         tvol * 10 if tvol is not None else None))
            elif event == "board":
                d = (payload or {}).get("data") or {}
                if d.get("id") != 3250 or not d.get("symbol"):
                    return
                bv, sv = to_float(d.get("fBVol")), to_float(d.get("fSVolume"))
                bval, sval = to_float(d.get("fBValue")), to_float(d.get("fSValue"))
                room = to_float(d.get("fRoom"))
                snap = clean_snapshot(self.name, {
                    "buy_volume": bv * 10 if bv is not None else None,
                    "sell_volume": sv * 10 if sv is not None else None,
                    "buy_value": bval * 1000
                    if bval is not None else None,
                    "sell_value": sval * 1000
                    if sval is not None else None,
                    "room": room * 10 if room is not None else None,
                }, self.validity_stats)
                self.stats.snapshots += 1
                await self.emit(
                    ("snap", self.name, d["symbol"], snap, time.time()))
        except Exception as exc:  # noqa: BLE001
            print(f"[vps] decode loi: {str(exc)[:100]}", flush=True)


class SsiGate(BaseGate):
    name = "ssi-mqtt"

    def __init__(self, universe, queue, stop, validity_stats,
                 url=None, proxy=None, config_resolver=None):
        super().__init__(universe, queue, stop, validity_stats)
        self.url_override = url
        self.proxy = proxy if proxy is not None \
            else (os.environ.get("SSI_PROXY_URL") or None)
        self.config_resolver = config_resolver or resolve_ssi_config

    async def stream(self):
        source, ep, user, pw = self.config_resolver()
        print(f"[ssi-mqtt] config: {source} "
              f"proxy: {'set' if self.proxy else 'unset'}", flush=True)
        topics = []
        for row in self.universe:
            s = row["symbol"]
            topics += [f"s/{s}/MAIN", f"l/{s}/MAIN"]
        topics += ["pe", "i/VNINDEX", "i/VN30"]
        async def _ready():
            self.stats.mark_up()

        def _in_trading():
            hm = now_ict().hour * 60 + now_ict().minute
            return (540 <= hm < 690) or (780 <= hm < 900)

        conn = MqttConnection(
            self.url_override or ep, 3, "tick-" + "".join(
                random.choices("abcdef0123456789", k=8)),
            user, pw, topics,
            origin="https://fiintrade.ssi.com.vn",
            proxy=self.proxy)
        async for topic, payload in conn.stream(
                self.stop, _ready, silent_sec=90,
                silent_active=_in_trading):
            self.stats.msgs += 1
            self.stats.last_msg = time.time()
            await self._on_msg(topic, payload)

    async def _on_msg(self, topic, payload):
        try:
            if topic.startswith("s/"):
                d = decode_protobuf(payload, SSI_STOCK_SPEC)
                sym = d.get("stockSymbol") or topic.split("/")[1]
                if d.get("matchedPrice"):
                    snap = clean_snapshot(self.name, {
                        "last": d["matchedPrice"] / 1000,
                        "total_volume": d.get("nmTotalTradedQty"),
                        "total_value": d.get("nmTotalTradedValue"),
                        "buy_volume": d.get("buyForeignQtty"),
                        "buy_value": d.get("buyForeignValue"),
                        "sell_volume": d.get("sellForeignQtty"),
                        "sell_value": d.get("sellForeignValue"),
                        "room": d.get("remainForeignQtty"),
                    }, self.validity_stats)
                    self.stats.snapshots += 1
                    await self.emit(
                        ("snap", self.name, sym, snap, time.time()))
            elif topic.startswith("l/"):
                sym = topic.split("/")[1]
                d = decode_protobuf(payload, SSI_LE_SPEC)
                for it in d.get("items", []):
                    if it.get("price") and it.get("vol"):
                        self.stats.matches += 1
                        await self.emit(
                            ("match", self.name, sym,
                             session_epoch(now_ict(),
                                           it.get("time", "")),
                             it["price"] / 1000, it["vol"],
                             it.get("accumulatedVol")))
            elif topic == "pe":
                d = decode_protobuf(payload, SSI_PE_SPEC)
                for it in d.get("items", []):
                    if it.get("stockSymbol"):
                        self.stats.puts += 1
                        await self.emit(
                            ("put", self.name, it["stockSymbol"], dict(it),
                             session_epoch(now_ict(),
                                           it.get("time", ""))))
        except Exception as exc:  # noqa: BLE001
            print(f"[ssi] decode loi {topic}: {str(exc)[:100]}", flush=True)


GATE_CLASSES = {
    "dnse": DnseGate,
    "kbs": KbsGate,
    "vndirect": VndirectGate,
    "vps": VpsGate,
    "ssi-mqtt": SsiGate,
}

# ------------------------------------------------------------- core store

CANDLES_COLUMNS = ["symbol", "minute", "open", "high", "low", "close",
                   "volume", "source", "session_date"]


class Core:
    """Owns all aggregation state. Single task: drains the shared
    queue, applies events, and flushes to disk every FLUSH_SEC.
    No other task touches this state, so no locks are needed."""

    def __init__(self, outdir, session_date, gate_stats):
        self.outdir = outdir
        self.session_date = session_date
        self.gate_stats = gate_stats  # {gate: GateStats}
        self.buckets = {}   # gate -> sym -> minute -> [o,h,l,c,v,fts,lts]
        self.snaps = {}     # gate -> sym -> {field: value}
        self.put = {}       # sym -> accumulated SSI negotiated fields
        self._seen = {}     # (gate, sym) -> OrderedDict[acc, None]
        self._max_acc = {}
        self._max_minute = {}
        self._wm = {}
        self._seq = 0
        self._new_accs = []  # (gate, sym, acc, seq) since last flush
        self.tick_stats = {}  # gate -> counters
        self.validity_stats = {}
        self.matches = 0
        self.matches_by_gate = {}
        self.symbols_with_ticks = set()
        self.dirty_buckets = set()   # (gate, sym, minute)
        self.dirty_merged = set()    # (sym, minute)
        self.dirty_snaps = set()     # (gate, sym)
        self.dirty_put = set()       # sym
        self.raw_lines = {}          # gate -> [json lines]
        self.flush_count = 0
        self.started_wall = time.time()
        self._last_cpu = None
        self._last_cpu_wall = None
        self._last_gate_msgs = {}
        self._last_load_wall = None

        os.makedirs(outdir, exist_ok=True)
        self.db_path = os.path.join(outdir, "session.db")
        self.db = sqlite3.connect(self.db_path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self._init_schema()
        self._resume()

    def _init_schema(self):
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS gate_buckets(
          gate TEXT NOT NULL, symbol TEXT NOT NULL, minute TEXT NOT NULL,
          open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
          close REAL NOT NULL, volume INTEGER NOT NULL,
          first_ts REAL NOT NULL, last_ts REAL NOT NULL,
          PRIMARY KEY (gate, symbol, minute));
        CREATE TABLE IF NOT EXISTS candles(
          symbol TEXT NOT NULL, minute TEXT NOT NULL,
          open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
          close REAL NOT NULL, volume INTEGER NOT NULL,
          source TEXT NOT NULL, session_date TEXT NOT NULL,
          PRIMARY KEY (symbol, minute));
        CREATE TABLE IF NOT EXISTS snapshots(
          gate TEXT NOT NULL, symbol TEXT NOT NULL,
          last REAL, total_volume INTEGER, total_value REAL,
          buy_volume INTEGER, buy_value REAL,
          sell_volume INTEGER, sell_value REAL,
          room INTEGER, total_room INTEGER, updated REAL NOT NULL,
          PRIMARY KEY (gate, symbol));
        CREATE TABLE IF NOT EXISTS put_foreign(
          symbol TEXT PRIMARY KEY,
          put_buy_volume INTEGER NOT NULL DEFAULT 0,
          put_buy_value REAL NOT NULL DEFAULT 0,
          put_sell_volume INTEGER NOT NULL DEFAULT 0,
          put_sell_value REAL NOT NULL DEFAULT 0,
          put_total_volume INTEGER NOT NULL DEFAULT 0,
          put_total_value REAL NOT NULL DEFAULT 0,
          put_deals INTEGER NOT NULL DEFAULT 0, src TEXT);
        CREATE TABLE IF NOT EXISTS dedup(
          gate TEXT NOT NULL, symbol TEXT NOT NULL,
          acc REAL NOT NULL, seq INTEGER NOT NULL,
          PRIMARY KEY (gate, symbol, acc));
        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
        """)
        self.db.commit()

    def _resume(self):
        """Reload prior state for THIS session date only (restart
        mid-session). Dedup sets are trimmed to the last 64 accs."""
        row = self.db.execute(
            "SELECT v FROM meta WHERE k='session_date'").fetchone()
        if not row or row[0] != self.session_date:
            self.db.execute(
                "INSERT OR REPLACE INTO meta(k, v) VALUES('session_date', ?)",
                (self.session_date,))
            self.db.commit()
            return
        for gate, sym, minute, o, h, l, c, v, fts, lts in self.db.execute(
                "SELECT gate, symbol, minute, open, high, low, close,"
                " volume, first_ts, last_ts FROM gate_buckets"):
            minute_ts = int(datetime.strptime(
                minute, "%Y-%m-%dT%H:%M").replace(
                    tzinfo=ICT).timestamp())
            self.buckets.setdefault(gate, {}).setdefault(sym, {})[minute_ts] \
                = [o, h, l, c, v, fts, lts]
        for r in self.db.execute(
                "SELECT gate, symbol, last, total_volume, total_value,"
                " buy_volume, buy_value, sell_volume, sell_value, room,"
                " total_room FROM snapshots"):
            snap = {"last": r[2], "total_volume": r[3],
                    "total_value": r[4], "buy_volume": r[5],
                    "buy_value": r[6], "sell_volume": r[7],
                    "sell_value": r[8], "room": r[9], "total_room": r[10]}
            self.snaps.setdefault(r[0], {})[r[1]] = {
                k: v for k, v in snap.items() if v is not None}
        for gate, sym, acc, seq in self.db.execute(
                "SELECT gate, symbol, acc, seq FROM dedup ORDER BY seq"):
            seen = self._seen.setdefault((gate, sym), OrderedDict())
            seen[acc] = None
            while len(seen) > DEDUP_KEEP:
                seen.popitem(last=False)
            self._seq = max(self._seq, seq)
        for r in self.db.execute(
                "SELECT symbol, put_buy_volume, put_buy_value,"
                " put_sell_volume, put_sell_value, put_total_volume,"
                " put_total_value, put_deals, src FROM put_foreign"):
            self.put[r[0]] = {
                "put_buy_volume": r[1], "put_buy_value": r[2],
                "put_sell_volume": r[3], "put_sell_value": r[4],
                "put_total_volume": r[5], "put_total_value": r[6],
                "put_deals": r[7], "src": r[8]}
        print(f"[core] resume: {sum(len(s) for g in self.buckets.values() for s in g.values())} buckets, "
              f"{sum(len(s) for s in self.snaps.values())} snapshots",
              flush=True)

    # ------------------------------------------------------------ events

    def apply_match(self, gate, sym, ts, price, vol, acc, recv_ts):
        if not (math.isfinite(price) and math.isfinite(vol)) \
                or price <= 0 or vol <= 0:
            return
        st = self.tick_stats.setdefault(
            gate, {"dup_dropped": 0, "acc_regressed": 0, "late": 0,
                   "late_deep": 0, "restated_minutes": 0})
        if acc is not None:
            key = (gate, sym)
            seen = self._seen.setdefault(key, OrderedDict())
            if acc in seen:
                st["dup_dropped"] += 1
                return
            seen[acc] = None
            if len(seen) > DEDUP_KEEP:
                seen.popitem(last=False)
            hi = self._max_acc.get(key)
            if hi is not None and acc < hi:
                st["acc_regressed"] += 1
            if hi is None or acc > hi:
                self._max_acc[key] = acc
            self._seq += 1
            self._new_accs.append((gate, sym, acc, self._seq))
        minute = int(ts // 60 * 60)
        mk = self._max_minute.get((gate, sym))
        if mk is not None and minute < mk:
            st["late"] += 1
        if mk is None or minute > mk:
            self._max_minute[(gate, sym)] = minute
        wm = self._wm.get((gate, sym))
        if wm is not None and ts < wm:
            if wm - ts > LATE_DEEP_SEC:
                st["late_deep"] += 1
            else:
                st["restated_minutes"] += 1
        if wm is None or ts > wm:
            self._wm[(gate, sym)] = ts
        per = self.buckets.setdefault(gate, {}).setdefault(sym, {})
        b = per.get(minute)
        if b is None:
            per[minute] = [price, price, price, price, vol, ts, ts]
        else:
            b[1] = max(b[1], price)
            b[2] = min(b[2], price)
            if ts >= b[6]:
                b[3] = price
                b[6] = ts
            if ts < b[5]:
                b[0] = price
                b[5] = ts
            b[4] += vol
        self.dirty_buckets.add((gate, sym, minute))
        self.dirty_merged.add((sym, minute))
        self.matches += 1
        self.matches_by_gate[gate] = self.matches_by_gate.get(gate, 0) + 1
        self.symbols_with_ticks.add(sym)

    def apply_snapshot(self, gate, sym, snap, recv_ts):
        cur = self.snaps.setdefault(gate, {}).setdefault(sym, {})
        room_cap = snap.get("total_room")
        if room_cap is None:
            room_cap = cur.get("total_room")
        if room_cap is not None:
            room_cap = clean_qty(gate, "total_room", room_cap, None,
                                 self.validity_stats)
        for k, v in snap.items():
            if v is None:
                continue
            if k in QTY_FIELDS:
                v = clean_qty(gate, k, v, room_cap, self.validity_stats)
                if v is None:
                    continue
            cur[k] = v
        cur["updated"] = recv_ts
        self.dirty_snaps.add((gate, sym))

    def apply_put(self, gate, sym, fields, ts):
        cur = self.put.setdefault(sym, {
            "put_buy_volume": 0, "put_buy_value": 0,
            "put_sell_volume": 0, "put_sell_value": 0,
            "put_total_volume": 0, "put_total_value": 0,
            "put_deals": 0, "src": gate})
        cur["put_buy_volume"] += fields.get("buyForeignQtty") or 0
        cur["put_buy_value"] += fields.get("buyForeignValue") or 0
        cur["put_sell_volume"] += fields.get("sellForeignQtty") or 0
        cur["put_sell_value"] += fields.get("sellForeignValue") or 0
        cur["put_total_volume"] += fields.get("vol") or 0
        cur["put_total_value"] += fields.get("val") or 0
        cur["put_deals"] += 1
        cur["src"] = gate
        self.dirty_put.add(sym)

    # ------------------------------------------------------- merged view

    def merged_bucket(self, sym, minute):
        for gate in GATE_PRIORITY:
            b = self.buckets.get(gate, {}).get(sym, {}).get(minute)
            if b is not None:
                return gate, b
        return None, None

    def merged_foreign(self):
        """Merged foreign flow per the best-gate rules: only
        normalized gates (DNSE, VNDirect, VPS) may contribute to the
        TOTAL. KBS/SSI snapshots are comparison legs only and are
        listed under `excluded`, never merged in. A missing field
        stays missing: no 0-fill, no fill from an excluded gate."""
        out = {}
        syms = set()
        for gate in self.snaps:
            syms.update(self.snaps[gate])
        for sym in sorted(syms):
            have = [(g, self.snaps[g][sym]) for g in NORMALIZED_GATES
                    if sym in self.snaps.get(g, {})]
            if not have:
                continue
            merged = dict(have[0][1])
            merged.pop("updated", None)
            field_src = {k: have[0][0] for k in merged}
            for gate, snap in have[1:]:
                for k, v in snap.items():
                    if k == "updated":
                        continue
                    if merged.get(k) is None and v is not None:
                        merged[k] = v
                        field_src[k] = gate
            excluded = {}
            if "kbs" in self.snaps and sym in self.snaps["kbs"]:
                excluded["kbs"] = ("matched-only except TCB/MWG; "
                                   "negotiated-add unproven")
            if "ssi-mqtt" in self.snaps and sym in self.snaps["ssi-mqtt"]:
                excluded["ssi-mqtt"] = "foreign definition unproven"
            out[sym] = {
                "symbol": sym,
                "src": have[0][0],
                "sources": [g for g, _ in have],
                "normalized": True,
                "field_src": field_src,
                "excluded": excluded,
                **{k: merged[k] for k in merged if k != "src"},
            }
        return out

    def crosscheck(self):
        """Per gate: latest snapshot total_volume vs the sum of that
        gate's own 1-minute buckets, per symbol."""
        out = {}
        for gate, syms in self.snaps.items():
            stat = {"compared": 0, "exact": 0, "within10": 0,
                    "max_abs_diff": 0, "worst": []}
            worst = []
            for sym, snap in syms.items():
                tv = snap.get("total_volume")
                if tv is None:
                    continue
                tick_sum = sum(
                    b[4] for b in self.buckets.get(
                        gate, {}).get(sym, {}).values())
                if not tick_sum:
                    continue
                stat["compared"] += 1
                d = abs(tv - tick_sum)
                if d == 0:
                    stat["exact"] += 1
                if d <= 10:
                    stat["within10"] += 1
                stat["max_abs_diff"] = max(stat["max_abs_diff"], d)
                worst.append({"sym": sym, "snapshot": tv,
                              "tick_sum": tick_sum, "diff": tv - tick_sum})
            worst.sort(key=lambda w: -abs(w["diff"]))
            stat["worst"] = worst[:5]
            out[gate] = stat
        return out

    # ------------------------------------------------------------- flush

    def _proc_times(self):
        try:
            with open("/proc/self/stat") as fh:
                parts = fh.read().split()
            ticks = int(parts[13]) + int(parts[14])
            rss_kb = 0
            with open("/proc/self/status") as fh:
                for line in fh:
                    if line.startswith("VmRSS:"):
                        rss_kb = int(line.split()[1])
                        break
            return ticks, rss_kb / 1024.0
        except (OSError, ValueError, IndexError):
            return None, None

    def flush(self, queue_depth=0):
        started = time.time()
        # raw lines
        for gate, lines in self.raw_lines.items():
            if not lines:
                continue
            path = os.path.join(self.outdir, f"raw_{gate}.jsonl")
            with open(path, "a") as fh:
                fh.write("\n".join(lines) + "\n")
            self.raw_lines[gate] = []
        # buckets
        if self.dirty_buckets:
            rows = []
            for gate, sym, minute in self.dirty_buckets:
                b = self.buckets[gate][sym][minute]
                rows.append((gate, sym, minute_label(minute), b[0], b[1],
                             b[2], b[3], int(b[4]), b[5], b[6]))
            self.db.executemany(
                "INSERT OR REPLACE INTO gate_buckets VALUES"
                " (?,?,?,?,?,?,?,?,?,?)", rows)
            self.dirty_buckets = set()
        # merged candles (D1-loadable shape)
        if self.dirty_merged:
            rows = []
            for sym, minute in self.dirty_merged:
                gate, b = self.merged_bucket(sym, minute)
                if b is None:
                    continue
                rows.append((sym, minute_label(minute), b[0], b[1], b[2],
                             b[3], int(b[4]), gate, self.session_date))
            self.db.executemany(
                "INSERT OR REPLACE INTO candles VALUES"
                " (?,?,?,?,?,?,?,?,?)", rows)
            self.dirty_merged = set()
        # snapshots
        if self.dirty_snaps:
            rows = []
            for gate, sym in self.dirty_snaps:
                s = self.snaps[gate][sym]
                rows.append((gate, sym, s.get("last"),
                             s.get("total_volume"), s.get("total_value"),
                             s.get("buy_volume"), s.get("buy_value"),
                             s.get("sell_volume"), s.get("sell_value"),
                             s.get("room"), s.get("total_room"),
                             s.get("updated", 0)))
            self.db.executemany(
                "INSERT OR REPLACE INTO snapshots VALUES"
                " (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            self.dirty_snaps = set()
        # negotiated accumulation
        if self.dirty_put:
            rows = []
            for sym in self.dirty_put:
                p = self.put[sym]
                rows.append((sym, p["put_buy_volume"], p["put_buy_value"],
                             p["put_sell_volume"], p["put_sell_value"],
                             p["put_total_volume"], p["put_total_value"],
                             p["put_deals"], p["src"]))
            self.db.executemany(
                "INSERT OR REPLACE INTO put_foreign VALUES"
                " (?,?,?,?,?,?,?,?,?)", rows)
            self.dirty_put = set()
        # dedup accs seen since last flush
        if self._new_accs:
            self.db.executemany(
                "INSERT OR IGNORE INTO dedup VALUES (?,?,?,?)",
                self._new_accs)
            self._new_accs = []
        self.db.commit()
        # merged foreign view
        with open(os.path.join(self.outdir, "foreign_merged.json"),
                  "w") as fh:
            json.dump(self.merged_foreign(), fh, ensure_ascii=False)
        flush_ms = round((time.time() - started) * 1000, 1)
        self.flush_count += 1
        # checkpoint
        checkpoint = {
            "session_date": self.session_date,
            "last_flush_ict": now_ict().strftime("%H:%M:%S"),
            "flush_count": self.flush_count,
            "matches": self.matches,
            "symbols_with_ticks": len(self.symbols_with_ticks),
            "gates": {g: {"msgs": s.msgs, "connected": s.connected,
                          "last_error": s.last_error}
                      for g, s in self.gate_stats.items()},
        }
        with open(os.path.join(self.outdir, "checkpoint.json"),
                  "w") as fh:
            json.dump(checkpoint, fh, ensure_ascii=False, indent=1)
        # load measurement
        ticks, rss_mb = self._proc_times()
        wall = time.time()
        cpu_pct = None
        if ticks is not None and self._last_cpu is not None:
            dt = wall - self._last_cpu_wall
            if dt > 0:
                cpu_pct = round(
                    (ticks - self._last_cpu) / os.sysconf("SC_CLK_TCK")
                    / dt * 100, 1)
        self._last_cpu, self._last_cpu_wall = ticks, wall
        rates = {}
        for gate, st in self.gate_stats.items():
            prev = self._last_gate_msgs.get(gate, 0)
            dt = wall - (self._last_load_wall or wall)
            rates[gate] = round((st.msgs - prev) / dt, 2) if dt > 0 else 0
            self._last_gate_msgs[gate] = st.msgs
        self._last_load_wall = wall
        load = {"ts": now_ict().strftime("%H:%M:%S"),
                "cpu_pct": cpu_pct, "rss_mb": rss_mb,
                "msgs_per_sec": rates, "flush_ms": flush_ms,
                "symbols_with_ticks": len(self.symbols_with_ticks),
                "queue_depth": queue_depth}
        with open(os.path.join(self.outdir, "load.jsonl"), "a") as fh:
            fh.write(json.dumps(load) + "\n")
        print(f"[health] {load['ts']} "
              f"msgs={ {g: s.msgs for g, s in self.gate_stats.items()} } "
              f"conn={ {g: s.connected for g, s in self.gate_stats.items()} } "
              f"q={queue_depth} flush_ms={flush_ms} "
              f"syms={len(self.symbols_with_ticks)}",
              flush=True)
        return flush_ms

    # --------------------------------------------------------------- run

    async def run(self, queue, stop):
        next_flush = time.time() + FLUSH_SEC
        while not stop.is_set():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                event = None
            if event is not None:
                recv_ts = time.time()
                kind = event[0]
                if kind == "match":
                    _, gate, sym, ts, price, vol, acc = event
                    self.raw_lines.setdefault(gate, []).append(json.dumps(
                        {"kind": "match", "sym": sym, "ts": ts,
                         "recv": round(recv_ts, 3), "p": price, "v": vol,
                         "acc": acc}, ensure_ascii=False))
                    self.apply_match(gate, sym, ts, price, vol, acc,
                                     recv_ts)
                elif kind == "snap":
                    _, gate, sym, snap, _ = event
                    self.raw_lines.setdefault(gate, []).append(json.dumps(
                        {"kind": "snap", "sym": sym,
                         "recv": round(recv_ts, 3), **snap},
                        ensure_ascii=False, default=str))
                    self.apply_snapshot(gate, sym, snap, recv_ts)
                elif kind == "put":
                    _, gate, sym, fields, ts = event
                    self.raw_lines.setdefault(gate, []).append(json.dumps(
                        {"kind": "put", "sym": sym, "ts": ts,
                         "recv": round(recv_ts, 3),
                         **{k: v for k, v in fields.items()}},
                        ensure_ascii=False, default=str))
                    self.apply_put(gate, sym, fields, ts)
                queue.task_done()
            if time.time() >= next_flush:
                self.flush(queue_depth=queue.qsize())
                next_flush = time.time() + FLUSH_SEC
        self.flush(queue_depth=queue.qsize())

    def write_summary(self, window, ssi_source, ssi_proxy_set,
                      extra_notes):
        gaps = {}
        for gate, st in self.gate_stats.items():
            gaps[gate] = st.gaps
        summary = {
            "session_date": self.session_date,
            "window_ict": [window[0].strftime("%H:%M"),
                           window[1].strftime("%H:%M")],
            "ssi_config_source": ssi_source,
            "ssi_proxy_set": ssi_proxy_set,
            "gates": {g: {"msgs": s.msgs, "matches": s.matches,
                          "snapshots": s.snapshots, "puts": s.puts,
                          "gaps": s.gaps, "last_error": s.last_error}
                      for g, s in self.gate_stats.items()},
            "matches_total": self.matches,
            "matches_by_gate": self.matches_by_gate,
            "symbols_with_ticks": len(self.symbols_with_ticks),
            "tick_stats": self.tick_stats,
            "validity_stats": self.validity_stats,
            "crosscheck": self.crosscheck(),
            "merged_foreign_symbols": len(self.merged_foreign()),
            "notes": extra_notes,
        }
        with open(os.path.join(self.outdir, "summary.json"),
                  "w") as fh:
            json.dump(summary, fh, ensure_ascii=False, indent=1)
        return summary

# -------------------------------------------------------- session runner

def load_universe(path):
    """Load the frozen universe file. Returns [{symbol, exchange, ...}].
    Never fabricates: an empty or malformed file is a hard error."""
    with open(path) as fh:
        rows = json.load(fh)
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"universe file {path} is empty or not a list")
    seen = set()
    out = []
    for row in rows:
        sym = row.get("symbol")
        if not sym or sym in seen:
            continue
        seen.add(sym)
        out.append(row)
    if not out:
        raise ValueError(f"no symbols in universe file {path}")
    return out


async def run_session(universe, outdir, endpoints=None, ssi_proxy="env",
                      minutes=None, stop_event=None,
                      ssi_config_resolver=None, vnd_key_resolver=None):
    """Run one trial session. endpoints: {gate: ws_url} overrides for
    stub testing. minutes: run that many minutes from now instead of
    the session window (pre-open connectivity check). Returns the
    summary dict."""
    endpoints = endpoints or {}
    now = now_ict()
    if minutes:
        start = now
        end = now + timedelta(minutes=minutes)
        sess_date = session_date(now)
        print(f"[run] check mode: {minutes} min from "
              f"{now.strftime('%H:%M:%S')}", flush=True)
    else:
        start, end = current_or_next_window(now)
        sess_date = session_date(start)
        if now < start:
            print(f"[run] waiting until window start "
                  f"{start.strftime('%H:%M:%S')} ICT", flush=True)
            while now_ict() < start:
                await asyncio.sleep(5)
                if stop_event is not None and stop_event.is_set():
                    return {"status": "stopped-before-start"}
    outdir = os.path.join(outdir, sess_date)
    queue = asyncio.Queue(maxsize=QUEUE_MAX)
    stop = stop_event or asyncio.Event()
    validity_stats = {}

    # SSI config is resolved once, up front; only the SOURCE is logged.
    ssi_source = None
    if ssi_config_resolver is not None:
        ssi_source, _, _, _ = ssi_config_resolver()
    else:
        ssi_source, _, _, _ = resolve_ssi_config()
    proxy = None
    if ssi_proxy == "env":
        proxy = os.environ.get("SSI_PROXY_URL") or None
    elif ssi_proxy:
        proxy = ssi_proxy

    gates = {}
    for name in GATES:
        cls = GATE_CLASSES[name]
        kw = {"universe": universe, "queue": queue, "stop": stop,
              "validity_stats": validity_stats}
        if name in endpoints:
            kw["url"] = endpoints[name]
        if name == "ssi-mqtt":
            kw["proxy"] = proxy
            if ssi_config_resolver is not None:
                kw["config_resolver"] = ssi_config_resolver
        if name == "vndirect" and vnd_key_resolver is not None:
            kw["key_resolver"] = vnd_key_resolver
        gates[name] = cls(**kw)
    gate_stats = {name: g.stats for name, g in gates.items()}

    core = Core(outdir, sess_date, gate_stats)
    print(f"[run] session {sess_date} out={outdir} "
          f"universe={len(universe)} proxy={'set' if proxy else 'unset'}",
          flush=True)

    async def _watch_end():
        while now_ict() < end and not stop.is_set():
            await asyncio.sleep(5)
        stop.set()

    tasks = [asyncio.create_task(g.run()) for g in gates.values()]
    tasks.append(asyncio.create_task(core.run(queue, stop)))
    tasks.append(asyncio.create_task(_watch_end()))
    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        stop.set()
        await asyncio.gather(*tasks, return_exceptions=True)
    # drain anything left in the queue (bounded wait)
    drain_deadline = time.time() + 10
    while not queue.empty() and time.time() < drain_deadline:
        await asyncio.sleep(0.2)
    notes = []
    if any(r.get("exchange") == "UPCOM" for r in universe):
        notes.append(
            "VNDirect UPCOM floor code undetermined from code read; "
            "UPCOM symbols not subscribed on VNDirect (covered by the "
            "other four gates).")
    summary = core.write_summary(
        (start, end), ssi_source, bool(proxy), notes)
    core.db.close()
    print(f"[run] done: matches={core.matches} "
          f"syms={len(core.symbols_with_ticks)} out={outdir}", flush=True)
    return summary


def main(argv=None):
    import argparse
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(
        description="Full-universe tick collector trial (local disk).")
    ap.add_argument("--out-dir", default="session-out")
    ap.add_argument("--universe", default=os.path.join(
        here, "universe_full.json"))
    ap.add_argument("--minutes", type=float, default=0,
                    help="check mode: run N minutes from now instead "
                    "of the session window")
    ap.add_argument("--endpoints-json", default="",
                    help="test hook: JSON file mapping gate -> ws URL")
    args = ap.parse_args(argv)

    universe = load_universe(args.universe)
    manifest_path = os.path.join(here, "universe_manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path) as fh:
            manifest = json.load(fh)
        blob = open(args.universe, "rb").read()
        import hashlib
        if hashlib.sha256(blob).hexdigest() != manifest.get("sha256"):
            print("[warn] universe file differs from build manifest",
                  flush=True)
    endpoints = {}
    if args.endpoints_json:
        with open(args.endpoints_json) as fh:
            endpoints = json.load(fh)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    stop = asyncio.Event()

    def _on_signal():
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _on_signal)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        loop.run_until_complete(run_session(
            universe, args.out_dir, endpoints=endpoints,
            minutes=args.minutes or None, stop_event=stop))
    finally:
        loop.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
