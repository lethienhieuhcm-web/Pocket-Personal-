"""Tests for the 8 upgrades: theme, backup, stats, playlist, word-of-day, cram, roleplay, mock test + PWA."""
import threading, json
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

def seed_vocab(pg, words):
    pg.evaluate("""(ws) => {
        vocab = ws.map((w,i)=>({id:'v'+i, w:w[0], m:w[1], ex:w[2]||'', box:1, last:0}));
        saveVocab(); renderVocab(); buildFcQueue();
    }""", words)

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

        # 8) dark mode
        assert "dark" not in (pg.get_attribute("body", "class") or "")
        pg.click("#themeBtn")
        assert "dark" in pg.get_attribute("body", "class")
        pg.reload(); pg.wait_for_function("document.querySelector('#pathList .path-row')", timeout=15000)
        assert "dark" in pg.get_attribute("body", "class"), "theme phai duoc luu"
        pg.click("#themeBtn")  # ve light cho cac test sau
        print("  dark mode PASS")

        # 5) stats: them tu -> logDay -> chart
        seed_vocab(pg, [["beautiful","pretty",""],["abandon","to leave",""],["persevere","persist",""],["reluctant","unwilling",""]])
        pg.click("nav.tabs button[data-tab='tab-path']")
        bars = pg.eval_on_selector_all("#statBars .stat-bar", "els => els.length")
        assert bars == 7, bars
        assert "words total" in pg.text_content("#statLine")
        print("  stats PASS")

        # 1) playlist: stub speak, check thu tu phat
        pg.evaluate("window.__spoken=[]; speak = async (t)=>{ window.__spoken.push(t); };")
        pg.click("nav.tabs button[data-tab='tab-vocab']")
        pg.click("#playAll")
        pg.wait_for_function("window.__spoken.length>=4", timeout=15000)
        pg.click("#playStop")
        spoken = [s for s in pg.evaluate("window.__spoken") if s]
        assert spoken[0] == "beautiful", spoken  # dung thu tu vocab
        assert "pretty" in spoken, spoken  # co ca nghia
        print("  playlist PASS")

        # 4) word of the day
        pg.click("nav.tabs button[data-tab='tab-path']")
        wod = pg.text_content("#wodBody .wod-word")
        assert len(wod.strip()) > 2, wod
        n0 = pg.evaluate("vocab.length")
        pg.click("#wodAdd")
        assert pg.evaluate("vocab.length") == n0 + 1
        print("  word of the day PASS")

        # 7) cram mode
        future = pg.evaluate("() => { const d=new Date(); d.setDate(d.getDate()+10); return d.toISOString().slice(0,10); }")
        pg.select_option("#cramLevel", "B1")
        pg.fill("#cramDate", future)
        pg.click("#cramSet")
        out = pg.text_content("#cramOut")
        assert "words/day" in out and "B1" in out, out
        print("  cram mode PASS")

        # 3) roleplay
        pg.evaluate("() => { sents=[{id:1,t:'Hello, how are you?'},{id:2,t:'I am fine, thanks.'}]; saveSents(); }")
        pg.click("nav.tabs button[data-tab='tab-shadow']")
        pg.click("#rpStart")
        pg.wait_for_selector("#rpArea .rp-turn")
        role = pg.text_content("#rpArea .rp-turn .rp-role")
        assert "App (A)" in role, role
        pg.click("#rpArea .rp-turn .rp-ctl button.btn.ghost")  # Next
        pg.wait_for_selector("#rpArea .rp-turn.me")
        assert pg.query_selector("#rpArea .rp-turn.me .btn.green"), "phai co nut Say it"
        print("  roleplay PASS")

        # 3b) roleplay fallback khi khong co SpeechRecognition
        pg.evaluate("() => { window.SpeechRecognition=undefined; window.webkitSpeechRecognition=undefined; }")
        pg.click("#rpStart")
        pg.wait_for_selector("#rpArea .rp-turn")
        pg.click("#rpArea .rp-turn .rp-ctl button.btn.ghost")
        pg.wait_for_selector("#rpArea .rp-turn.me")
        assert "Read it aloud" in pg.text_content("#rpArea .rp-turn.me")
        print("  roleplay fallback PASS")

        # 6) mock test: tra loi dung het 10 cau
        pg.evaluate("speak = async ()=>{};")
        pg.click("nav.tabs button[data-tab='tab-quiz']")
        pg.click("#mockStart")
        pg.wait_for_selector("#mockArea:not([style*='none'])")
        nq = pg.evaluate("mock.qs.length")
        for i in range(nq):
            typ = pg.evaluate("mock.qs[mock.i].type")
            if typ == "spell":
                w = pg.evaluate("mock.qs[mock.i].v.w")
                pg.fill("#mockInput", w)
            else:
                if typ == "listen":
                    ans = pg.evaluate("() => { const q=mock.qs[mock.i]; return q.v.m||'(no meaning)'; }")
                else:
                    ans = pg.evaluate("mock.qs[mock.i].v.w")
                pg.eval_on_selector_all("#mockOpts .qopt", f"els => {{ const t={json.dumps(ans)}; els.find(e=>e.textContent===t).click(); }}")
            pg.click("#mockNext")  # Check
            pg.click("#mockNext")  # Next / See result
        pg.wait_for_selector("#mockDone:not([style*='none'])", timeout=15000)
        done = pg.text_content("#mockDone")
        assert "100%" in done and f"{nq}/{nq}" in done, done
        print("  mock test PASS")

        # 2) backup export -> import
        pg.click("nav.tabs button[data-tab='tab-settings']")
        with pg.expect_download() as dl_info:
            pg.click("#backupExport")
        dl = dl_info.value
        path = dl.path()
        data = json.loads(open(path, encoding="utf-8").read())
        assert data["app"] == "english-lab" and len(data["vocab"]) >= 4, data.keys()
        assert "settings" in data and "apikey" not in json.dumps(data), "khong duoc export API key"
        pg.evaluate("() => { vocab=[]; saveVocab(); renderVocab(); }")
        assert pg.evaluate("vocab.length") == 0
        pg.on("dialog", lambda d: d.accept())
        pg.set_input_files("#backupFile", path)
        pg.wait_for_function("vocab.length>=4", timeout=15000)
        print("  backup export/import PASS")

        # PWA cross-platform
        assert pg.get_attribute('meta[name="apple-mobile-web-app-capable"]', "content") == "yes"
        assert pg.query_selector('link[rel="apple-touch-icon"]')
        man = pg.evaluate("fetch('manifest.json').then(r=>r.json())")
        icons = [i["src"] for i in man["icons"]]
        assert "icon-512.png" in icons and "icon-180.png" in icons, icons
        r = pg.evaluate("fetch('icon-512.png').then(r=>r.status)")
        assert r == 200
        print("  PWA assets PASS")

        assert not errs, f"page errors: {errs}"
        b.close()
    srv.shutdown()
    print("ALL UPGRADE TESTS PASSED")

if __name__ == "__main__":
    main()
