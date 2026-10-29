"""WebSocket client toi thieu, chi stdlib (khong co thu vien ws trong moi
truong chay). Du cho gate MQTT-over-WebSocket cua DNSE: handshake HTTP
Upgrade, frame binary co mask (client -> server), tra ping, gop fragment.

Khong ho tro: extension, frame > 64MB, redirect, proxy (proxy nam o lop
goi: chay tren host co egress phu hop, xem Q1 dac ta).
"""
import base64
import hashlib
import os
import socket
import ssl
import struct
import urllib.parse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 64 * 1024 * 1024


class WsError(Exception):
    pass


class WsClosed(WsError):
    pass


class _Reader:
    def __init__(self, sock):
        self.sock = sock
        self.buf = bytearray()

    def read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WsClosed("socket dong khi doc frame")
            self.buf.extend(chunk)
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def read_byte(self):
        return self.read_exact(1)[0]


class WsClient:
    def __init__(self, sock, reader):
        self.sock = sock
        self.reader = reader
        self.closed = False

    @classmethod
    def connect(cls, url, origin=None, protocols=None, timeout=30.0,
                ssl_context=None):
        u = urllib.parse.urlparse(url)
        if u.scheme not in ("ws", "wss"):
            raise WsError(f"scheme khong ho tro: {u.scheme}")
        host = u.hostname
        port = u.port or (443 if u.scheme == "wss" else 80)
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        raw = socket.create_connection((host, port), timeout=timeout)
        if u.scheme == "wss":
            ctx = ssl_context or ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [f"GET {path} HTTP/1.1",
                 f"Host: {host}:{port}",
                 "Upgrade: websocket",
                 "Connection: Upgrade",
                 f"Sec-WebSocket-Key: {key}",
                 "Sec-WebSocket-Version: 13"]
        if origin:
            lines.append(f"Origin: {origin}")
        if protocols:
            lines.append("Sec-WebSocket-Protocol: " + ", ".join(protocols))
        raw.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        raw.settimeout(timeout)
        reader = _Reader(raw)
        # Doc header HTTP cho toi \r\n\r\n.
        head = bytearray()
        while b"\r\n\r\n" not in head:
            b = reader.read_byte()
            head.append(b)
            if len(head) > 65536:
                raise WsError("header handshake qua lon")
        text = head.decode("latin-1")
        if " 101 " not in text.split("\r\n", 1)[0]:
            raise WsError(f"handshake that bai: {text.splitlines()[0] if text else ''}")
        accept = base64.b64encode(
            hashlib.sha1((key + GUID).encode()).digest()).decode()
        if accept not in text:
            raise WsError("Sec-WebSocket-Accept khong khop")
        return cls(raw, reader)

    def send(self, data):
        """Gui 1 frame binary (FIN, opcode 2), co mask theo chuan client."""
        if self.closed:
            raise WsClosed("da dong")
        mask = os.urandom(4)
        header = bytearray([0x82])
        ln = len(data)
        if ln < 126:
            header.append(0x80 | ln)
        elif ln < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", ln)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", ln)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + mask + masked)

    def ping(self):
        mask = os.urandom(4)
        self.sock.sendall(b"\x89\x80" + mask)

    def recv(self):
        """Doc 1 message hoan chinh (gop fragment). Tra bytes, hoac None neu
        gap ping (da tu tra pong). Raise WsClosed khi gap frame close/EOF."""
        payload = bytearray()
        while True:
            b1, b2 = self.reader.read_exact(2)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self.reader.read_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self.reader.read_exact(8))[0]
            if ln > MAX_FRAME:
                raise WsError(f"frame qua lon: {ln}")
            mask = self.reader.read_exact(4) if masked else None
            data = bytearray(self.reader.read_exact(ln))
            if mask:
                for i in range(len(data)):
                    data[i] ^= mask[i % 4]
            if opcode == 0x9:  # ping -> pong (opcode 0xA), giu nguyen payload
                self._send_control(0xA, bytes(data))
                continue
            if opcode == 0x8:  # close
                self.closed = True
                raise WsClosed("gap frame close")
            if opcode in (0x1, 0x2, 0x0):
                payload.extend(data)
                if fin:
                    return bytes(payload)
            # opcode khac: bo qua.

    def _send_control(self, opcode, data):
        mask = os.urandom(4)
        header = bytes([0x80 | opcode, 0x80 | len(data)])
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(header + mask + masked)

    def set_timeout(self, timeout):
        self.sock.settimeout(timeout)

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self._send_control(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass
