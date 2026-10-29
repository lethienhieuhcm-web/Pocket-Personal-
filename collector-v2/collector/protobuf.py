"""Decoder protobuf wire format toi thieu, viet moi tu dac ta wire format.

Ho tro: varint (0), 64-bit (1), length-delimited (2), 32-bit (5);
zigzag, string UTF-8, float32/float64, message long nhau. Truong la
giua f<no> khi khong co spec, thu decode long nhau, that bai thi giu bytes.
Khong ho tro group (wire type 3/4) — gap thi loi ro rang.
"""
import struct


def encode_varint(value):
    if value < 0:
        raise ValueError("varint am: dung zigzag truoc")
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def read_varint(buf, pos):
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise ValueError("varint dut giua chung")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7
        if shift > 70:
            raise ValueError("varint qua dai")


def _zigzag_decode(v):
    return (v >> 1) ^ -(v & 1)


def _tag(field_no, wire_type):
    return encode_varint((field_no << 3) | wire_type)


def encode_varint_field(field_no, value):
    return _tag(field_no, 0) + encode_varint(value)


def encode_zigzag_field(field_no, value):
    zz = (value << 1) ^ (value >> 63) if value >= 0 else ((-value << 1) - 1)
    return _tag(field_no, 0) + encode_varint(zz)


def encode_double_field(field_no, value):
    return _tag(field_no, 1) + struct.pack("<d", value)


def encode_float_field(field_no, value):
    return _tag(field_no, 5) + struct.pack("<f", value)


def encode_bytes_field(field_no, payload):
    return _tag(field_no, 2) + encode_varint(len(payload)) + payload


def encode_string_field(field_no, text):
    return encode_bytes_field(field_no, text.encode("utf-8"))


def encode_nested_field(field_no, payload):
    return encode_bytes_field(field_no, payload)


def decode(buf, spec=None):
    """spec: {field_no: (name, kind[, sub_spec])}; kind: u/i varint,
    z/Z zigzag, s string, f float32, d float64, n nested."""
    spec = spec or {}
    out = {}
    pos = 0
    while pos < len(buf):
        tag, pos = read_varint(buf, pos)
        no, wt = tag >> 3, tag & 7
        f = spec.get(no)
        if wt == 0:
            v, pos = read_varint(buf, pos)
            if f is None:
                out[f"f{no}"] = v
            else:
                name, kind = f[0], f[1]
                if kind in ("z", "Z"):
                    v = _zigzag_decode(v)
                out[name] = v
        elif wt == 1:
            if pos + 8 > len(buf):
                raise ValueError("fixed64 dut")
            v = struct.unpack_from("<d", buf, pos)[0]
            pos += 8
            out[f[0] if f else f"f{no}"] = v
        elif wt == 5:
            if pos + 4 > len(buf):
                raise ValueError("fixed32 dut")
            v = struct.unpack_from("<f", buf, pos)[0]
            pos += 4
            out[f[0] if f else f"f{no}"] = v
        elif wt == 2:
            ln, pos = read_varint(buf, pos)
            raw = buf[pos:pos + ln]
            if len(raw) != ln:
                raise ValueError("length-delimited dut")
            pos += ln
            if f is None:
                try:
                    out[f"f{no}"] = decode(raw, {})
                except Exception:
                    out[f"f{no}"] = raw
            elif f[1] == "s":
                out[f[0]] = raw.decode("utf-8", "replace")
            elif f[1] == "n":
                out[f[0]] = decode(raw, f[2] if len(f) > 2 else {})
            else:
                out[f[0]] = raw
        else:
            raise ValueError(f"wire type {wt} khong ho tro (field {no})")
    return out
