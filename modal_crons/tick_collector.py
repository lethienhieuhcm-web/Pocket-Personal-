#!/usr/bin/env python3
"""Bo thu tick chinh thuc (Chot Henrry 21/10/2026) — chay tren Modal.

Chuoi nguon (router): SSI-MQTT chinh -> DNSE du phong 1 -> VCI du
phong 2. Nguong chuyen nguon khai bao trong CONFIG (STALE_SEC trong
phien, LUNCH_STALE_SEC gio nghi trua). Moi du lieu gan nhan nguon
(_prov khi publish + truong src trong tung file shadow).

Dau ra (chay BONG — chi ghi prefix market/shadow_tick/ qua branch
publish tick_shadow; KHONG dung du lieu production):
- nến 1m tu tick khop lenh + gom 5m/15m/1H, dinh dang rows
  {t,o,h,l,c,v} giong het intraday hien tai (gia nghin dong).
- khoi ngoai theo ma (snapshot tich luy phien tu luong) + thoa
  thuan co khoi ngoai tung deal (SSI PutExecData).
- status: nguon dang chay, su kien chuyen nguon, khoang mat du
  lieu (gaps), so dem van hanh — so lieu do that cho bao cao.

Pham vi du lieu dung bang chung REPORT-LIVE-2110: chi khoi ngoai +
lenh khop + thoa thuan. Khong co phan loai ca nhan/to chuc/tu
doanh o bat ky luong cong khai nao.

Van hanh: Modal Cron 08:55 ICT T2-T6 (01:55 UTC), function chay
toi 15:05 ICT. Broker MQTT dong ket noi neu client im lang 2-3
phut -> PINGREQ moi 25s bat buoc (bai hoc probe).
"""
import modal

app = modal.App("stock-tick-collector")

image = (modal.Image.debian_slim(python_version="3.12")
         .pip_install("websockets>=12"))


@app.function(image=image,
              secrets=[modal.Secret.from_name("pocket-personal")],
              schedule=modal.Cron("55 1 * * 1-5", timezone="UTC"),
              timeout=60 * 60 * 7, max_containers=1)
def tick_session(max_minutes: int = 0):
    import asyncio
    asyncio.run(_collect(max_minutes))


@app.local_entrypoint()
def main(max_minutes: int = 0):
    tick_session.spawn(max_minutes)


# =====================================================================
# Collector (chay ben trong Modal function)
# =====================================================================
import asyncio, json, os, random, struct, time, urllib.request
from datetime import datetime, timedelta, timezone

ICT = timezone(timedelta(hours=7))
PUBLISH_URL = "https://lethanhdong.one/api/internal/stock-publish"

CONFIG = {
    # Nguong mat tick -> chuyen nguon (giay, trong gio khop lenh)
    "stale_sec": 45,
    # Gio nghi trua: luong van co lenh dat -> nguong long hon
    "lunch_stale_sec": 900,
    # Chu ky publish shadow (giay)
    "publish_sec": 30,
    # Chu ky do nguon chinh de quay ve (giay)
    "failback_probe_sec": 90,
    "universe": [
        "VCB", "BID", "CTG", "TCB", "MBB", "VPB", "HPG", "VHM",
        "VIC", "VNM", "MSN", "FPT", "MWG", "SSI", "VND", "HCM",
        "STB", "ACB", "SHB", "POW", "GAS", "PLX", "BVH", "VRE",
        "VJC", "PNJ", "SAB", "GVR", "BCM", "HDB", "TPB", "LPB",
        "VIB", "EIB", "NLG", "KDH", "DGC", "FRT", "DGW", "GEX",
    ],
}


def now_ict() -> datetime:
    return datetime.now(ICT)


def in_trading_window(dt: datetime) -> bool:
    if dt.weekday() >= 5:
        return False
    hm = dt.hour * 60 + dt.minute
    return (9 * 60 <= hm < 11 * 60 + 30) or (13 * 60 <= hm < 15 * 60)


def in_lunch(dt: datetime) -> bool:
    hm = dt.hour * 60 + dt.minute
    return 11 * 60 + 30 <= hm < 13 * 60


