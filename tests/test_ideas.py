#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test 7 sang kien moi + import/export.
1. auto example sentence khi add tu tu chips
2. select-all chips
3. quiz: start -> tra loi dung/sai -> done + score
4. streak: recordStudy -> streakDays + statusbar
5. due badge + due line
6. export CSV / Anki (download)
7. import CSV + TSV
8. shadowing score: fallback khi khong co Web Speech API + gradeShadow truc tiep
Chay: python tests/test_ideas.py
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
        page.evaluate("safeSpeak = async ()=>{}")  # stub TTS

        # 1) auto example sentence
        page.click("nav.tabs button[data-tab='tab-scan']")
        page.evaluate("vocab=[]; saveVocab(); renderVocab(); buildFcQueue();")
        page.evaluate("setStagedText('Learning English takes time. Do you abandon old habits every day?', 'test')")
        page.click("#ocrWordsBtn"); page.wait_for_timeout(300)
        page.evaluate("chipSel.add('abandon'); chipSel.add('habits'); updAddWordsBtn();")
        page.click("#ocrAddWords"); page.wait_for_timeout(200)
        ex = page.evaluate("vocab.find(v=>v.w==='abandon').ex")
        assert "abandon old habits" in ex, ex
        ex2 = page.evaluate("vocab.find(v=>v.w==='habits').ex")
        assert "abandon old habits" in ex2, ex2
        print("  auto example sentence: PASS")

        # 2) select all chips
        page.evaluate("setStagedText('alpha beta gamma delta', 'test')")
        page.click("#ocrWordsBtn"); page.wait_for_timeout(300)
        assert page.is_visible("#ocrSelectAll")
        page.click("#ocrSelectAll")
        assert page.evaluate("chipSel.size") == 4
        assert "Add 4 selected words" in page.text_content("#ocrAddWords")
        page.click("#ocrAddWords"); page.wait_for_timeout(200)
        assert page.evaluate("vocab.some(v=>v.w==='alpha')")
        print("  select-all chips: PASS")

        # 3) quiz
        page.evaluate("""vocab=[
          {id:1,w:'abandon',m:'give up',ex:'',box:1,last:0},
          {id:2,w:'invoice',m:'a bill',ex:'',box:1,last:0},
          {id:3,w:'deadline',m:'due date',ex:'',box:1,last:0},
          {id:4,w:'brave',m:'not afraid',ex:'',box:1,last:0}];
          saveVocab(); renderVocab(); buildFcQueue();""")
        page.click("nav.tabs button[data-tab='tab-quiz']")
        page.click("#qStart"); page.wait_for_timeout(300)
        assert page.is_visible("#qArea")
        nq = page.evaluate("qList.length")
        assert nq == 4, nq
        for i in range(nq):
            correct_idx = page.evaluate(
                "[...document.querySelectorAll('#qOpts .qopt')].findIndex(b=>b.textContent===qTarget.m)")
            if i == 1:  # tra loi sai 1 cau
                wrong_idx = page.evaluate(
                    "[...document.querySelectorAll('#qOpts .qopt')].findIndex(b=>b.textContent!==qTarget.m)")
                page.click(f"#qOpts .qopt >> nth={wrong_idx}")
                assert "Wrong" in page.text_content("#qFeedback")
            else:
                page.click(f"#qOpts .qopt >> nth={correct_idx}")
                assert "Correct" in page.text_content("#qFeedback")
            page.click("#qNext"); page.wait_for_timeout(200)
        assert page.is_visible("#qDone")
        assert "3/4" in page.text_content("#qDone"), page.text_content("#qDone")
        print("  quiz (dung/sai/score): PASS")

        # 4) streak
        page.evaluate("localStorage.removeItem('englab_study')")
        page.evaluate("recordStudy()")
        assert page.evaluate("streakDays()") == 1
        assert "1d" in page.text_content("#stStreak")
        page.evaluate("""const k='englab_study', d={};
          const f=dt=>dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
          const y=new Date(); y.setDate(y.getDate()-1); const z=new Date(); z.setDate(z.getDate()-2);
          d[f(new Date())]=2; d[f(y)]=1; d[f(z)]=3;
          localStorage.setItem(k, JSON.stringify(d)); renderStreak();""")
        assert page.evaluate("streakDays()") == 3
        assert "3d" in page.text_content("#stStreak")
        print("  streak: PASS")

        # 5) due badge
        page.click("nav.tabs button[data-tab='tab-vocab']")
        page.evaluate("vocab=[{id:1,w:'abandon',m:'x',ex:'',box:1,last:0}]; saveVocab(); renderVocab();")
        assert page.is_visible("#dueBadge")
        assert "due" in page.text_content("#dueBadge")
        assert "due for review" in page.text_content("#dueLine")
        page.evaluate("vocab[0].last=Date.now(); vocab[0].box=2; saveVocab(); renderVocab();")
        assert not page.is_visible("#dueBadge"), "da on thi khong due"
        print("  due badge: PASS")

        # 6) export CSV / Anki
        with page.expect_download() as dl1:
            page.click("#expCsv")
        c1 = open(dl1.value.path(), encoding="utf-8-sig").read()
        assert c1.startswith('"word","meaning","example"'), c1[:60]
        assert '"abandon"' in c1
        with page.expect_download() as dl2:
            page.click("#expAnki")
        c2 = open(dl2.value.path(), encoding="utf-8").read()
        assert "\t" in c2 and "abandon" in c2, c2[:60]
        print("  export CSV/Anki: PASS")

        # 7) import CSV + TSV
        with open("/tmp/imp_test.csv", "w") as f:
            f.write('word,meaning,example\nserendipity,happy luck,"It was pure serendipity."\nubiquitous,found everywhere,\n')
        page.set_input_files("#impFile", "/tmp/imp_test.csv")
        page.wait_for_timeout(400)
        assert page.evaluate("vocab.some(v=>v.w==='serendipity')")
        assert page.evaluate("vocab.find(v=>v.w==='serendipity').m") == "happy luck"
        assert page.evaluate("vocab.find(v=>v.w==='serendipity').ex") == "It was pure serendipity."
        n_before = page.evaluate("vocab.length")
        page.set_input_files("#impFile", "/tmp/imp_test.csv")  # import lai -> skip dupes
        page.wait_for_timeout(400)
        assert page.evaluate("vocab.length") == n_before, "dupe phai bi skip"
        with open("/tmp/imp_test.tsv", "w") as f:
            f.write("hello\tgreeting\n")
        page.set_input_files("#impFile", "/tmp/imp_test.tsv")
        page.wait_for_timeout(400)
        assert page.evaluate("vocab.some(v=>v.w==='hello' && v.m==='greeting')")
        print("  import CSV/TSV (+skip dupes): PASS")

        # 8) shadowing score
        page.click("nav.tabs button[data-tab='tab-shadow']")
        page.evaluate("window.SpeechRecognition=undefined; window.webkitSpeechRecognition=undefined;")
        page.click("#shScore")
        page.wait_for_timeout(300)
        assert "Web Speech API" in page.text_content("#shScoreOut")  # trinh duyet khong co API
        page.evaluate("curSent={id:1,t:'Hello world'}; gradeShadow('hello world')")
        assert "100%" in page.text_content("#shScoreOut")
        page.evaluate("gradeShadow('hello')")
        assert "50%" in page.text_content("#shScoreOut"), page.text_content("#shScoreOut")
        print("  shadowing score: PASS")

        browser.close()
    srv.shutdown()
    print("\nIDEAS TESTS PASSED")

if __name__ == "__main__":
    main()
