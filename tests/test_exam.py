#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test bo tu IELTS / TOEIC / TOEFL iBT.
- examOf tra dung exam (IELTS 7782, TOEIC 1248, TOEFL 7166 tu)
- tag exam hien trong danh sach vocab + flashcard
- loc vocab theo exam, thong ke theo exam
- chip: tag exam + loc theo exam
Chay: python tests/test_exam.py
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

        # 1) examOf
        assert page.evaluate("examOf('abandon')") == ["IELTS", "TOEFL"]
        assert page.evaluate("examOf('invoice')") == ["IELTS", "TOEIC"]
        assert page.evaluate("examOf('deficit')") == ["IELTS", "TOEFL"]
        assert page.evaluate("examOf('deadline')") == ["IELTS", "TOEIC", "TOEFL"]
        assert page.evaluate("examOf('INVOICE')") == ["IELTS", "TOEIC"]  # case-insensitive
        assert page.evaluate("examOf('zzzzqq')") == []
        n = page.evaluate("EXAM_SETS.IELTS.size + EXAM_SETS.TOEIC.size + EXAM_SETS.TOEFL.size")
        assert n >= 15000, n
        print(f"  examOf ({n} exam words): PASS")

        # 2) vocab: tag exam trong danh sach
        page.click("nav.tabs button[data-tab='tab-vocab']")
        page.evaluate("vocab=[]; saveVocab(); renderVocab(); buildFcQueue();")
        for w, m in [("abandon", "t1"), ("invoice", "t2"), ("deadline", "t3"), ("zzzqux", "t4")]:
            page.fill("#vWord", w); page.fill("#vMean", m)
            page.click("#vAdd"); page.wait_for_timeout(150)
        html = page.inner_html("#vList")
        assert 'class="exam exam-IELTS">IELTS</span>' in html
        assert 'class="exam exam-TOEIC">TOEIC</span>' in html
        assert 'class="exam exam-TOEFL">TOEFL</span>' in html
        print("  exam tags trong danh sach: PASS")

        # 3) thong ke exam
        stats = page.text_content("#examStats")
        assert "IELTS: 3" in stats and "TOEIC: 2" in stats and "TOEFL: 2" in stats, stats
        print("  thong ke exam: PASS")

        # 4) loc theo exam
        page.click("#examFilters .fchip:nth-child(2)")  # IELTS
        assert page.eval_on_selector_all("#vList .vocab-item", "els=>els.length") == 3
        page.click("#examFilters .fchip:nth-child(3)")  # TOEIC
        items = page.eval_on_selector_all("#vList .vocab-item", "els=>els.length")
        assert items == 2, items
        assert "zzzqux" not in page.text_content("#vList")
        page.click("#examFilters .fchip:nth-child(4)")  # TOEFL
        assert page.eval_on_selector_all("#vList .vocab-item", "els=>els.length") == 2
        page.click("#examFilters .fchip:nth-child(1)")  # All exams
        assert page.eval_on_selector_all("#vList .vocab-item", "els=>els.length") == 4
        print("  loc theo exam: PASS")

        # 5) flashcard co exam tag
        page.evaluate("vocab=[{id:1,w:'deadline',m:'t',ex:'',box:1}]; saveVocab(); renderVocab(); buildFcQueue();")
        fc = page.inner_html("#fcWord")
        assert 'class="exam exam-IELTS">IELTS</span>' in fc and 'class="exam exam-TOEFL">TOEFL</span>' in fc, fc
        page.evaluate("vocab=[]; saveVocab(); renderVocab(); buildFcQueue();")
        print("  exam tag flashcard: PASS")

        # 6) chip: tag exam + loc theo exam
        page.click("nav.tabs button[data-tab='tab-scan']")
        page.evaluate("setStagedText('invoice deadline photosynthesis', 'test')")
        page.click("#ocrWordsBtn")
        page.wait_for_timeout(300)
        chips = page.inner_html("#wordChips")
        assert "exam-IELTS" in chips and "exam-TOEIC" in chips and "exam-TOEFL" in chips
        assert page.eval_on_selector_all("#wordChips .chip", "els=>els.length") == 3
        page.select_option("#chipExam", "TOEIC")
        assert page.eval_on_selector_all("#wordChips .chip", "els=>els.length") == 2
        assert "photosynthesis" not in page.text_content("#wordChips")
        page.select_option("#chipExam", "TOEFL")
        assert page.eval_on_selector_all("#wordChips .chip", "els=>els.length") == 2
        assert "invoice" not in page.text_content("#wordChips")
        page.select_option("#chipExam", "ALL")
        assert page.eval_on_selector_all("#wordChips .chip", "els=>els.length") == 3
        print("  chip + loc exam: PASS")

        browser.close()
    srv.shutdown()
    print("\nEXAM TESTS PASSED")

if __name__ == "__main__":
    main()
