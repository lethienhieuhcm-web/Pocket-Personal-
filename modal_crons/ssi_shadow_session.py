#!/usr/bin/env python3
# Chan SSI BONG — app Modal RIENG, khong phai collector.
# Ngay phien (SRC + ten app Modal) SUY TU GIO ICT LUC CHAY, khong
# ghi cung — sua goc loi 28/10 (moi phien phai tao entry tay, suyt
# tac dispatch). Logic thu thap khong doi.
# - Doc SSI qua proxy tu Modal secret SSI_PROXY_URL (da luu moi 09:25).
# - Chi publish vao prefix bong moi src ssi-shadow-<YYYYMMDD>:
#   raw_chunks + src_artifacts (snapshot/health), KHONG gui
#   status/intraday/foreign -> khong dung bat ky key nao cua collector
#   dang chay (status.json, intraday, foreign, src dnse/kbs/vndirect/vps).
# - KHONG live, KHONG restart collector, dung 15:05 ICT.
# - Code van chuyen (MqttWs, schema SSI, ssi_config, publish) trich
#   nguyen van tu modal_crons/tick_collector.py.
import asyncio
import base64
import gzip
import json
import os
import random
import struct
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import modal

ICT = timezone(timedelta(hours=7))
PUBLISH_URL = "https://lethanhdong.one/api/internal/stock-publish"


def session_date(dt=None):
    """Ngay phien (YYYYMMDD, gio ICT). Mac dinh: gio hien tai luc
    chay. Tham so dt (datetime co tz) CHI cho test identity ngay
    phien tuong lai — duong chay that khong truyen dt."""
    return (dt or datetime.now(ICT)).strftime("%Y%m%d")


# Identity phien dong nhat cho ca luot chay: suy 1 lan luc import.
SESSION_DATE = session_date()
SRC = f"ssi-shadow-{SESSION_DATE}"
UNIVERSE = [
    "VCB", "BID", "CTG", "TCB", "MBB", "VPB", "HPG", "VHM",
    "VIC", "VNM", "MSN", "FPT", "MWG", "SSI", "VND", "HCM",
    "STB", "ACB", "SHB", "POW", "GAS", "PLX", "BVH", "VRE",
    "VJC", "PNJ", "SAB", "GVR", "BCM", "HDB", "TPB", "LPB",
    "VIB", "EIB", "NLG", "KDH", "DGC", "FRT", "DGW", "GEX",
]

def now_ict() -> datetime:
    return datetime.now(ICT)

def _f(v):
    """Chuoi/so -> float; rong/None -> None."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------------- protobuf toi thieu (tu probe) ----------------

def _varint(buf, pos):
    shift = 0
    val = 0
    while True:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7

def pb_decode(buf, fields):
    """fields: {no: (name, kind)} kind s/i/u/z/Z/f(float32)/d(double)/
    n (nested, spec[2]=fields con)."""
    out = {}
    pos = 0
    while pos < len(buf):
        tag, pos = _varint(buf, pos)
        no, wt = tag >> 3, tag & 7
        spec = fields.get(no)
        if wt == 0:
            v, pos = _varint(buf, pos)
            if spec is None:
                out[f"f{no}"] = v
                continue
            name, kind = spec[0], spec[1]
            if kind in ("z", "Z"):
                v = (v >> 1) ^ -(v & 1)
            out[name] = v
        elif wt == 2:
            ln, pos = _varint(buf, pos)
            raw = buf[pos:pos + ln]
            pos += ln
            if spec is None:
                # co the la message long: giu dang dict f-no
                try:
                    out[f"f{no}"] = pb_decode(raw, {})
                except Exception:
                    out[f"f{no}"] = f"<{ln}b>"
                continue
            name, kind = spec[0], spec[1]
            if kind == "s":
                out[name] = raw.decode("utf-8", "replace")
            elif kind == "n":
                out.setdefault(name, []).append(
                    pb_decode(raw, spec[2]))
            else:
                out[name] = raw
        elif wt == 5:
            v = struct.unpack("<f", buf[pos:pos + 4])[0]
            pos += 4
            out[spec[0] if spec else f"f{no}"] = v
        elif wt == 1:
            v = struct.unpack("<d", buf[pos:pos + 8])[0]
            pos += 8
            out[spec[0] if spec else f"f{no}"] = v
        else:
            break
    return out


# ---------------- MQTT 3.1.1 over WebSocket (tu probe) ----------------

def _in_trading_window(dt) -> bool:
    """Khung giao dich T2-T6: 09:00-11:30 + 13:00-15:00 ICT.
    Dung cho watchdog im lang (Dat 4): ngoai khung nay feed SSI
    im lang la binh thuong, khong duoc tinh la ket noi chet."""
    if dt.weekday() >= 5:
        return False
    m = dt.hour * 60 + dt.minute
    return (540 <= m < 690) or (780 <= m < 900)

def _enc_str(s):
    b = s.encode()
    return struct.pack(">H", len(b)) + b

def _enc_rem(n):
    out = b""
    while True:
        b = n % 128
        n //= 128
        if n:
            out += bytes([b | 0x80])
        else:
            out += bytes([b])
            return out

def _mqtt_connect(cid, user, pw, keepalive=60):
    vh = _enc_str("MQTT") + bytes([4, 0xC2]) + struct.pack(
        ">H", keepalive)
    body = vh + _enc_str(cid) + _enc_str(user) + _enc_str(pw)
    return b"\x10" + _enc_rem(len(body)) + body

def _mqtt_subscribe(pkt_id, topics):
    body = struct.pack(">H", pkt_id)
    for t in topics:
        body += _enc_str(t) + b"\x00"
    return b"\x82" + _enc_rem(len(body)) + body

def _mqtt_parse_publish(msg):
    pos = 1
    mult = 1
    rem = 0
    while True:
        b = msg[pos]
        pos += 1
        rem += (b & 0x7F) * mult
        if not (b & 0x80):
            break
        mult *= 128
    tlen = struct.unpack(">H", msg[pos:pos + 2])[0]
    pos += 2
    topic = msg[pos:pos + tlen].decode()
    pos += tlen
    if msg[0] & 0x06:  # QoS > 0: bo qua packet id
        pos += 2
    return topic, msg[pos:]

class MqttWs:
    """MQTT tren WS: tu reconnect + subscribe lai + PINGREQ 25s.

    Tham so Dat 4 (chi SSI dung, cac cong khac giu mac dinh cu):
    - proxy: URL proxy HTTP CONNECT (websockets>=14 tu lam tunnel +
      TLS); None = noi truc tiep nhu truoc.
    - backoff_seq: day giay ngu giua cac lan reconnect, phan tu cuoi
      lap lai; None = luat cu (2s nhan doi, tran 30s).
    - silent_watchdog_sec: >0 thi trong GIO GIAO DICH, qua N giay
      khong nhan tin la coi ket noi chet lang -> dong, noi lai theo
      backoff (su co conn im lang 13:11 22/10)."""

    def __init__(self, url, user, pw, topics, on_msg, subprotocol="mqtt",
                 origin=None, proxy=None, backoff_seq=None,
                 silent_watchdog_sec=0):
        self.url, self.user, self.pw = url, user, pw
        self.topics, self.on_msg = topics, on_msg
        self.subprotocol = subprotocol
        self.origin = origin
        self.proxy = proxy
        self.backoff_seq = backoff_seq
        self.silent_watchdog_sec = silent_watchdog_sec
        self.last_msg = 0.0
        self.msgs = 0
        self.connected = False
        self.last_error = ""
        self._stop = False

    def _backoff_for(self, idx):
        if self.backoff_seq:
            return self.backoff_seq[min(idx, len(self.backoff_seq) - 1)]
        return min(2 * (2 ** idx), 30)

    async def run(self):
        from websockets.asyncio.client import connect
        backoff_idx = 0
        headers = {"User-Agent": "Mozilla/5.0"}
        if self.origin:
            headers["Origin"] = self.origin
        while not self._stop:
            try:
                cid = "tick-" + "".join(
                    random.choices("abcdef0123456789", k=8))
                kw = {}
                if self.proxy:
                    kw["proxy"] = self.proxy
                async with connect(
                        self.url, subprotocols=[self.subprotocol],
                        open_timeout=20, ping_interval=None,
                        additional_headers=headers,
                        max_size=8 * 1024 * 1024, **kw) as ws:
                    await ws.send(_mqtt_connect(cid, self.user, self.pw))
                    msg = await asyncio.wait_for(ws.recv(), 20)
                    if not (isinstance(msg, bytes) and msg[0] >> 4 == 2
                            and msg[3] == 0):
                        raise ConnectionError(f"CONNACK rc={msg!r:.40}")
                    await ws.send(_mqtt_subscribe(1, self.topics))
                    self.connected = True
                    backoff_idx = 0
                    if self.silent_watchdog_sec:
                        # An han watchdog tu luc noi xong (ke ca khi
                        # chua co tin dau tien).
                        self.last_msg = time.time()
                    last_ping = time.time()
                    while not self._stop:
                        if self.silent_watchdog_sec and self.last_msg \
                                and time.time() - self.last_msg \
                                > self.silent_watchdog_sec \
                                and _in_trading_window(now_ict()):
                            raise ConnectionError(
                                "silent watchdog: "
                                f"{round(time.time() - self.last_msg)}s "
                                "khong tin trong gio giao dich")
                        if time.time() - last_ping > 25:
                            await ws.send(b"\xc0\x00")
                            last_ping = time.time()
                        try:
                            msg = await asyncio.wait_for(ws.recv(), 10)
                        except asyncio.TimeoutError:
                            await ws.send(b"\xc0\x00")
                            last_ping = time.time()
                            continue
                        if not isinstance(msg, bytes) or not msg:
                            continue
                        if msg[0] >> 4 == 3:
                            topic, payload = _mqtt_parse_publish(msg)
                            self.last_msg = time.time()
                            self.msgs += 1
                            self.on_msg(topic, payload)
            except Exception as e:  # noqa: BLE001
                self.connected = False
                self.last_error = f"{type(e).__name__}: {str(e)[:120]}"
                print(f"[mqtt {self.url.split('/')[2]}] loi: "
                      f"{self.last_error}", flush=True)
                if self._stop:
                    break
                await asyncio.sleep(self._backoff_for(backoff_idx))
                backoff_idx += 1

    def stop(self):
        self._stop = True


# ---------------- Socket.IO (Engine.IO v4) dung chung KBS/VPS/VCI ---

SSI_STOCK = {17: ("matchedPrice", "i"), 18: ("matchedVolume", "i"),
             19: ("matchedTime", "i"), 22: ("openPrice", "i"),
             23: ("highest", "i"), 24: ("lowest", "i"),
             25: ("avgPrice", "i"), 26: ("nmTotalTradedQty", "i"),
             27: ("nmTotalTradedValue", "i"),
             70: ("buyForeignQtty", "i"), 71: ("buyForeignValue", "i"),
             72: ("sellForeignQtty", "i"),
             73: ("sellForeignValue", "i"),
             83: ("remainForeignQtty", "Z"),
             89: ("stockSymbol", "s")}

SSI_LE = {1: ("items", "n", {1: ("price", "u"), 2: ("vol", "u"),
                             3: ("accumulatedVol", "i"),
                             4: ("time", "s"), 6: ("side", "s"),
                             10: ("sendingTime", "i")})}

SSI_PE = {1: ("items", "n", {3: ("stockSymbol", "s"), 4: ("vol", "i"),
                             5: ("val", "i"), 6: ("price", "i"),
                             9: ("time", "s"),
                             14: ("buyForeignQtty", "i"),
                             15: ("buyForeignValue", "i"),
                             16: ("sellForeignQtty", "i"),
                             17: ("sellForeignValue", "i"),
                             18: ("remainForeignQtty", "Z")})}

_SSI_CFG = None

# Ban chup cau hinh cong khai cua SSI tai thoi diem build
# (hang so nhung trong JS cong khai cua FiinTrade; chi dung
# khi khong trich truc tiep duoc tu bundle khi chay).

_SSI_SNAPSHOT = ('wss://price-streaming.ssi.com.vn/mqtt', 'mqtt-ssi', 'mqtt-ssi')

def ssi_config():
    """Thong tin MQTT SSI: env neu co, khong thi trich tu bundle
    cong khai cua FiinTrade (MQTT_USERNAME/PASSWORD/ENDPOINT la
    hang so nhung trong JS cong khai cua SSI — probe 21/10 da
    dung chinh duong nay). Cache trong process."""
    global _SSI_CFG
    if _SSI_CFG:
        return _SSI_CFG
    user = os.environ.get("SSI_USER")
    pw = os.environ.get("SSI_PW")
    ep = "wss://price-streaming.ssi.com.vn/mqtt"
    if not (user and pw):
        import re
        import urllib.request as ur
        hdr = {"User-Agent": "Mozilla/5.0"}
        base = "https://fiintrade.ssi.com.vn/"
        try:
            html = ur.urlopen(ur.Request(base, headers=hdr),
                              timeout=30).read().decode(
                                  "utf-8", "replace")
            assets = re.findall(r'(?:src|href)="([^"]+\.js)"', html)
        except Exception:  # noqa: BLE001
            assets = []
        for a in assets:
            url = a if a.startswith("http") else base + a.lstrip("/")
            try:
                js = ur.urlopen(ur.Request(url, headers=hdr),
                                timeout=30).read().decode(
                                    "utf-8", "replace")
            except Exception:  # noqa: BLE001
                continue
            m1 = re.search(r'MQTT_USERNAME="([^"]*)"', js)
            m2 = re.search(r'MQTT_PASSWORD="([^"]*)"', js)
            if m1 and m2:
                user, pw = m1.group(1), m2.group(1)
                m3 = re.search(r'MQTT_ENDPOINT="([^"]*)"', js)
                if m3:
                    ep = m3.group(1)
                break
    if not (user and pw):
        ep, user, pw = _SSI_SNAPSHOT
    _SSI_CFG = (ep, user, pw)
    return _SSI_CFG

def publish(payload, source):
    secret = os.environ['STOCK_PUBLISH' '_SECRET']
    payload["_prov"] = {
        "source": f"tick:{source}",
        "fetched_at": datetime.now(timezone.utc).isoformat()}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(PUBLISH_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Publish-Secret", secret)
    req.add_header("X-Internal-Secret", secret)
    req.add_header("User-Agent", "Mozilla/5.0")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())

# ---------------- Chan SSI bong (lean, khong dung Aggregator) ----------------
class SsiShadow:
    def __init__(self, universe):
        self.raw = []
        self.snap = {}
        topics = []
        for s in universe:
            topics += [f"s/{s}/MAIN", f"l/{s}/MAIN"]
        topics += ["pe", "i/VNINDEX", "i/VN30"]
        ep, user, pw = ssi_config()
        self.client = MqttWs(
            ep, user, pw, topics, self._on_msg,
            origin="https://fiintrade.ssi.com.vn",
            proxy=os.environ.get("SSI_PROXY_URL") or None,
            backoff_seq=(5, 30, 120), silent_watchdog_sec=90)

    def _on_msg(self, topic, payload):
        try:
            recv = time.time()
            hour = datetime.fromtimestamp(recv, ICT).strftime("%H")
            if topic.startswith("s/"):
                d = pb_decode(payload, SSI_STOCK)
                sym = d.get("stockSymbol") or topic.split("/")[1]
                if d.get("matchedPrice"):
                    # FIX retain 27/10 (bugfix ngoai SSI): truong ngoai SSI la
                    # optional, chi ~5% tin s/MAIN mang theo — ghi de toan bo
                    # snapshot se xoa so ngoai cu khi tin sau khong mang
                    # truong ngoai (nguyen nhan snapshot 26/10 null 40/40).
                    # Chi cap nhat truong khac None, giu so ngoai cuoi cung.
                    cur = self.snap.get(sym, {})
                    for _k, _v in {
                        "last": d["matchedPrice"] / 1000,
                        "total_volume": d.get("nmTotalTradedQty"),
                        "total_value": d.get("nmTotalTradedValue"),
                        "buy_volume": d.get("buyForeignQtty"),
                        "sell_volume": d.get("sellForeignQtty"),
                        "room": d.get("remainForeignQtty"),
                    }.items():
                        if _v is not None:
                            cur[_k] = _v
                    self.snap[sym] = cur
                self.raw.append((hour, json.dumps(
                    {"t": recv, "topic": topic, "sym": sym, "kind": "s",
                     "last": d.get("matchedPrice"),
                     "vol": d.get("nmTotalTradedQty")},
                    separators=(",", ":"))))
            elif topic.startswith("l/"):
                sym = topic.split("/")[1]
                d = pb_decode(payload, SSI_LE)
                for it in d.get("items", []):
                    if it.get("price") and it.get("vol"):
                        self.raw.append((hour, json.dumps(
                            {"t": recv, "topic": topic, "sym": sym,
                             "kind": "l", "price": it["price"] / 1000,
                             "vol": it["vol"]},
                            separators=(",", ":"))))
            elif topic == "pe":
                d = pb_decode(payload, SSI_PE)
                for it in d.get("items", []):
                    if it.get("stockSymbol"):
                        self.raw.append((hour, json.dumps(
                            {"t": recv, "topic": topic,
                             "sym": it["stockSymbol"], "kind": "pe",
                             "vol": it.get("vol")},
                            separators=(",", ":"))))
            elif topic.startswith("i/"):
                self.raw.append((hour, json.dumps(
                    {"t": recv, "topic": topic, "kind": "i"},
                    separators=(",", ":"))))
        except Exception as e:  # noqa: BLE001
            print(f"[ssi-shadow] decode loi {topic}: {str(e)[:100]}",
                  flush=True)


def build_payload(shadow, buf):
    grouped = {}
    for hour, line in buf:
        grouped.setdefault(hour, []).append(line)
    raw_payload = {}
    for hour, lines in grouped.items():
        raw_payload[hour] = base64.b64encode(
            gzip.compress(chr(10).join(lines).encode())).decode()
    payload = {"tick_shadow": {"src_artifacts": {SRC: {
        "snapshot": {"by_symbol": shadow.snap},
        "health": {
            "connected": bool(shadow.client.connected),
            "msgs": shadow.client.msgs,
            "last_msg_ago_sec": (
                round(time.time() - shadow.client.last_msg)
                if shadow.client.last_msg else None),
            "last_error": shadow.client.last_error or None,
        }}}}}
    if raw_payload:
        payload["tick_shadow"]["raw_chunks"] = {SRC: raw_payload}
    return payload


async def session_loop():
    shadow = SsiShadow(UNIVERSE)
    task = asyncio.create_task(shadow.client.run())
    print(f"[ssi-shadow] bat dau {datetime.now(ICT).isoformat()} "
          f"src={SRC} ma={len(UNIVERSE)} "
          f"proxy_present={bool(os.environ.get('SSI_PROXY_URL'))}",
          flush=True)
    try:
        while True:
            await asyncio.sleep(60)
            dt = datetime.now(ICT)
            if dt.hour * 60 + dt.minute >= 15 * 60 + 5 or dt.weekday() >= 5:
                break
            buf, shadow.raw = shadow.raw, []
            if len(buf) > 50000:
                print(f"[ssi-shadow] raw tran, bo {len(buf) - 50000} dong cu",
                      flush=True)
                buf = buf[-50000:]
            payload = build_payload(shadow, buf)
            try:
                await asyncio.to_thread(publish, payload, SRC)
                print(f"[ssi-shadow] publish ok msgs={shadow.client.msgs} "
                      f"raw_lines={len(buf)} "
                      f"connected={shadow.client.connected}", flush=True)
            except Exception as e:  # noqa: BLE001
                shadow.raw = buf + shadow.raw
                print(f"[ssi-shadow] publish loi: {type(e).__name__} "
                      f"{str(e)[:120]}", flush=True)
    finally:
        shadow.client.stop()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        print("[ssi-shadow] ket thuc phien", flush=True)


app = modal.App(f"ssi-shadow-session-{SESSION_DATE}")
image = (modal.Image.debian_slim(python_version="3.12")
         .pip_install("websockets>=14"))


@app.function(image=image,
              secrets=[modal.Secret.from_name("pocket-personal")],
              timeout=60 * 60 * 6)
def run_session():
    import asyncio
    asyncio.run(session_loop())


@app.local_entrypoint()
def main():
    run_session.remote()
