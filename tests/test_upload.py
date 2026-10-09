#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test that tinh nang tai file (PDF/DOCX/TXT) cua English Lab.

- Sinh file that: .txt, .docx (python-docx), .pdf co text (reportlab),
  .pdf scan (anh raster -> khong co text layer).
- pdf.js + mammoth phuc vu local qua route interception (tranh proxy sandbox).
- Kiem tra: doc duoc text 3 dinh dang, nut OCR fallback hien voi PDF scan,
  them cau vao ngan hang, chunkText cat text dai dung.
Chay: python tests/test_upload.py
"""
import http.server, os, threading

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(BASE, "index.html")
DOC = "/tmp/docassets"
TMP = "/tmp/elab_up"

TXT_TEXT = "The early bird catches the worm. A journey of a thousand miles begins with a single step."
DOCX_PARAS = ["Bright vixens jump; dozy fowl quack.", "Second docx paragraph for testing."]
PDF_PAGES = ["The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.",
             "How vexingly quick daft zebras jump!"]

def gen_files():
    os.makedirs(TMP, exist_ok=True)
    # txt
    with open(f"{TMP}/t.txt", "w") as f: f.write(TXT_TEXT)
    # docx
    from docx import Document
    d = Document()
    for p in DOCX_PARAS: d.add_paragraph(p)
    d.save(f"{TMP}/t.docx")
    # pdf co text
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import letter
    c = canvas.Canvas(f"{TMP}/t.pdf", pagesize=letter)
    c.drawString(72, 720, PDF_PAGES[0]); c.showPage()
    c.drawString(72, 720, PDF_PAGES[1]); c.save()
    # pdf scan (anh raster, khong co text layer)
    from PIL import Image, ImageDraw, ImageFont
    font = None
    for pth in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(pth):
            from PIL import ImageFont as IF
            font = IF.truetype(pth, 48); break
    img = Image.new("RGB", (1200, 300), "white")
    ImageDraw.Draw(img).text((40, 100), "Scanned page with no text layer", fill="black", font=font)
    img.save(f"{TMP}/scan_src.png")
    c2 = canvas.Canvas(f"{TMP}/scan.pdf", pagesize=letter)
    c2.drawImage(f"{TMP}/scan_src.png", 72, 500, width=468, height=117)
    c2.save()
    print("  da sinh 4 file test")

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

def rh(route):
    url = route.request.url
    if "pdfjs-dist@3.11.174/build/pdf.min.js" in url:
        return route.fulfill(path=f"{DOC}/pdf.min.js", content_type="application/javascript")
    if "pdf.worker.min.js" in url:
        return route.fulfill(path=f"{DOC}/pdf.worker.min.js", content_type="application/javascript")
    if "mammoth.browser.min.js" in url:
        return route.fulfill(path=f"{DOC}/mammoth.browser.min.js", content_type="application/javascript")
    print(f"  !! CDN khong map: {url[:100]}")
    return route.abort()

def upload(page, fname):
    page.evaluate("window.__prevText = document.querySelector('#ocrText').value")
    page.set_input_files("#docFile", f"{TMP}/{fname}")
    # cho den khi text DOI (file moi doc xong) hoac nut OCR fallback hien
    page.wait_for_function(
        "document.querySelector('#ocrText').value !== window.__prevText || "
        "document.querySelector('#docOcrBtn').style.display !== 'none'",
        timeout=60000)

def main():
    from playwright.sync_api import sync_playwright
    gen_files()
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("pageerror", lambda e: print("  PAGEERROR:", str(e)[:200]))
        page.route("**/cdn.jsdelivr.net/**", rh)
        page.goto(base + "/")
        page.click("nav.tabs button[data-tab='tab-scan']")

        # 1) TXT
        upload(page, "t.txt")
        assert "early bird" in page.input_value("#ocrText")
        print("  TXT: PASS")

        # 2) DOCX
        upload(page, "t.docx")
        txt = page.input_value("#ocrText")
        assert "Bright vixens" in txt and "Second docx" in txt, txt[:80]
        print("  DOCX: PASS")

        # 3) PDF co text
        upload(page, "t.pdf")
        txt = page.input_value("#ocrText")
        assert "quick brown fox" in txt and "daft zebras" in txt, txt[:80]
        assert "2 pages" in page.text_content("#ocrConf")
        print("  PDF text: PASS")

        # 4) them cau tu text PDF vao ngan hang
        page.click("#ocrToSents")
        page.wait_for_timeout(400)
        assert "quick brown fox" in (page.text_content("#sList") or "")
        print("  them cau tu file: PASS")

        # 5) PDF scan -> hien nut OCR fallback
        page.set_input_files("#docFile", f"{TMP}/scan.pdf")
        page.wait_for_function(
            "document.querySelector('#docOcrBtn').style.display !== 'none'",
            timeout=60000)
        print("  PDF scan -> nut OCR fallback: PASS")

        # 6) chunkText: text dai cat dung
        n = page.evaluate("chunkText('a '.repeat(3000)).length")
        assert n == 2, f"6000 ky tu phai cat 2 doan, got {n}"
        n1 = page.evaluate("chunkText('hello world').length")
        assert n1 == 1
        print("  chunkText: PASS")

        browser.close()
    srv.shutdown()
    print("\nUPLOAD TESTS PASSED")

if __name__ == "__main__":
    main()
