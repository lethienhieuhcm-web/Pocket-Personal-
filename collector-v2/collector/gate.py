"""Gate task DNSE (§3, §7 dac ta): 1 thread/cong.

Vong: connect (WS + MQTT CONNECT) -> SUBSCRIBE lai sau MOI lan noi ->
doc goi tin -> parse thanh Envelope -> append WAL (fsync theo batch) ->
queue.put (backpressure Q5: day thi DUNG DOC socket, khong drop) ->
loi: phan loai TRANSIENT (backoff + noi lai) / AUTH-CONFIG (dung gate,
log LOUD, khong retry mu) -> reconnect + resubscribe.

KHONG tinh toan, KHONG ghi DB trong gate. Secret (user/pass) chi tu bien
moi truong, khong ghi cung, khong in ra log.
"""
import collections
import logging
import os
import queue
import random
import socket
import threading
import time

from . import dnse_wire, mqtt
from .wal import WalWriter
from .wsclient import WsClient, WsClosed, WsError

log = logging.getLogger("collector.gate")

GATE = "dnse"
BACKOFF_SEQ = (2, 5, 15, 30, 60)
STABLE_AFTER_SEC = 60
SILENCE_SEC = 120
DEFAULT_WS_URL = "wss://datafeed-krx.dnse.com.vn/wss"
DEFAULT_ORIGIN = "https://banggia.dnse.com.vn"
DEFAULT_PROTOCOLS = ("mqtt",)  # DNSE tra 400 neu handshake thieu Sec-WebSocket-Protocol
SUBSCRIBE_CHUNK_TOPICS = 100  # 1 SUBSCRIBE 3040 topic (~137KB) bi broker dong; chia nho


class AuthError(Exception):
    pass


class TransientError(Exception):
    pass


def backoff_delay(attempt, rng=None):
    """Delay giay cho lan thu `attempt` (0-based): day (2,5,15,30,60) +
    jitter ±25%. Ham thuan, test duoc."""
    rng = rng or random
    base = BACKOFF_SEQ[min(attempt, len(BACKOFF_SEQ) - 1)]
    return base * rng.uniform(0.75, 1.25)


class _PacketPump:
    """Doc goi tin MQTT tu WsClient, stash cac goi khong phai loai dang doi."""

    def __init__(self, client):
        self.client = client
        self.buf = bytearray()
        self.stash = collections.deque()

    def _read_more(self):
        chunk = self.client.recv()
        self.buf.extend(chunk)

    def _read_packet(self):
        while True:
            try:
                ptype, _flags, payload, used = mqtt.parse_packet(bytes(self.buf))
            except ValueError:
                self._read_more()
                continue
            del self.buf[:used]
            return ptype, payload

    def next_packet(self):
        if self.stash:
            return self.stash.popleft()
        return self._read_packet()

    def wait_for(self, want_type, stash_others=True):
        # Quet stash hien co dung 1 luot (goi khong khop o lai, giu thu tu);
        # sau do chi doc goi MOI tu socket. Dung pop+append lai goi stash
        # trong vong lap se lap vo han tren cung 1 goi.
        for _ in range(len(self.stash)):
            ptype, payload = self.stash.popleft()
            if ptype == want_type:
                return payload
            self.stash.append((ptype, payload))
        while True:
            ptype, payload = self._read_packet()
            if ptype == want_type:
                return payload
            if stash_others:
                self.stash.append((ptype, payload))
            # Khong stash: bo (chi dung cho goi thua trong giai doan bat tay).


class GateStats:
    def __init__(self):
        self._lock = threading.Lock()
        self.connects = 0
        self.reconnects = 0
        self.msgs = 0
        self.matches = 0
        self.dropped_parse = 0
        self.queue_blocked_sec = 0.0
        self.gaps = 0
        self.flapping = False
        self.connected = False
        self.last_msg_ts = None
        self.last_error = None

    def snapshot(self):
        with self._lock:
            return {"connects": self.connects, "reconnects": self.reconnects,
                    "msgs": self.msgs, "matches": self.matches,
                    "dropped_parse": self.dropped_parse,
                    "queue_blocked_sec": self.queue_blocked_sec,
                    "gaps": self.gaps, "flapping": self.flapping,
                    "connected": self.connected,
                    "last_msg_ts": self.last_msg_ts,
                    "last_error": self.last_error}


