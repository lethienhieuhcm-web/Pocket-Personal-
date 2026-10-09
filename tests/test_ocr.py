#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test that tab Scan (OCR) cua English Lab, chay Tesseract.js THAT.

De tranh van de proxy cua sandbox voi Chromium, moi asset Tesseract
(tesseract.min.js, worker.min.js, core wasm, eng.traineddata) duoc tai san
ve /tmp/tess va phuc vu local qua Playwright route interception.
Trang web van chay code that 100% (chi doi URL tai).

- Sinh anh PNG bang PIL voi chu tieng Anh ro rang.
- Nap anh vao input file -> an "Doc chu" -> OCR that doc ra text
  -> them cau vao ngan hang -> chon tu vao tu vung.
Chay: python tests/test_ocr.py
"""
import http.server, os, threading

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(BASE, "index.html")
IMG = "/tmp/ocr_test.png"
TESS = "/tmp/tess"

LINES = ["Learning English takes time", "Practice makes perfect."]

ASSETS = {
    "tesseract.js@5.1.1/dist/tesseract.min.js": ("tesseract.min.js", "application/javascript"),
    "tesseract.js@5.1.1/dist/worker.min.js": ("worker.min.js", "application/javascript"),
    "tesseract-core-simd-lstm.wasm.js": ("core/tesseract-core-simd-lstm.wasm.js", "application/javascript"),
    "tesseract-core-simd-lstm.wasm": ("core/tesseract-core-simd-lstm.wasm", "application/wasm"),
}

def check_assets():
    missing = [p for p, _ in ASSETS.values() if not os.path.exists(os.path.join(TESS, p))]
    missing += [] if os.path.exists(os.path.join(TESS, "eng.traineddata.gz")) else ["eng.traineddata.gz"]
    if missing:
        raise RuntimeError(f"thieu asset Tesseract: {missing} (tai vao {TESS} truoc)")

def make_image():
    from PIL import Image, ImageDraw, ImageFont
    font = None
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(p):
            font = ImageFont.truetype(p, 64); break
    if font is None:
        raise RuntimeError("khong tim thay font DejaVu de sinh anh test")
    img = Image.new("RGB", (1400, 420), "white")
    d = ImageDraw.Draw(img)
    y = 50
    for line in LINES:
        d.text((60, y), line, fill="black", font=font)
        y += 150
    img.save(IMG)
    print(f"  da sinh anh test: {IMG}")

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        with open(PAGE, "rb") as f: body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

def route_handler(route):
    url = route.request.url
    if "dist/tesseract.min.js" in url:
        return route.fulfill(path=os.path.join(TESS, "tesseract.min.js"),
                             content_type="application/javascript")
    if "dist/worker.min.js" in url:
        return route.fulfill(path=os.path.join(TESS, "worker.min.js"),
                             content_type="application/javascript")
    if "tesseract.js-core@" in url:
        # phuc vu generic theo ten file: tesseract-core[-simd][-lstm].wasm[.js]
        fname = url.rstrip("/").split("/")[-1].split("?")[0]
        local = os.path.join(TESS, "core", fname)
        if os.path.exists(local):
            ctype = "application/wasm" if fname.endswith(".wasm") else "application/javascript"
            return route.fulfill(path=local, content_type=ctype)
        print(f"  !! thieu file core local: {fname}")
    if "@tesseract.js-data/" in url:
        return route.fulfill(path=os.path.join(TESS, "eng.traineddata.gz"),
                             content_type="application/gzip")
    print(f"  !! CDN request khong map duoc: {url[:120]}")
    return route.abort()

def main():
    from playwright.sync_api import sync_playwright
    check_assets()
    make_image()
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("pageerror", lambda e: print("  PAGEERROR:", str(e)[:200]))
        page.route("**/cdn.jsdelivr.net/**", route_handler)
        page.goto(base + "/")
        page.click("nav.tabs button[data-tab='tab-scan']")

        # nap anh vao input (mo phong chup anh)
        page.set_input_files("#scanFileLib", IMG)
        page.wait_for_function("!document.querySelector('#scanOCR').disabled", timeout=15000)
        assert page.eval_on_selector("#scanPreview", "el => el.style.display") == "block"
        print("  nap anh + preview: PASS")

        # OCR that (local assets, khong can mang ngoai)
        page.click("#scanOCR")
        page.wait_for_function(
            "document.querySelector('#ocrResultCard').style.display === 'block'",
            timeout=180000)
        text = (page.input_value("#ocrText") or "").lower()
        assert "learning" in text and "practice" in text, f"OCR sai: {text!r}"
        print(f"  OCR doc dung: PASS ({text[:60]!r}...)")

        # them cau vao ngan hang
        page.click("#ocrToSents")
        page.wait_for_timeout(500)
        slist = page.text_content("#sList") or ""
        assert "Learning English takes time" in slist, "cau khong vao ngan hang"
        print("  them cau vao ngan hang: PASS")

        # chon tu vao tu vung (chip hien ca badge CEFR -> lay text node dau)
        page.click("#ocrWordsBtn")
        page.wait_for_selector("#wordChips .chip")
        chips = page.eval_on_selector_all("#wordChips .chip",
            "els => els.map(e => e.childNodes[0].textContent)")
        assert "learning" in chips, f"thieu chip 'learning': {chips}"
        # chip co badge level: kiem tra badge B2 cho 'learning'
        badges = page.eval_on_selector_all("#wordChips .chip", "els => els.map(e => e.textContent)")
        assert any(b == "learningB2" for b in badges), badges
        page.click("#wordChips .chip >> text=learning")
        page.click("#ocrAddWords")
        page.wait_for_timeout(500)
        vlist = page.text_content("#vList") or ""
        assert "learning" in vlist.lower(), "tu khong vao tu vung"
        print("  chon tu vao tu vung: PASS")

        browser.close()
    srv.shutdown()
    print("\nOCR TESTS PASSED")

if __name__ == "__main__":
    main()
