"""Mock broker DNSE cho test offline: TCP + WebSocket handshake + MQTT.

Chi dung trong tests. Noi 127.0.0.1, khong secret, khong mang ngoai.
Script chia se giua cac ket noi: sau moi lan "drop", ket noi moi tiep tuc
tu hanh dong ke tiep — mo phong reconnect + resubscribe cua gate.
"""
import base64
import hashlib
import socket
import socketserver
import struct
import threading
import time

from collector import mqtt

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _read_exact(conn, buf, n):
    while len(buf) < n:
        chunk = conn.recv(65536)
        if not chunk:
            raise ConnectionError("client dong ket noi")
        buf.extend(chunk)
    out = bytes(buf[:n])
    del buf[:n]
    return out


def _ws_send(conn, payload):
    header = bytearray([0x82])
    ln = len(payload)
    if ln < 126:
        header.append(ln)
    elif ln < 65536:
        header.append(126)
        header += struct.pack(">H", ln)
    else:
        header.append(127)
        header += struct.pack(">Q", ln)
    conn.sendall(bytes(header) + payload)


def _ws_recv_message(conn, buf):
    """Doc 1 message WS (client gui, co mask). Tra bytes hoac None neu het."""
    payload = bytearray()
    while True:
        b1, b2 = _read_exact(conn, buf, 2)
        fin = bool(b1 & 0x80)
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", _read_exact(conn, buf, 2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", _read_exact(conn, buf, 8))[0]
        mask = _read_exact(conn, buf, 4) if masked else None
        data = bytearray(_read_exact(conn, buf, ln))
        if mask:
            for i in range(len(data)):
                data[i] ^= mask[i % 4]
        if opcode == 0x8:
            raise ConnectionError("client gui close")
        payload.extend(data)
        if fin:
            return bytes(payload)


def _answer_subscribe(broker, payload):
    """Ghi topics + tra SUBACK (grant QoS 0 het). Dung cho ca 2 vong doc."""
    with broker._lock:
        broker.subscribes += 1
    pid = struct.unpack_from(">H", payload, 0)[0]
    n_topics = 0
    pos = 2
    while pos < len(payload):
        tl = struct.unpack_from(">H", payload, pos)[0]
        with broker._lock:
            broker.topics.append(payload[pos + 2:pos + 2 + tl].decode())
        pos += 2 + tl + 1
        n_topics += 1
    return (b"\x90" + bytes([2 + n_topics]) +
            struct.pack(">H", pid) + b"\x00" * n_topics)


class MockBroker(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, script, connack_code=0):
        self.script = list(script)
        self.connack_code = connack_code
        self._idx = 0
        self._lock = threading.Lock()
        self.connects = 0
        self.handshakes = []
        self.subscribes = 0
        self.topics = []
        self._shutdown_flag = threading.Event()
        super().__init__(("127.0.0.1", 0), _Handler)
        self.port = self.server_address[1]
        self._thread = threading.Thread(target=self.serve_forever,
                                        kwargs={"poll_interval": 0.05},
                                        daemon=True)

    def start(self):
        self._thread.start()
        return self

    def stop(self):
        self._shutdown_flag.set()
        self.shutdown()
        self.server_close()

    def next_action(self):
        with self._lock:
            if self._idx >= len(self.script):
                return None
            action = self.script[self._idx]
            self._idx += 1
            return action


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        broker = self.server
        buf = bytearray()
        self.request.settimeout(5.0)
        # -- handshake HTTP --
        head = bytearray()
        while b"\r\n\r\n" not in head:
            chunk = self.request.recv(4096)
            if not chunk:
                return
            head.extend(chunk)
            if len(head) > 65536:
                return
        key = None
        for line in head.decode("latin-1").split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
        if not key:
            return
        accept = base64.b64encode(
            hashlib.sha1((key + GUID).encode()).digest()).decode()
        self.request.sendall(
            ("HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\nConnection: Upgrade\r\n"
             f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        with broker._lock:
            broker.connects += 1
            broker.handshakes.append(head.decode("latin-1"))
        # -- MQTT: cho CONNECT -> CONNACK, SUBSCRIBE -> SUBACK --
        mqtt_buf = bytearray()
        subscribed = False
        while not subscribed:
            try:
                msg = _ws_recv_message(self.request, buf)
            except (ConnectionError, socket.timeout):
                return
            mqtt_buf.extend(msg)
            while True:
                try:
                    ptype, _f, payload, used = mqtt.parse_packet(bytes(mqtt_buf))
                except ValueError:
                    break
                del mqtt_buf[:used]
                if ptype == 1:  # CONNECT
                    _ws_send(self.request,
                             b"\x20\x02\x00" + bytes([broker.connack_code]))
                elif ptype == 8:  # SUBSCRIBE
                    _ws_send(self.request, _answer_subscribe(broker, payload))
                    subscribed = True
                elif ptype == 12:  # PINGREQ
                    _ws_send(self.request, b"\xd0\x00")
        # -- chay script --
        self.request.settimeout(0.2)
        while not broker._shutdown_flag.is_set():
            # Xa frame nao client gui them (PINGREQ...), tra PINGRESP.
            try:
                msg = _ws_recv_message(self.request, buf)
                mqtt_buf.extend(msg)
                while True:
                    try:
                        ptype, _f, _p, used = mqtt.parse_packet(bytes(mqtt_buf))
                    except ValueError:
                        break
                    del mqtt_buf[:used]
                    if ptype == 12:
                        _ws_send(self.request, b"\xd0\x00")
                    elif ptype == 8:  # SUBSCRIBE tiep theo (chia nho)
                        _ws_send(self.request,
                                 _answer_subscribe(broker, _p))
            except socket.timeout:
                pass
            except (ConnectionError, OSError):
                return
            action = broker.next_action()
            if action is None:
                time.sleep(0.05)
                continue
            kind = action[0]
            if kind == "publish":
                _ws_send(self.request,
                         mqtt.build_publish(action[1], action[2]))
            elif kind == "drop":
                try:
                    self.request.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                return
            elif kind == "wait":
                time.sleep(action[1])
            time.sleep(0.02)