class DnseGate(threading.Thread):
    def __init__(self, symbols, out_queue, gap_queue, out_dir,
                 ws_url=None, origin=DEFAULT_ORIGIN, protocols=DEFAULT_PROTOCOLS,
                 client_id=None, username=None, password=None,
                 keepalive=60, silence_sec=SILENCE_SEC,
                 watchdog_armed=None, stop_event=None,
                 time_fn=time.time, monotonic_fn=time.monotonic,
                 rng=None, ws_connect=None):
        super().__init__(daemon=True, name="gate-dnse")
        self.symbols = [str(s).upper() for s in symbols]
        self.queue = out_queue
        self.gap_queue = gap_queue
        self.out_dir = out_dir
        self.ws_url = ws_url or os.environ.get("DNSE_WS_URL", DEFAULT_WS_URL)
        self.origin = origin
        self.protocols = protocols
        self.client_id = client_id or f"collector-v2-{os.getpid()}-{id(self) % 100000}"
        self.username = username if username is not None else os.environ.get("DNSE_MQTT_USER")
        self.password = password if password is not None else os.environ.get("DNSE_MQTT_PW")
        self.keepalive = keepalive
        self.silence_sec = silence_sec
        self.watchdog_armed = watchdog_armed or (lambda: True)
        self.stop_event = stop_event or threading.Event()
        self._time = time_fn
        self._mono = monotonic_fn
        self._rng = rng or random.Random()
        self._ws_connect = ws_connect or WsClient.connect
        self.stats = GateStats()
        self.wal = WalWriter(os.path.join(out_dir, "raw_dnse.jsonl"))
        self._seq = 0
        self._gap_start = None
        self._gap_error = None
        self._gap_times = collections.deque(maxlen=20)

    # -- helpers --
    def _record_gap_start(self, error):
        if self._gap_start is None:
            self._gap_start = self._time()
            self._gap_error = error

    def _record_gap_end(self):
        if self._gap_start is not None:
            up = self._time()
            seconds = up - self._gap_start
            self.gap_queue.put({"gate": GATE, "down_ts": self._gap_start,
                                "up_ts": up, "seconds": seconds,
                                "error": self._gap_error})
            with self.stats._lock:
                self.stats.gaps += 1
                self._gap_times.append(up)
                recent = [t for t in self._gap_times if up - t <= 600]
                self.stats.flapping = len(recent) >= 5
            self._gap_start = None
            self._gap_error = None

    def _queue_put(self, env):
        while not self.stop_event.is_set():
            try:
                self.queue.put(env, timeout=1.0)
                return True
            except queue.Full:
                with self.stats._lock:
                    self.stats.queue_blocked_sec += 1.0
                log.warning("[dnse] queue day, backpressure (dung doc socket)")
        return False

    def _connect_and_subscribe(self):
        try:
            client = self._ws_connect(self.ws_url, origin=self.origin,
                                      protocols=self.protocols, timeout=30.0)
        except WsError as e:
            # 401/403 o handshake = sai key/cau hinh -> dung, khong retry mu.
            if " 401 " in str(e) or " 403 " in str(e):
                raise AuthError(f"handshake: {e}") from e
            raise TransientError(f"handshake: {e}") from e
        pump = _PacketPump(client)
        client.send(mqtt.build_connect(self.client_id, self.username,
                                       self.password, keepalive=self.keepalive))
        try:
            payload = pump.wait_for(2, stash_others=False)
        except (WsClosed, WsError, socket.error) as e:
            raise TransientError(f"cho CONNACK: {e}") from e
        connack = mqtt.parse_connack(payload)
        if connack["return_code"] != 0:
            raise AuthError(f"CONNACK return_code={connack['return_code']}")
        topics = dnse_wire.topics_for(self.symbols)
        packet_id = 1
        for i in range(0, len(topics), SUBSCRIBE_CHUNK_TOPICS):
            chunk = topics[i:i + SUBSCRIBE_CHUNK_TOPICS]
            client.send(mqtt.build_subscribe(packet_id, chunk))
            try:
                payload = pump.wait_for(9, stash_others=True)
            except (WsClosed, WsError, socket.error) as e:
                raise TransientError(f"cho SUBACK: {e}") from e
            suback = mqtt.parse_suback(payload)
            if suback["packet_id"] != packet_id:
                raise TransientError(
                    f"SUBACK packet_id sai: {suback['packet_id']} != {packet_id}")
            if any(rc != 0 for rc in suback["return_codes"]):
                raise AuthError(f"SUBACK tu choi: {suback['return_codes']}")
            packet_id += 1
        return client, pump

    def _serve(self, client, pump):
        """Doc goi tin cho toi khi roi / dung. Tra ve neu stop_event."""
        connected_at = self._mono()
        last_msg = self._mono()
        last_sent = self._mono()
        client.set_timeout(5.0)
        while not self.stop_event.is_set():
            try:
                ptype, payload = pump.next_packet()
            except socket.timeout:
                now = self._mono()
                if self.watchdog_armed() and now - last_msg > self.silence_sec:
                    raise TransientError(f"im lang {now - last_msg:.0f}s > {self.silence_sec}s")
                if now - last_sent > self.keepalive * 0.75:
                    client.send(mqtt.build_pingreq())
                    last_sent = now
                continue
            except (WsClosed, WsError, socket.error) as e:
                raise TransientError(f"doc goi tin: {e}") from e
            last_msg = self._mono()
            last_sent = self._mono()
            if ptype == 3:  # PUBLISH
                topic, body = mqtt.parse_publish_payload(payload)
                self._seq += 1
                with self.stats._lock:
                    self.stats.msgs += 1
                    self.stats.last_msg_ts = self._time()
                env = dnse_wire.parse_message(topic, body, self._time(),
                                              seq=self._seq)
                if env is None:
                    with self.stats._lock:
                        self.stats.dropped_parse += 1
                    continue
                with self.stats._lock:
                    self.stats.matches += 1
                self.wal.append(env.to_dict())
                self.wal.flush_if_due()
                if not self._queue_put(env):
                    return
            # Cac goi khac (PINGRESP 13, ...): bo qua, chi cap nhat last_msg.
            if self._mono() - connected_at >= STABLE_AFTER_SEC:
                self._stable = True

    def run(self):
        attempt = 0
        self._stable = False
        if self.username is None or self.password is None:
            log.error("[dnse] thieu DNSE_MQTT_USER/DNSE_MQTT_PW — gate khong khoi dong")
            with self.stats._lock:
                self.stats.last_error = "missing_credentials"
            return
        while not self.stop_event.is_set():
            try:
                client, pump = self._connect_and_subscribe()
            except AuthError as e:
                log.error("[dnse] AUTH/CONFIG, dung gate, khong retry: %s", e)
                with self.stats._lock:
                    self.stats.last_error = f"auth: {e}"
                self._record_gap_start(str(e))
                break
            except (TransientError, WsError, socket.error) as e:
                self._record_gap_start(str(e))
                with self.stats._lock:
                    self.stats.last_error = str(e)
                delay = backoff_delay(attempt, self._rng)
                log.warning("[dnse] loi ket noi, backoff %.1fs: %s", delay, e)
                self.stop_event.wait(delay)
                attempt += 1
                continue
            with self.stats._lock:
                self.stats.connects += 1
                if attempt > 0:
                    self.stats.reconnects += 1
                self.stats.connected = True
            self._record_gap_end()
            self._stable = False
            try:
                self._serve(client, pump)
            except TransientError as e:
                with self.stats._lock:
                    self.stats.last_error = str(e)
                    self.stats.connected = False
                self._record_gap_start(str(e))
                log.warning("[dnse] rot ket noi: %s", e)
            except Exception as e:  # loi khong phan loai: coi nhu transient, on ao
                with self.stats._lock:
                    self.stats.last_error = f"unexpected: {e}"
                    self.stats.connected = False
                self._record_gap_start(str(e))
                log.exception("[dnse] loi khong phan loai trong _serve")
            finally:
                try:
                    client.close()
                except Exception:
                    pass
            if self.stop_event.is_set():
                break
            if self._stable:
                attempt = 0
            delay = backoff_delay(attempt, self._rng)
            log.warning("[dnse] backoff %.1fs truoc khi noi lai", delay)
            self.stop_event.wait(delay)
            attempt += 1
        # Dong sach: flush WAL cuoi (gap mo neu co se ghi up_ts=None o session).
        try:
            self.wal.flush()
            self.wal.close()
        except Exception:
            pass
        with self.stats._lock:
            self.stats.connected = False

    def stop(self):
        self.stop_event.set()

    def drain_open_gap(self, now):
        """Gap dang mo luc dung (chua noi lai duoc): tra dict up_ts=None."""
        if self._gap_start is None:
            return None
        gap = {"gate": GATE, "down_ts": self._gap_start, "up_ts": None,
               "seconds": now - self._gap_start, "error": self._gap_error}
        self._gap_start = None
        self._gap_error = None
        return gap