def session_epoch(dt: datetime, hhmmss: str) -> float:
    """'HH:MM:SS' (gio ICT cua phien) -> epoch giay."""
    try:
        h, m, s = (int(x) for x in hhmmss.split(":")[:3])
    except Exception:
        return time.time()
    base = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    return base.timestamp() + h * 3600 + m * 60 + s


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
    """MQTT tren WS: tu reconnect + subscribe lai + PINGREQ 25s."""

    def __init__(self, url, user, pw, topics, on_msg, subprotocol="mqtt"):
        self.url, self.user, self.pw = url, user, pw
        self.topics, self.on_msg = topics, on_msg
        self.subprotocol = subprotocol
        self.last_msg = 0.0
        self.msgs = 0
        self.connected = False
        self._stop = False

    async def run(self):
        from websockets.asyncio.client import connect
        backoff = 2
        while not self._stop:
            try:
                cid = "tick-" + "".join(
                    random.choices("abcdef0123456789", k=8))
                async with connect(
                        self.url, subprotocols=[self.subprotocol],
                        open_timeout=20, ping_interval=None,
                        max_size=8 * 1024 * 1024) as ws:
                    await ws.send(_mqtt_connect(cid, self.user, self.pw))
                    msg = await asyncio.wait_for(ws.recv(), 20)
                    if not (isinstance(msg, bytes) and msg[0] >> 4 == 2
                            and msg[3] == 0):
                        raise ConnectionError(f"CONNACK rc={msg!r:.40}")
                    await ws.send(_mqtt_subscribe(1, self.topics))
                    self.connected = True
                    backoff = 2
                    last_ping = time.time()
                    while not self._stop:
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
                print(f"[mqtt {self.url.split('/')[2]}] loi: "
                      f"{type(e).__name__}: {str(e)[:120]}", flush=True)
                if self._stop:
                    break
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    def stop(self):
        self._stop = True


# ---------------- SSI (nguon chinh) ----------------

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


class SsiAdapter:
    name = "ssi-mqtt"

    def __init__(self, agg, universe):
        self.agg = agg
        topics = []
        for s in universe:
            topics += [f"s/{s}/MAIN", f"l/{s}/MAIN"]
        topics += ["pe", "i/VNINDEX", "i/VN30"]
        ep, user, pw = ssi_config()
        self.client = MqttWs(ep, user, pw, topics, self._on_msg)

    @property
    def last_msg(self):
        return self.client.last_msg

    @property
    def msgs(self):
        return self.client.msgs

    async def run(self):
        await self.client.run()

    def stop(self):
        self.client.stop()

    def _on_msg(self, topic, payload):
        try:
            if topic.startswith("s/"):
                d = pb_decode(payload, SSI_STOCK)
                sym = d.get("stockSymbol") or topic.split("/")[1]
                if d.get("matchedPrice"):
                    self.agg.on_snapshot(self.name, sym, {
                        "last": d["matchedPrice"] / 1000,
                        "total_volume": d.get("nmTotalTradedQty"),
                        "total_value": d.get("nmTotalTradedValue"),
                        "buy_volume": d.get("buyForeignQtty"),
                        "buy_value": d.get("buyForeignValue"),
                        "sell_volume": d.get("sellForeignQtty"),
                        "sell_value": d.get("sellForeignValue"),
                        "room": d.get("remainForeignQtty"),
                    })
            elif topic.startswith("l/"):
                sym = topic.split("/")[1]
                d = pb_decode(payload, SSI_LE)
                for it in d.get("items", []):
                    if it.get("price") and it.get("vol"):
                        self.agg.on_match(
                            self.name, sym,
                            session_epoch(now_ict(), it.get("time", "")),
                            it["price"] / 1000, it["vol"],
                            it.get("accumulatedVol"))
            elif topic == "pe":
                d = pb_decode(payload, SSI_PE)
                for it in d.get("items", []):
                    if it.get("stockSymbol"):
                        self.agg.on_put(self.name, it["stockSymbol"], it)
        except Exception as e:  # noqa: BLE001
            print(f"[ssi] decode loi {topic}: {str(e)[:100]}",
                  flush=True)


