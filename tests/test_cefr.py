#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test tinh nang phan loai tu vung theo CEFR (A1..C2).
- cefrOf tra dung level (du lieu CEFR-J + Octanove, 8690 tu)
- badge hien trong danh sach, loc theo level, sap xep cao->thap / thap->cao
- thong ke theo level, chip chon tu co badge + loc level toi thieu, flashcard co badge
Chay: python tests/test_cefr.py
"""
import http.server, os, threading

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(BASE, "index.html")

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
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("pageerror", lambda e: print("  PAGEERROR:", str(e)[:200]))
        page.goto(base + "/")

        # 1) tra level
        assert page.evaluate("cefrOf('beautiful')") == "A1"
        assert page.evaluate("cefrOf('abandon')") == "B1"
        assert page.evaluate("cefrOf('perseverance')") == "B2"
        assert page.evaluate("cefrOf('reluctantly')") == "C1"
        assert page.evaluate("cefrOf('THE')") == "A1"  # case-insensitive
        assert page.evaluate("cefrOf('serendipity')") == "B1"  # new in 30k set
        assert page.evaluate("cefrOf('zzzzqq')") is None
        n = page.evaluate("CEFR_MAP.size")
        assert n >= 29500, n
        print(f"  cefrOf ({n} tu): PASS")

        # 2) xoa vocab mac dinh, them 4 tu test
        page.click("nav.tabs button[data-tab='tab-vocab']")
        page.evaluate("vocab=[]; saveVocab(); renderVocab(); buildFcQueue();")
        for w, m in [("abandon", "tu bo"), ("perseverance", "su kien tri"),
                     ("the", "mao tu"), ("zzzqux", "tu la")]:
            page.fill("#vWord", w); page.fill("#vMean", m)
            page.click("#vAdd"); page.wait_for_timeout(150)
        html = page.inner_html("#vList")
        for lv in ["A1", "B1", "B2"]:
            assert f">{lv}</span>" in html, f"thieu badge {lv}"
        assert 'title="Not in CEFR data">?</span>' in html
        print("  badge trong danh sach: PASS")

        # 3) thong ke
        stats = page.text_content("#cefrStats")
        assert "A1: 1" in stats and "B1: 1" in stats and "B2: 1" in stats, stats
        print("  thong ke level: PASS")

        # 4) loc theo level
        page.click("#cefrFilters .fchip:nth-child(5)")  # B2 (Tat ca, A1, A2, B1, B2)
        assert page.eval_on_selector_all("#vList .vocab-item", "els=>els.length") == 1
        assert "perseverance" in page.text_content("#vList")
        page.click("#cefrFilters .fchip:nth-child(1)")  # Tat ca
        assert page.eval_on_selector_all("#vList .vocab-item", "els=>els.length") == 4
        page.click("#cefrFilters .fchip:nth-child(8)")  # Chua ro
        assert "zzzqux" in page.text_content("#vList")
        page.click("#cefrFilters .fchip:nth-child(1)")
        print("  loc theo level: PASS")

        # 5) sap xep
        page.select_option("#cefrSort", "desc")
        first = page.text_content("#vList .vocab-item:first-child .w")
        assert "perseverance" in first, first
        page.select_option("#cefrSort", "asc")
        first = page.text_content("#vList .vocab-item:first-child .w")
        assert first.strip().startswith("the"), first
        page.select_option("#cefrSort", "new")
        print("  sap xep cao<->thap: PASS")

        # 6) flashcard co badge
        fc = page.inner_html("#fcWord")
        assert 'class="cefr' in fc, fc
        print("  badge flashcard: PASS")

        # 7) chip chon tu: badge + loc level toi thieu
        page.click("nav.tabs button[data-tab='tab-scan']")
        page.evaluate("setStagedText('abandoned reluctantly beautiful', 'test')")
        page.click("#ocrWordsBtn")
        page.wait_for_timeout(300)
        chips = page.inner_html("#wordChips")
        assert ">B2</span>" in chips and ">C1</span>" in chips and ">A1</span>" in chips
        assert page.eval_on_selector_all("#wordChips .chip", "els=>els.length") == 3
        page.select_option("#chipMinLv", "B2")
        assert page.eval_on_selector_all("#wordChips .chip", "els=>els.length") == 2
        page.select_option("#chipMinLv", "C1")
        assert page.eval_on_selector_all("#wordChips .chip", "els=>els.length") == 1
        assert "reluctantly" in page.text_content("#wordChips")
        print("  chip + loc level: PASS")

        browser.close()
    srv.shutdown()
    print("\nCEFR TESTS PASSED")

if __name__ == "__main__":
    main()
