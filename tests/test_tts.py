#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test multi TTS providers: ElevenLabs / Browser / OpenAI / Google.
- chuyen provider: section hien/dung, hint, status bar
- browser: speak dispatch qua speakBrowserOne (stub), slow rate, chunking
- openai (mock): save&verify, speak goi API 1 lan, lan 2 an cache
- google (mock): save&verify load voices, speak goi API 1 lan, lan 2 an cache
- estCredits theo provider, provider duoc luu lai sau reload
Chay: python tests/test_tts.py
"""
import base64, http.server, io, math, os, struct, threading, wave

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(BASE, "index.html")

OAI_CALLS = {"n": 0}
GGL_CALLS = {"n": 0}

def make_wav():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)
        frames = b"".join(
            struct.pack("<h", int(12000*math.sin(2*math.pi*440*i/22050)))
            for i in range(int(22050*0.4)))
        w.writeframes(frames)
    return buf.getvalue()

WAV = make_wav()
WAV_B64 = base64.b64encode(WAV).decode()
GGL_VOICES = b'{"voices":[{"name":"en-US-Standard-A","languageCodes":["en-US"],"ssmlGender":"FEMALE"},' \
             b'{"name":"en-US-Wavenet-D","languageCodes":["en-US"],"ssmlGender":"MALE"}]}'

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/mock-oai/v1/models":
            body, ctype = b'{"data":[]}', "application/json"
        elif self.path.startswith("/mock-ggl/v1/voices"):
            body, ctype = GGL_VOICES, "application/json"
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
        if self.path == "/mock-oai/v1/audio/speech":
            OAI_CALLS["n"] += 1
            length = int(self.headers.get("Content-Length", 0)); self.rfile.read(length)
            body, ctype = WAV, "audio/mpeg"
        elif self.path.startswith("/mock-ggl/v1/text:synthesize"):
            GGL_CALLS["n"] += 1
            length = int(self.headers.get("Content-Length", 0)); self.rfile.read(length)
            body = ('{"audioContent":"%s"}' % WAV_B64).encode()
            ctype = "application/json"
        else:
            self.send_error(404); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

REWRITE_JS = """
const realFetch = window.fetch.bind(window);
window.fetch = (url, opts) => {
  if (typeof url === 'string' && url.startsWith('https://api.openai.com'))
    url = url.replace('https://api.openai.com', '%%BASE%%/mock-oai');
  if (typeof url === 'string' && url.startsWith('https://texttospeech.googleapis.com'))
    url = url.replace('https://texttospeech.googleapis.com', '%%BASE%%/mock-ggl');
  return realFetch(url, opts);
};
"""

def main():
    from playwright.sync_api import sync_playwright
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
            "--autoplay-policy=no-user-gesture-required"])
        ctx = browser.new_context()
        ctx.add_init_script(REWRITE_JS.replace("%%BASE%%", base))
        page = ctx.new_page()
        page.on("pageerror", lambda e: print("  PAGEERROR:", str(e)[:200]))
        page.goto(base + "/")
        page.wait_for_timeout(500)

        # 1) mac dinh elevenlabs, chua key -> not connected (mo tab Settings vi tab mac dinh la Path)
        page.click("nav.tabs button[data-tab='tab-settings']")
        assert page.evaluate("ttsProvider") == "elevenlabs"
        assert page.is_visible("#prov-elevenlabs")
        assert not page.is_visible("#prov-browser")
        print("  default elevenlabs: PASS")

        # 2) chuyen sang browser
        page.select_option("#ttsProvider", "browser")
        page.wait_for_timeout(300)
        assert page.is_visible("#prov-browser")
        assert not page.is_visible("#prov-elevenlabs")
        assert not page.is_visible("#prov-openai")
        assert "browser" in page.text_content("#stApi")
        assert "free" in page.text_content("#ttsProvHint").lower()
        print("  switch -> browser: PASS")

        # 3) browser speak dispatch (stub speakBrowserOne — IIFE de khong bi evaluate goi lai)
        page.evaluate("""(()=>{ window.__br = [];
          speakBrowserOne = async (t, r) => { window.__br.push([t, r]); }; })()""")
        page.evaluate("speak('hello world')")
        page.wait_for_timeout(300)
        calls = page.evaluate("window.__br")
        assert calls and calls[0][0] == "hello world" and calls[0][1] == 1, calls
        page.evaluate("speak('hi', {slow:true})")
        page.wait_for_timeout(300)
        calls = page.evaluate("window.__br")
        assert calls[-1][1] == 0.75, calls
        # chunking: 900 chars -> 2 chunks (browser max 800)
        page.evaluate("speak('word '.repeat(180))")
        page.wait_for_timeout(300)
        n = page.evaluate("window.__br.length")
        assert n == 4, n  # 2 truoc + 2 chunk moi
        print("  browser speak (dispatch/slow/chunk): PASS")

        # 4) openai: save & verify + speak + cache
        page.select_option("#ttsProvider", "openai")
        page.fill("#oaiKey", "sk-test")
        page.click("#saveOaiKey")
        page.wait_for_function("document.querySelector('#stApi').textContent.includes('openai')", timeout=10000)
        n0 = OAI_CALLS["n"]
        page.evaluate("speak('hello openai')")
        page.wait_for_timeout(1500)
        assert OAI_CALLS["n"] == n0 + 1, OAI_CALLS
        page.evaluate("speak('hello openai')")  # lan 2 -> cache
        page.wait_for_timeout(1500)
        assert OAI_CALLS["n"] == n0 + 1, f"cache miss: {OAI_CALLS}"
        print("  openai speak + cache: PASS")

        # 5) google: save & verify -> load voices; speak + cache
        page.select_option("#ttsProvider", "google")
        page.fill("#gglKey", "AIza-test")
        page.click("#saveGglKey")
        page.wait_for_function("document.querySelectorAll('#gglVoiceSel option').length >= 2", timeout=10000)
        assert "google" in page.evaluate("document.querySelector('#stApi').textContent")
        n0 = GGL_CALLS["n"]
        page.evaluate("speak('hello google')")
        page.wait_for_timeout(1500)
        assert GGL_CALLS["n"] == n0 + 1, GGL_CALLS
        page.evaluate("speak('hello google')")
        page.wait_for_timeout(1500)
        assert GGL_CALLS["n"] == n0 + 1, f"cache miss: {GGL_CALLS}"
        print("  google speak + cache: PASS")

        # 6) estCredits theo provider
        page.evaluate("ttsProvider='elevenlabs'; store.set('ttsProvider','elevenlabs')")
        assert "credits" in page.evaluate("estCredits('hello')")
        page.evaluate("ttsProvider='browser'")
        assert page.evaluate("estCredits('hello')") == "free"
        page.evaluate("ttsProvider='openai'")
        assert "chars" in page.evaluate("estCredits('hello')")
        print("  estCredits per provider: PASS")

        # 7) provider duoc luu sau reload
        page.evaluate("store.set('ttsProvider','google')")
        page.reload()
        page.wait_for_timeout(500)
        assert page.evaluate("ttsProvider") == "google"
        page.click("nav.tabs button[data-tab='tab-settings']")
        assert page.is_visible("#prov-google")
        print("  provider persist after reload: PASS")

        browser.close()
    srv.shutdown()
    print("\nTTS TESTS PASSED")

if __name__ == "__main__":
    main()
