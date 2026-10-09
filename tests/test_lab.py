#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test that English Lab tren trinh duyet that, mock ElevenLabs API.

Mock:
  GET  /v1/voices          -> danh sach giong gia
  GET  /v1/user            -> subscription gia (con 90000 credits)
  POST /v1/text-to-speech/*-> file wav tone 0.4s (sinh bang python wave)

Kiem tra:
  1. nhap key -> load voices -> quota hien thi
  2. vocab: them tu -> phat am -> API chi goi 1 lan (lan 2 an cache)
  3. dictation: go dung -> 100%, go sai -> diem thap + highlight
  4. flashcard: nho roi -> tu roi khoi hang doi
Chay: python tests/test_lab.py
"""
import http.server, functools, io, math, os, struct, threading, wave

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(BASE, "index.html")

TTS_CALLS = {"n": 0}

def make_wav():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)
        frames = b"".join(
            struct.pack("<h", int(12000*math.sin(2*math.pi*440*i/22050)))
            for i in range(int(22050*0.4))
        )
        w.writeframes(frames)
    return buf.getvalue()

WAV = make_wav()
VOICES_JSON = b'''{"voices":[
 {"voice_id":"v-rachel","name":"Rachel","labels":{"accent":"american"}},
 {"voice_id":"v-adam","name":"Adam","labels":{"accent":"american"}}]}'''
USER_JSON = b'''{"subscription":{"tier":"creator","character_count":10000,"character_limit":100000}}'''

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/v1/voices":
            body, ctype = VOICES_JSON, "application/json"
        elif self.path == "/v1/user":
            body, ctype = USER_JSON, "application/json"
        elif self.path in ("/", "/index.html"):
            with open(PAGE, "rb") as f: body = f.read()
            ctype = "text/html; charset=utf-8"
        else:
            self.send_error(404); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if self.path.startswith("/v1/text-to-speech/"):
            TTS_CALLS["n"] += 1
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(WAV)))
            self.end_headers(); self.wfile.write(WAV)
        else:
            self.send_error(404)

def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

def main():
    from playwright.sync_api import sync_playwright
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        # patch API base ve server mock truoc khi page load
        browser = p.chromium.launch(headless=True, args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
        ])
        ctx = browser.new_context(locale="vi-VN")
        ctx.add_init_script(
            f"Object.defineProperty(window,'__API_OVERRIDE__',{{value:'{base}/v1'}});"
        )
        page = ctx.new_page()
        page.goto(base + "/")
        # patch bien API trong page (script dung const API) -> thay bang cach rewrite fetch
        page.evaluate(f"""() => {{
            const realFetch = window.fetch.bind(window);
            window.fetch = (url, opts) => {{
                if (typeof url === 'string' && url.startsWith('https://api.elevenlabs.io/v1'))
                    url = url.replace('https://api.elevenlabs.io/v1', '{base}/v1');
                return realFetch(url, opts);
            }};
        }}""")

        # 1) nhap key -> load voices + quota (mo tab Settings vi tab mac dinh la Path)
        page.click("nav.tabs button[data-tab='tab-settings']")
        page.fill("#apiKey", "sk-test")
        page.click("#saveKey")
        page.wait_for_function("document.querySelectorAll('#voiceSel option').length >= 2", timeout=15000)
        page.wait_for_function("document.querySelector('#quota').textContent.includes('90.000')", timeout=15000)
        names = page.eval_on_selector_all("#voiceSel option", "els => els.map(e => e.textContent)")
        assert any("Rachel" in n for n in names), names
        print("  settings: key + voices + quota PASS")

        # 2) vocab: them tu, phat am 2 lan -> API goi dung 1 lan (cache)
        page.click("nav.tabs button[data-tab='tab-vocab']")
        page.fill("#vWord", "testword"); page.fill("#vMean", "từ kiểm tra"); page.fill("#vEx", "This is a testword.")
        page.click("#vAdd")
        page.wait_for_selector(".vocab-item .w")
        n0 = TTS_CALLS["n"]
        page.click(".vocab-item [data-a='hear']")
        page.wait_for_timeout(2500)  # cho fetch + play xong
        assert TTS_CALLS["n"] == n0 + 1, f"lan 1 phai goi API 1 lan, got {TTS_CALLS['n']-n0}"
        page.click(".vocab-item [data-a='hear']")
        page.wait_for_timeout(2500)
        assert TTS_CALLS["n"] == n0 + 1, "lan 2 phai an cache, khong goi API nua"
        print("  vocab: them + phat am + cache PASS")

        # 3) dictation: khoa random de cau luon la cau dau tien
        page.click("nav.tabs button[data-tab='tab-dict']")
        page.evaluate("Math.random = () => 0")
        page.click("#dNew")  # -> "Could you speak a little more slowly, please?"
        target = "Could you speak a little more slowly, please?"
        page.click("#dPlay")
        page.wait_for_timeout(1500)
        page.fill("#dInput", target)
        page.click("#dCheck")
        score = page.text_content("#dScore")
        assert "100%" in score, f"diem phai 100%, got {score}"
        # go sai
        page.fill("#dInput", "Could you speak little slow please")
        page.click("#dCheck")
        score2 = page.text_content("#dScore")
        assert "100%" not in score2, f"go sai ma van 100%: {score2}"
        print("  dictation: cham diem dung/sai PASS")

        # 4) flashcard: nho roi -> giam hang doi
        page.click("nav.tabs button[data-tab='tab-vocab']")
        before = page.text_content("#fcCount")
        page.click("#flashcard")  # lat the
        page.click("#fcKnow")
        after = page.text_content("#fcCount")
        assert before != after, f"hang doi phai doi: {before} -> {after}"
        print("  flashcard: nho roi PASS")

        browser.close()
    srv.shutdown()
    print(f"\nALL TESTS PASSED (TTS API calls: {TTS_CALLS['n']})")

if __name__ == "__main__":
    main()
