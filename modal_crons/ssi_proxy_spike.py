#!/usr/bin/env python3
"""Spike SSI-proxy CO LAP (job toi thieu, khong phai collector).

App Modal RIENG (ssi-proxy-spike), khong phai app stock-tick-collector,
khong schedule, chi chay khi goi truc tiep. Doc SSI_PROXY_URL tu Modal
secret pocket-personal (khong in URL/creds ra output/log).
Thu: A = proxy= cua websockets>=14; neu A fail thi B = CONNECT tay.
Moi phuong an: WS handshake + MQTT CONNACK + SUBACK + nghe 20s dem tin.
Chi in verdict JSON (stage + so lieu, khong URL, khong creds).
"""
import asyncio
import base64
import json
import os
import random
import re
import socket
import ssl
import struct
import time
import urllib.parse
import urllib.request as ur

import modal

app = modal.App("ssi-proxy-spike")
image = (modal.Image.debian_slim(python_version="3.12")
         .pip_install("websockets>=14"))

SSI_HOST = "price-streaming.ssi.com.vn"
SSI_URL = f"wss://{SSI_HOST}/mqtt"
TOPICS = ["s/FPT/MAIN", "l/FPT/MAIN", "i/VNINDEX"]
HEADERS = {"Origin": "https://fiintrade.ssi.com.vn",
           "User-Agent": "Mozilla/5.0"}
LISTEN_SEC = 20


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
    vh = _enc_str("MQTT") + bytes([4, 0xC2]) + struct.pack(">H", keepalive)
    body = vh + _enc_str(cid) + _enc_str(user) + _enc_str(pw)
    return b"\x10" + _enc_rem(len(body)) + body


def _mqtt_subscribe(pkt_id, topics):
    body = struct.pack(">H", pkt_id)
    for t in topics:
        body += _enc_str(t) + b"\x00"
    return b"\x82" + _enc_rem(len(body)) + body


def _ssi_mqtt_creds():
    try:
        hdr = {"User-Agent": "Mozilla/5.0"}
        base = "https://fiintrade.ssi.com.vn/"
        html = ur.urlopen(ur.Request(base, headers=hdr),
                          timeout=30).read().decode("utf-8", "replace")
        for a in re.findall(r'(?:src|href)="([^"]+\.js)"', html):
            url = a if a.startswith("http") else base + a.lstrip("/")
            try:
                js = ur.urlopen(ur.Request(url, headers=hdr),
                                timeout=30).read().decode(
                                    "utf-8", "replace")
            except Exception:
                continue
            m1 = re.search(r'MQTT_USERNAME="([^"]*)"', js)
            m2 = re.search(r'MQTT_PASSWORD="([^"]*)"', js)
            if m1 and m2:
                return m1.group(1), m2.group(1)
    except Exception:
        pass
    return "mqtt-ssi", "mqtt-ssi"


def _scrub(text, secrets):
    out = str(text)
    for s in secrets:
        if s:
            out = out.replace(s, "***")
    return out[:300]


async def _mqtt_over_ws(ws, user, pw, stages):
    cid = "spike-" + "".join(random.choices("abcdef0123456789", k=8))
    await ws.send(_mqtt_connect(cid, user, pw))
    msg = await asyncio.wait_for(ws.recv(), 20)
    if not (isinstance(msg, bytes) and msg and msg[0] >> 4 == 2):
        raise ConnectionError("first packet not CONNACK")
    stages["connack_rc"] = msg[3]
    if msg[3] != 0:
        raise ConnectionError(f"CONNACK rc={msg[3]}")
    await ws.send(_mqtt_subscribe(1, TOPICS))
    msg = await asyncio.wait_for(ws.recv(), 20)
    stages["suback"] = bool(isinstance(msg, bytes) and msg
                            and msg[0] >> 4 == 9)
    if not stages["suback"]:
        raise ConnectionError("packet after SUBSCRIBE not SUBACK")
    total = 0
    t0 = time.time()
    while time.time() - t0 < LISTEN_SEC:
        try:
            msg = await asyncio.wait_for(ws.recv(), 10)
        except asyncio.TimeoutError:
            await ws.send(b"\xc0\x00")
            continue
        if isinstance(msg, bytes) and msg and msg[0] >> 4 == 3:
            total += 1
    stages["listen"] = {"seconds": LISTEN_SEC, "total_msgs": total}
    return stages


async def _option_a(proxy_url, user, pw, scrub_secrets):
    from websockets.asyncio.client import connect
    stages = {}
    t0 = time.time()
    try:
        async with connect(SSI_URL, proxy=proxy_url,
                           subprotocols=["mqtt"],
                           additional_headers=HEADERS, open_timeout=25,
                           ping_interval=None,
                           max_size=8 * 1024 * 1024) as ws:
            stages["ws"] = f"ok {round((time.time()-t0)*1000)}ms"
            await _mqtt_over_ws(ws, user, pw, stages)
        stages["verdict"] = "PASS"
    except Exception as e:  # noqa: BLE001
        stages["verdict"] = "FAIL"
        stages["error"] = _scrub(f"{type(e).__name__}: {e}",
                                 scrub_secrets)
    return stages


def _open_tunnel(host, port, pu, pp, timeout=25):
    raw = socket.create_connection((host, port), timeout=timeout)
    auth = base64.b64encode(f"{pu}:{pp}".encode()).decode()
    req = (f"CONNECT {SSI_HOST}:443 HTTP/1.1\r\n"
           f"Host: {SSI_HOST}:443\r\n"
           f"Proxy-Authorization: Basic {auth}\r\n"
           f"Proxy-Connection: keep-alive\r\n\r\n")
    raw.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf and len(buf) < 65536:
        chunk = raw.recv(1)
        if not chunk:
            break
        buf += chunk
    line = buf.split(b"\r\n", 1)[0].decode("latin1", "replace")
    parts = line.split(" ")
    code = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else -1
    if code != 200:
        raw.close()
        raise ConnectionError(f"CONNECT resp: {line}")
    return raw, line


async def _option_b(host, port, pu, pp, user, pw, scrub_secrets):
    from websockets.asyncio.client import connect
    stages = {}
    t0 = time.time()
    try:
        raw, line = await asyncio.to_thread(_open_tunnel, host, port,
                                            pu, pp)
        stages["connect_resp"] = line
        stages["tcp_connect_ms"] = round((time.time() - t0) * 1000)
        raw.setblocking(False)
        ctx = ssl.create_default_context()
        async with connect(SSI_URL, sock=raw, ssl=ctx,
                           subprotocols=["mqtt"],
                           additional_headers=HEADERS, open_timeout=25,
                           ping_interval=None,
                           max_size=8 * 1024 * 1024) as ws:
            stages["ws"] = "ok (TLS+WS over manual tunnel)"
            await _mqtt_over_ws(ws, user, pw, stages)
        stages["verdict"] = "PASS"
    except Exception as e:  # noqa: BLE001
        stages["verdict"] = "FAIL"
        stages["error"] = _scrub(f"{type(e).__name__}: {e}",
                                 scrub_secrets)
    return stages


@app.function(image=image,
              secrets=[modal.Secret.from_name("pocket-personal")],
              timeout=300)
def spike() -> dict:
    proxy_url = os.environ.get("SSI_PROXY_URL") or ""
    if not proxy_url:
        return {"verdict": "FAIL", "error": "missing_secret"}
    parts = urllib.parse.urlparse(proxy_url)
    pu = urllib.parse.unquote(parts.username or "")
    pp = urllib.parse.unquote(parts.password or "")
    host, port = parts.hostname, parts.port or 8080
    scrub = [pu, pp, host, proxy_url]
    user, pw = _ssi_mqtt_creds()
    out = {"proxy_present": True}
    out["A"] = asyncio.run(_option_a(proxy_url, user, pw, scrub))
    if out["A"].get("verdict") != "PASS":
        time.sleep(30)
        out["B"] = asyncio.run(_option_b(host, port, pu, pp, user, pw,
                                         scrub))
    else:
        out["B"] = {"verdict": "SKIPPED", "reason": "A PASS"}
    out["verdict"] = ("PASS" if out["A"].get("verdict") == "PASS"
                      or out["B"].get("verdict") == "PASS" else "FAIL")
    return out


@app.local_entrypoint()
def main():
    out = spike.remote()
    print("SPIKE_RESULT_JSON_START")
    print(json.dumps(out, ensure_ascii=False))
    print("SPIKE_RESULT_JSON_END")