# ---------------- DNSE (du phong 1) ----------------

class DnseAdapter:
    name = "dnse"

    def __init__(self, agg, universe):
        self.agg = agg
        topics = []
        for s in universe:
            topics += [
                f"quotes/krx/mdds/stockinfo/v1/roundlot/symbol/{s}",
                f"quotes/krx/mdds/tick/v1/roundlot/symbol/{s}"]
        # entrade/entrade: tai khoan cong khai trong bundle DNSE
        self.client = MqttWs(
            "wss://datafeed-krx.dnse.com.vn/wss",
            "entrade", "entrade", topics, self._on_msg)

    @property
    def last_msg(self):
        return self.client.last_msg

    @property
    def msgs(self):
        return self.client.msgs

    async def run(self):
        await self.client.run()

    def stop(self):
        self.client.stop()

    @staticmethod
    def _inner(d, key):
        v = d.get(key)
        if isinstance(v, list) and v and isinstance(v[0], dict):
            return v[0]
        return v if isinstance(v, dict) else {}

    @staticmethod
    def _num(node, key, scale=1):
        v = node.get(key)
        if isinstance(v, list):
            v = v[0] if v else None
        if isinstance(v, (int, float)):
            return v * scale
        return None

    def _on_msg(self, topic, payload):
        try:
            d = pb_decode(payload, {})
            if "stockinfo" in topic:
                m = self._inner(d, "f41")
                sym = self._num(m, "f4")
                if not isinstance(sym, str):
                    sym = topic.rsplit("/", 1)[-1]
                self.agg.on_snapshot(self.name, sym, {
                    "last": self._num(m, "f13"),
                    "total_volume": self._num(m, "f22", 10),
                    "total_value": self._num(m, "f25", 10**9),
                    "buy_volume": self._num(m, "f17", 10),
                    "buy_value": self._num(m, "f58", 10**9),
                    "sell_volume": self._num(m, "f18", 10),
                    "sell_value": self._num(m, "f59", 10**9),
                    "room": self._num(m, "f20", 10),
                    "total_room": self._num(m, "f60", 10),
                })
            elif "/tick/" in topic:
                m = self._inner(d, "f45")
                sym = topic.rsplit("/", 1)[-1]
                ts_node = self._inner(m, "f7")
                ts = self._num(ts_node, "f1") or time.time()
                price = self._num(m, "f5")
                vol = self._num(m, "f6", 10)
                if price and vol:
                    self.agg.on_match(self.name, sym, ts, price, vol,
                                      self._num(m, "f10", 10))
        except Exception as e:  # noqa: BLE001
            print(f"[dnse] decode loi {topic}: {str(e)[:100]}",
                  flush=True)


# ---------------- VCI (du phong 2, Socket.IO + protobuf) ----------------

VCI_MATCH = {1: ("type", "s"), 2: ("code", "s"), 3: ("symbol", "s"),
             4: ("matchPrice", "d"), 5: ("matchVol", "d"),
             8: ("foreignBuyVolume", "d"),
             9: ("foreignSellVolume", "d"),
             10: ("foreignBuyValue", "d"),
             11: ("foreignSellValue", "d"),
             16: ("accumulatedVolume", "d"), 18: ("time", "s"),
             22: ("currentRoom", "d"), 23: ("totalRoom", "d"),
             24: ("accumulatedValue", "d")}


