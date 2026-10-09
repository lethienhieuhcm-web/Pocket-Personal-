#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test tu dien Anh-Anh cua English Lab (dictionaryapi.dev).
- Mock API qua route interception (tranh proxy sandbox).
- Kiem tra: tra tu hien dinh nghia/phien am/loai tu/vi du/tu dong nghia,
  cache (request 2 lan chi goi API 1 lan), tu khong co -> bao dep,
  nut 📖 tren tung dong tu vung mo dung tu.
Chay: python tests/test_dict.py
"""
import http.server, json, os, threading

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(BASE, "index.html")

RESILIENT = [{
    "word": "resilient",
    "phonetic": "/rɪˈzɪl.jənt/",
    "phonetics": [{"text": "/rɪˈzɪl.jənt/",
                   "audio": "https://api.dictionaryapi.dev/media/pronunciations/en/resilient-us.mp3"}],
    "meanings": [{
        "partOfSpeech": "adjective",
        "definitions": [
            {"definition": "Able to endure tribulation without cracking.",
             "example": "Children are remarkably resilient."},
            {"definition": "Returning quickly to original shape after being bent."}
        ],
        "synonyms": ["flexible", "strong"],
        "antonyms": []
    }],
    "sourceUrls": ["https://en.wiktionary.org/wiki/resilient"]
}]
NOTFOUND = {"title": "No Definitions Found",
            "message": "Sorry pal, we couldn't find definitions for the word you were looking for."}

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        with open(PAGE, "rb") as f: body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

def main():
    from playwright.sync_api import sync_playwright
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    hits = []

    def rh(route):
        url = route.request.url
        word = url.rstrip("/").split("/")[-1]
        hits.append(word)
        if word == "resilient":
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps(RESILIENT))
        return route.fulfill(status=404, content_type="application/json",
                             body=json.dumps(NOTFOUND))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("pageerror", lambda e: print("  PAGEERROR:", str(e)[:200]))
        page.route("**/api.dictionaryapi.dev/**", rh)
        page.goto(base + "/")
        page.click("nav.tabs button[data-tab='tab-vocab']")
        page.evaluate("localStorage.removeItem('elab_dict')")

        # 1) tra tu
        page.fill("#dictWord", "resilient")
        page.click("#dictBtn")
        page.wait_for_function(
            "document.querySelector('#dictModal').style.display==='flex' && "
            "!document.querySelector('#dictBody').textContent.includes('Looking up')",
            timeout=15000)
        body = page.inner_html("#dictBody")
        assert "tribulation" in body and "adjective" in body, body[:200]
        assert "rɪˈzɪl" in body and "Children are remarkably resilient" in body
        assert "flexible" in body
        assert page.eval_on_selector("#dictAudio", "el=>!!el")
        assert page.text_content("#dictTitle") == "resilient"
        print("  tra tu hien nghia: PASS")

        # 2) cache: tra lai khong goi API nua
        n1 = len(hits)
        page.click("#dictClose")
        page.click("#dictBtn")
        page.wait_for_timeout(800)
        assert len(hits) == n1, f"cache hong: {len(hits)} != {n1}"
        print("  cache: PASS")

        # 3) tu khong co
        page.click("#dictClose")
        page.fill("#dictWord", "zzzqq")
        page.click("#dictBtn")
        page.wait_for_function(
            "document.querySelector('#dictBody').textContent.includes('No definition found')",
            timeout=15000)
        print("  tu khong co -> bao dep: PASS")

        # 4) nut 📖 tren dong tu vung
        page.click("#dictClose")
        page.evaluate("vocab=[]; saveVocab(); renderVocab(); buildFcQueue();")
        page.fill("#vWord", "resilient"); page.fill("#vMean", "kien cuong")
        page.click("#vAdd"); page.wait_for_timeout(300)
        page.click("#vList .vocab-item [data-a='dict']")
        page.wait_for_function(
            "document.querySelector('#dictModal').style.display==='flex' && "
            "document.querySelector('#dictBody').textContent.includes('tribulation')",
            timeout=15000)
        assert page.text_content("#dictTitle") == "resilient"
        print("  nut 📖 tren dong tu: PASS")

        browser.close()
    srv.shutdown()
    print("\nDICT TESTS PASSED")

if __name__ == "__main__":
    main()
