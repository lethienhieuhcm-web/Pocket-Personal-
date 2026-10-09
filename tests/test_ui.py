"""UI redesign test: ELSA light theme + bottom nav + Cake vocab + Quizlet modes + Memrise path."""
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

def serve():
    h = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

def main():
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 390, "height": 844})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"{base}/index.html", wait_until="networkidle")
        pg.wait_for_function("document.querySelector('#pathList .path-row')", timeout=15000)

        # 1) header moi + theme sang
        title = pg.text_content(".app-title")
        assert "English Lab" in title, title
        bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
        assert bg == "rgb(238, 243, 250)", f"theme chua sang: {bg}"
        assert pg.is_visible("#stApi") and pg.is_visible("#stCredits") and pg.is_visible("#stStreak")
        assert pg.query_selector("#statusbar") is None, "statusbar cu phai bi xoa"
        print("  header + light theme PASS")

        # 2) bottom nav: 7 nut, Path mac dinh
        labels = pg.eval_on_selector_all("nav.tabs button", """els => els.map(e => {
            const ico = e.querySelector('.ico').textContent;
            return e.textContent.replace(ico, '').replace(/\\d+ due/, '').trim();
        })""")
        assert labels == ["Path", "Vocab", "Quiz", "Shadow", "Dict", "Scan", "Settings"], labels
        assert "active" in pg.get_attribute("#tab-path", "class"), "tab Path phai active mac dinh"
        pos = pg.evaluate("getComputedStyle(document.querySelector('nav.tabs')).position")
        assert pos == "fixed", pos
        print("  bottom nav PASS")

        # 3) learning path: 6 hang level
        rows = pg.eval_on_selector_all("#pathList .path-row", "els => els.length")
        assert rows == 6, rows
        lvls = pg.eval_on_selector_all("#pathList .path-row .cefr", "els => els.map(e => e.textContent)")
        assert lvls == ["A1", "A2", "B1", "B2", "C1", "C2"], lvls
        assert pg.is_visible("#pathContinue")
        print("  learning path rows PASS")

        # 4) nap vocab co level -> path hien so lieu + Study chuyen tab + loc
        pg.evaluate("""() => {
            vocab = [{id:'1',w:'beautiful',m:'pretty',ex:'',box:1,last:Date.now()},
                     {id:'2',w:'abandon',m:'leave',ex:'',box:3,last:Date.now()}];
            saveVocab(); renderVocab();
        }""")
        a1txt = pg.eval_on_selector("#pathList .path-row .path-meta", "el => el.textContent")
        assert "1 words" in a1txt and "0 mastered" in a1txt, a1txt
        pg.click('.path-go[data-lv="B1"]')
        assert "active" in pg.get_attribute("#tab-vocab", "class"), "Study phai chuyen sang tab vocab"
        sel = pg.text_content("#cefrFilters .fchip.sel")
        assert sel.strip() == "B1", f"filter phai la B1, duoc {sel!r}"
        print("  studyLevel flow PASS")

        # 5) Quizlet mode cards
        modes = pg.eval_on_selector_all(".mode-card", "els => els.map(e => e.dataset.go)")
        assert modes == ["tab-vocab", "tab-quiz", "tab-dict", "tab-shadow"], modes
        pg.click(".mode-card[data-go='tab-quiz']")
        assert "active" in pg.get_attribute("#tab-quiz", "class"), "mode card phai chuyen tab"
        print("  flashcard mode cards PASS")

        # 6) Cake pastel pills co data-lv
        pg.click("nav.tabs button[data-tab='tab-vocab']")
        lv = pg.eval_on_selector_all("#cefrFilters .fchip", "els => els.map(e => e.dataset.lv)")
        assert lv == ["ALL", "A1", "A2", "B1", "B2", "C1", "C2", "?"], lv
        print("  Cake filter pills PASS")

        # 7) ELSA score hero
        pg.click("nav.tabs button[data-tab='tab-shadow']")
        pg.evaluate("() => { curSent = {t:'hello world'}; gradeShadow('hello world'); }")
        num = pg.text_content(".score-hero .score-num")
        assert "100%" in num, num
        words = pg.eval_on_selector_all(".score-words .score-w", "els => els.length")
        assert words == 2, words
        assert pg.eval_on_selector_all(".score-words .score-w.ok", "els => els.length") == 2
        pg.evaluate("() => { gradeShadow('hello'); }")
        assert pg.eval_on_selector_all(".score-words .score-w.bad", "els => els.length") >= 1
        print("  ELSA score hero PASS")

        # 8) flashcard Quizlet style: tap de flip
        pg.click("nav.tabs button[data-tab='tab-vocab']")
        pg.evaluate("() => { buildFcQueue(); }")
        pg.click("#flashcard")
        assert "flipped" in pg.get_attribute("#flashcard", "class"), "tap phai flip the"
        print("  flashcard flip PASS")

        assert not errs, f"page errors: {errs}"
        b.close()
    srv.shutdown()
    print("ALL UI TESTS PASSED")

if __name__ == "__main__":
    main()