class VciAdapter:
    name = "vci"
    URL = ("wss://trading.vietcap.com.vn/ws/price/socket.io/"
           "?EIO=4&transport=websocket")

    def __init__(self, agg, universe):
        self.agg = agg
        self.universe = universe
        self.last_msg = 0.0
        self.msgs = 0
        self._stop = False

    async def run(self):
        from websockets.asyncio.client import connect
        backoff = 2
        while not self._stop:
            try:
                async with connect(
                        self.URL, ping_interval=None, open_timeout=20,
                        max_size=8 * 1024 * 1024,
                        additional_headers={
                            "Origin": "https://trading.vietcap.com.vn",
                            "User-Agent": "Mozilla/5.0"}) as ws:
                    backoff = 2
                    pend_ev = []
                    pending_bin = []
                    while not self._stop:
                        msg = await asyncio.wait_for(ws.recv(), 30)
                        if isinstance(msg, bytes):
                            raw = msg[1:] if msg[:1] == b"b" else msg
                            if pend_ev:
                                ev = pend_ev.pop(0)
                                self._handle(ev, raw)
                            else:
                                pending_bin.append(raw)
                            continue
                        if msg.startswith("0"):
                            await ws.send("40")
                        elif msg == "2":
                            await ws.send("3")
                        elif msg.startswith("40"):
                            subs = json.dumps({"symbols": self.universe})
                            for ev, arg in (
                                    ("app-config", '[{"type":"all"}]'),
                                    ("w-match-price", subs),
                                    ("put-through", '{"group":"HOSE"}')):
                                await ws.send("42" + json.dumps(
                                    [ev, arg], ensure_ascii=False))
                        elif msg.startswith("45"):
                            dash = msg.index("-")
                            pend_ev.append(json.loads(msg[dash + 1:])[0])
                        elif msg.startswith("42"):
                            arr = json.loads(msg[2:])
                            ev, payload = arr[0], arr[1] \
                                if len(arr) > 1 else None
                            if isinstance(payload, dict) \
                                    and "_placeholder" in payload:
                                raw = pending_bin.pop(0) \
                                    if pending_bin else b""
                                self._handle(ev, raw)
            except Exception as e:  # noqa: BLE001
                print(f"[vci] loi: {type(e).__name__}: "
                      f"{str(e)[:120]}", flush=True)
                if self._stop:
                    break
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    def _handle(self, ev, raw):
        if ev != "w-match-price" or not raw:
            return
        try:
            d = pb_decode(raw, VCI_MATCH)
        except Exception:  # noqa: BLE001
            return
        sym = d.get("symbol")
        if not sym:
            return
        self.last_msg = time.time()
        self.msgs += 1
        if d.get("foreignBuyVolume") is not None:
            self.agg.on_snapshot(self.name, sym, {
                "last": d.get("matchPrice"),
                "total_volume": d.get("accumulatedVolume"),
                "total_value": d.get("accumulatedValue"),
                "buy_volume": d.get("foreignBuyVolume"),
                "buy_value": d.get("foreignBuyValue"),
                "sell_volume": d.get("foreignSellVolume"),
                "sell_value": d.get("foreignSellValue"),
                "room": d.get("currentRoom"),
                "total_room": d.get("totalRoom"),
            })
        if d.get("matchPrice") and d.get("matchVol"):
            ts = session_epoch(now_ict(), d.get("time", "")) \
                if d.get("time") else time.time()
            self.agg.on_match(self.name, sym, ts, d["matchPrice"],
                              d["matchVol"], d.get("accumulatedVolume"))

    def stop(self):
        self._stop = True


# ---------------- Tong hop ----------------

class Aggregator:
    def __init__(self):
        self.candles = {}       # sym -> {minute_epoch: [o,h,l,c,v]}
        self.foreign = {}       # sym -> dict snapshot gan nhat
        self.put_foreign = {}   # sym -> cong don thoa thuan (deal)
        self._last_acc = {}     # (src, sym) -> accumulatedVol da xu ly
        self.dirty = set()
        self.matches = 0

    def on_match(self, src, sym, ts, price, vol, acc):
        key = (src, sym)
        if acc is not None:
            if acc <= self._last_acc.get(key, -1):
                return  # ban ghi lap (reconnect replay)
            self._last_acc[key] = acc
        minute = int(ts // 60 * 60)
        b = self.candles.setdefault(sym, {}).get(minute)
        if b is None:
            self.candles[sym][minute] = [price, price, price, price,
                                         vol]
        else:
            b[1] = max(b[1], price)
            b[2] = min(b[2], price)
            b[3] = price
            b[4] += vol
        self.dirty.add(sym)
        self.matches += 1

    def on_snapshot(self, src, sym, snap):
        cur = self.foreign.setdefault(sym, {})
        for k, v in snap.items():
            if v is not None:
                cur[k] = v
        cur["src"] = src

    def on_put(self, src, sym, it):
        cur = self.put_foreign.setdefault(sym, {
            "put_buy_volume": 0, "put_buy_value": 0,
            "put_sell_volume": 0, "put_sell_value": 0, "put_deals": 0})
        cur["put_buy_volume"] += it.get("buyForeignQtty") or 0
        cur["put_buy_value"] += it.get("buyForeignValue") or 0
        cur["put_sell_volume"] += it.get("sellForeignQtty") or 0
        cur["put_sell_value"] += it.get("sellForeignValue") or 0
        cur["put_deals"] += 1
        cur["src"] = src

    @staticmethod
    def _rows(buckets):
        # Dinh dang t giong het intraday REST noi tieu thu dang doc:
        # chuoi gio ICT "%Y-%m-%dT%H:%M" (source_router._intraday_vnd).
        return [{"t": datetime.fromtimestamp(t, ICT).strftime(
                    "%Y-%m-%dT%H:%M"),
                 "o": b[0], "h": b[1], "l": b[2], "c": b[3], "v": b[4]}
                for t, b in sorted(buckets.items())]

    @staticmethod
    def _resample(rows1m, minutes):
        out = {}
        for r in rows1m:
            t = datetime.strptime(r["t"], "%Y-%m-%dT%H:%M") \
                .replace(tzinfo=ICT)
            k = int(t.timestamp()) // (minutes * 60) * (minutes * 60)
            b = out.get(k)
            if b is None:
                out[k] = [r["o"], r["h"], r["l"], r["c"], r["v"]]
            else:
                b[1] = max(b[1], r["h"])
                b[2] = min(b[2], r["l"])
                b[3] = r["c"]
                b[4] += r["v"]
        return Aggregator._rows(out)

    def build_intraday(self, syms):
        out = {}
        for sym in syms:
            rows1m = self._rows(self.candles.get(sym, {}))
            if not rows1m:
                continue
            out[f"{sym}_1m"] = rows1m
            out[f"{sym}_5m"] = self._resample(rows1m, 5)
            out[f"{sym}_15m"] = self._resample(rows1m, 15)
            out[f"{sym}_1H"] = self._resample(rows1m, 60)
        return out

    def build_foreign(self):
        out = {}
        for sym, snap in self.foreign.items():
            e = dict(snap)
            if sym in self.put_foreign:
                e.update(self.put_foreign[sym])
            out[sym] = e
        return out


# ---------------- Publish ----------------

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
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


# ---------------- Dieu phoi + chuyen nguon ----------------

async def _probe_ssi(universe):
    """Do nhanh SSI: connect + subscribe 1 ma, cho publish 10s."""
    agg = Aggregator()
    ad = SsiAdapter(agg, universe[:1])
    task = asyncio.create_task(ad.run())
    try:
        for _ in range(20):
            await asyncio.sleep(0.5)
            if ad.last_msg:
                return True
        return False
    finally:
        ad.stop()
        task.cancel()


async def _collect(max_minutes=0):
    universe = CONFIG["universe"]
    agg = Aggregator()
    started = time.time()
    start_dt = now_ict()
    events, gaps = [], []
    order = [SsiAdapter, DnseAdapter, VciAdapter]
    idx = 0
    adapter = order[0](agg, universe)
    task = asyncio.create_task(adapter.run())
    active_since = time.time()
    gap_start = None
    last_probe = time.time()
    last_publish = 0.0
    publishes = 0
    print(f"[tick] bat dau {start_dt.isoformat()} nguon="
          f"{adapter.name} ma={len(universe)}", flush=True)

    def session_over():
        dt = now_ict()
        if max_minutes:
            return time.time() - started > max_minutes * 60
        return dt.hour * 60 + dt.minute >= 15 * 60 + 5 \
            or dt.weekday() >= 5

    while not session_over():
        await asyncio.sleep(5)
        dt = now_ict()
        stale_limit = CONFIG["lunch_stale_sec"] if in_lunch(dt) \
            else CONFIG["stale_sec"]
        stale = (adapter.last_msg == 0
                 and time.time() - active_since > stale_limit) or \
            (adapter.last_msg > 0
             and time.time() - adapter.last_msg > stale_limit)
        if in_trading_window(dt) and stale and idx < len(order) - 1:
            old = adapter
            gap_start = old.last_msg or active_since
            idx += 1
            adapter = order[idx](agg, universe)
            task.cancel()
            old.stop()
            task = asyncio.create_task(adapter.run())
            active_since = time.time()
            events.append({
                "ts": dt.isoformat(), "from": old.name,
                "to": adapter.name,
                "reason": f"mat tick > {stale_limit}s"})
            print(f"[tick] CHUYEN NGUON {old.name} -> "
                  f"{adapter.name}", flush=True)
        # Ghi nhan khoang mat du lieu khi nguon moi co tin lai
        if gap_start is not None and adapter.last_msg > active_since:
            gaps.append({
                "from_ts": datetime.fromtimestamp(
                    gap_start, ICT).isoformat(),
                "to_ts": dt.isoformat(),
                "dur_sec": round(time.time() - gap_start)})
            gap_start = None
        # Failback: do nguon chinh khi dang o nguon du phong
        if idx > 0 and time.time() - last_probe \
                > CONFIG["failback_probe_sec"]:
            last_probe = time.time()
            if await _probe_ssi(universe):
                old = adapter
                idx = 0
                adapter = order[0](agg, universe)
                task.cancel()
                old.stop()
                task = asyncio.create_task(adapter.run())
                active_since = time.time()
                events.append({
                    "ts": dt.isoformat(), "from": old.name,
                    "to": "ssi-mqtt", "reason": "failback: SSI khoe"})
                print("[tick] FAILBACK -> ssi-mqtt", flush=True)
        # Publish dinh ky
        if time.time() - last_publish >= CONFIG["publish_sec"]:
            last_publish = time.time()
            status = {
                "session_date": start_dt.strftime("%Y-%m-%d"),
                "active_source": adapter.name,
                "active_since": datetime.fromtimestamp(
                    active_since, ICT).isoformat(),
                "msgs_active_source": adapter.msgs,
                "matches_aggregated": agg.matches,
                "symbols_with_candles": len(agg.candles),
                "last_msg_ago_sec": round(time.time()
                                          - adapter.last_msg)
                if adapter.last_msg else None,
                "events": events[-50:], "gaps": gaps[-50:],
                "publishes": publishes,
                "runtime_sec": round(time.time() - started),
            }
            try:
                intra = agg.build_intraday(sorted(agg.dirty))
                agg.dirty.clear()
                payload = {"tick_shadow": {"status": status,
                                           "foreign":
                                           agg.build_foreign()}}
                keys = list(intra.keys())
                for i in range(0, max(len(keys), 1), 40):
                    chunk = {k: intra[k]
                             for k in keys[i:i + 40]}
                    p = {"tick_shadow": dict(payload["tick_shadow"])}
                    if chunk:
                        p["tick_shadow"]["intraday"] = chunk
                    if i > 0:
                        p = {"tick_shadow": {"intraday": chunk}}
                    publish(p, adapter.name)
                publishes += 1
            except Exception as e:  # noqa: BLE001
                print(f"[tick] publish loi: {str(e)[:150]}",
                      flush=True)
    adapter.stop()
    task.cancel()
    # Publish cuoi phien
    try:
        publish({"tick_shadow": {"status": {
            "session_date": start_dt.strftime("%Y-%m-%d"),
            "closed": True, "active_source": adapter.name,
            "events": events[-50:], "gaps": gaps[-50:],
            "matches_aggregated": agg.matches,
            "runtime_sec": round(time.time() - started),
            "publishes": publishes}}}, adapter.name)
    except Exception as e:  # noqa: BLE001
        print(f"[tick] publish cuoi loi: {str(e)[:120]}", flush=True)
    print(f"[tick] ket thuc phien: matches={agg.matches} "
          f"events={len(events)} gaps={len(gaps)} "
          f"runtime={round(time.time() - started)}s", flush=True)
