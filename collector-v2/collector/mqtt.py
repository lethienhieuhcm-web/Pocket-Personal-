"""Codec goi tin MQTT v3.1.1 (CONNECT/SUBSCRIBE/PUBLISH/PINGREQ + phan tich
CONNACK/SUBACK). Viet moi tu dac ta MQTT 3.1.1. Chi QoS 0 cho duong thu.
"""
import struct


def encode_remaining_length(n):
    if n < 0 or n > 268435455:
        raise ValueError("remaining length ngoai khoang")
    out = bytearray()
    while True:
        b = n % 128
        n //= 128
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def decode_remaining_length(buf, pos):
    multiplier = 1
    value = 0
    while True:
        if pos >= len(buf):
            raise ValueError("remaining length dut")
        b = buf[pos]
        pos += 1
        value += (b & 0x7F) * multiplier
        if not b & 0x80:
            return value, pos
        multiplier *= 128
        if multiplier > 128 * 128 * 128:
            raise ValueError("remaining length qua dai")


def _utf8(text):
    raw = text.encode("utf-8")
    return struct.pack(">H", len(raw)) + raw


def build_connect(client_id, username=None, password=None, keepalive=60,
                  clean_session=True):
    flags = 0
    if username is not None:
        flags |= 0x80
    if password is not None:
        flags |= 0x40
    if clean_session:
        flags |= 0x02
    body = b"\x00\x04MQTT\x04" + bytes([flags]) + struct.pack(">H", keepalive)
    body += _utf8(client_id)
    if username is not None:
        body += _utf8(username)
    if password is not None:
        body += _utf8(password)
    return b"\x10" + encode_remaining_length(len(body)) + body


def build_subscribe(packet_id, topics):
    body = struct.pack(">H", packet_id)
    for topic in topics:
        body += _utf8(topic) + b"\x00"  # QoS 0
    return b"\x82" + encode_remaining_length(len(body)) + body


def build_pingreq():
    return b"\xc0\x00"


def build_publish(topic, payload):
    body = _utf8(topic) + payload
    return b"\x30" + encode_remaining_length(len(body)) + body


def parse_packet(buf):
    """Tra ve (packet_type, flags, payload, bytes_da_dung).
    packet_type: so 4 bit cao cua byte dau (1 CONNECT, 3 PUBLISH, ...)."""
    if len(buf) < 2:
        raise ValueError("goi tin qua ngan")
    header = buf[0]
    length, pos = decode_remaining_length(buf, 1)
    end = pos + length
    if end > len(buf):
        raise ValueError("goi tin chua du (cho them bytes)")
    return header >> 4, header & 0x0F, buf[pos:end], end


def parse_publish_payload(payload):
    if len(payload) < 2:
        raise ValueError("PUBLISH rong")
    tlen = struct.unpack_from(">H", payload, 0)[0]
    topic = payload[2:2 + tlen].decode("utf-8")
    return topic, payload[2 + tlen:]


def parse_connack(payload):
    if len(payload) < 2:
        raise ValueError("CONNACK ngan")
    return {"session_present": bool(payload[0] & 0x01), "return_code": payload[1]}


def parse_suback(payload):
    if len(payload) < 3:
        raise ValueError("SUBACK ngan")
    packet_id = struct.unpack_from(">H", payload, 0)[0]
    return {"packet_id": packet_id, "return_codes": list(payload[2:])}
