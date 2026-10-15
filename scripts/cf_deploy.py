#!/usr/bin/env python3
"""Deploy English Lab static files to Cloudflare Worker via API.
Usage: cf_deploy.py
Uploads ~/workspace/english-lab files to worker fancy-wood-2b3c (lethanhdong.one).
"""
import base64
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error
import glob as _glob
from datetime import datetime, timezone

# Single source for VM + GitHub Actions (unified 2026-10-15).
# Credential helper: prefer bundled copy, fall back to system paths, tolerate
# absence (on CI, CF_API_TOKEN is used and the helper is never needed).
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
for _p in ("/opt/muse/skills/custom-connector-setup/bin",
           "/opt/hatch/skills/skill-creator/bin"):
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.append(_p)
try:
    from dynamic_credentials import add_surrogate_to_request, read_json_response
    _HAS_HATCH = True
except ImportError:
    _HAS_HATCH = False
    def read_json_response(resp):
        return json.loads(resp.read().decode())

API = "https://api.cloudflare.com/client/v4"
ACCOUNT = "25b2327e932d26e5487c2ba8ad058932"
WORKER = "fancy-wood-2b3c"
def _detect_src():
    """Find the english-lab checkout: CF_DEPLOY_SRC (CI) -> scripts/.. (repo)
    -> /home/hatch/workspace/english-lab (VM)."""
    cands = []
    env = os.environ.get("CF_DEPLOY_SRC")
    if env:
        cands.append(env)
    cands.append(os.path.dirname(_SCRIPT_DIR))  # repo root when run as scripts/cf_deploy.py
    cands.append("/home/hatch/workspace/english-lab")
    for c in cands:
        if c and os.path.isdir(os.path.join(c, "worker")):
            return c
    return "/home/hatch/workspace/english-lab"


SRC = _detect_src()
# URL prefix for English Lab (moved from / to /english/ for Hub)
URL_PREFIX = "/english"
FILES = [
    "index.html", "manifest.json", "sw.js", "icon.svg",
    "design-system.css", "_headers", "asset-manifest.json",
    "stocks-manifest.json", "stocks-sw.js",
    "voice-manifest.json", "voice-sw.js",
    "chess-manifest.json", "chess-sw.js",
    "music-manifest.json", "music-sw.js",
    "browser-manifest.json", "browser-sw.js",
    "talk-manifest.json", "talk-sw.js",
    "hub-manifest.json", "hub-sw.js",
    "privacy.html", "terms.html", "policy.html", "admin.html",
    "dac.html",
    # 2.5: dac-player-debug.apk vượt 25 MiB giới hạn Workers Assets →
    # serve từ R2 DATA (route /dac-player-debug.apk trong worker).
    ".well-known/assetlinks.json",
]
# Per-app PWA icons
FILES += sorted(_glob.glob("icons/*.png", root_dir=SRC, recursive=True))
# ES module files (Phase 4 refactor) added below
FILES += sorted(_glob.glob("js/**/*.js", root_dir=SRC, recursive=True))
ALLOWED = ["api.cloudflare.com"]


def _auth_request(req):
    """Cloudflare auth: CF_API_TOKEN env (GitHub Actions) or Hatch surrogate (VM)."""
    token = os.environ.get("CF_API_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    elif _HAS_HATCH:
        add_surrogate_to_request(
            req, "custom.cloudflare", entry_name="access_token", allowed_hosts=ALLOWED
        )
    else:
        raise RuntimeError("No Cloudflare credentials: set CF_API_TOKEN env var")


def cf_request(method, url, data=None, headers=None, timeout=60):
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    _auth_request(req)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return read_json_response(resp)


def content_hash(data: bytes) -> str:
    """Return first 8 hex chars of SHA-256, for content-hashed filenames."""
    return hashlib.sha256(data).hexdigest()[:8]


def hashed_filename(path: str, content_hash: str) -> str:
    """Convert 'js/foo.js' -> 'js/foo.a1b2c3d4.js' using content hash."""
    base, ext = os.path.splitext(path)
    return f"{base}.{content_hash}{ext}"


def build_asset_hash_map(src_dir: str, files: list) -> dict:
    """Build mapping from original asset path to content-hashed path.
    
    For JS/CSS files, computes hash of file content and returns mapping
    like {'js/foo.js': 'js/foo.a1b2c3d4.js'}. SW files are excluded
    (they use __BUILD__ timestamp instead for reliable updates).
    
    For JS files with imports, the hash includes the hashed dependency names
    (cascade), ensuring that when a dependency changes, dependents also get
    new filenames. This is done via iterative refinement.
    """
    # First pass: hash original content
    hash_map = {}
    file_contents = {}
    for f in files:
        if not f.endswith(('.js', '.css')):
            continue
        if f.endswith('sw.js'):
            continue
        p = os.path.join(src_dir, f)
        if not os.path.exists(p):
            continue
        data = open(p, "rb").read()
        file_contents[f] = data
        h = content_hash(data)
        hash_map[f] = hashed_filename(f, h)
    
    # Iterative refinement for JS dependencies (cascade)
    # If A imports B, and B's hash changes, A's content (with updated import)
    # will hash differently, so A needs a new filename too.
    for _iteration in range(5):  # Max 5 iterations, should converge
        changed = False
        for f, data in file_contents.items():
            if not f.endswith('.js'):
                continue
            # Replace imports with current hashed names
            new_data = data
            # Find all relative imports (both ./ and ../)
            for m in re.finditer(rb"from\s+(['\"])(\.\.?/[^'\"?]+\.js)(['\"])", data):
                rel_path = m.group(2).decode()
                cur_dir = os.path.dirname(f)
                abs_path = os.path.normpath(os.path.join(cur_dir, rel_path))
                if abs_path in hash_map:
                    hashed_abs = hash_map[abs_path]
                    hashed_rel = os.path.relpath(hashed_abs, cur_dir)
                    if rel_path.startswith('./') and not hashed_rel.startswith('.'):
                        hashed_rel = './' + hashed_rel
                    old_import = m.group(0)
                    new_import = b"from " + m.group(1) + hashed_rel.encode() + m.group(3)
                    new_data = new_data.replace(old_import, new_import)
            # Compute new hash
            new_h = content_hash(new_data)
            new_hashed = hashed_filename(f, new_h)
            if new_hashed != hash_map[f]:
                hash_map[f] = new_hashed
                # 8b fix 2026-10-11: cập nhật file_contents để iteration sau
                # xây dựng trên data đã xử lý, không phải data gốc.
                # Bug cũ: không update → mỗi iteration đều bắt đầu từ gốc,
                # hash sai lan truyền qua các file phụ thuộc (cascade failure).
                file_contents[f] = new_data
                changed = True
        if not changed:
            break
    return hash_map


def apply_hashed_assets_to_html(data: bytes, asset_hash_map: dict, build_id: str) -> bytes:
    """Replace JS/CSS references in HTML with content-hashed filenames.
    
    Replaces ?v= cache busting with big-tech style filename hashing.
    e.g. src="js/foo.js?v=123" -> src="js/foo.a1b2c3d4.js"
    """
    # Replace __BUILD__ with build ID for stale-HTML self-reload
    data = data.replace(b"__BUILD__", build_id.encode())
    # Replace asset references with hashed versions
    for orig, hashed in asset_hash_map.items():
        orig_basename = os.path.basename(orig)
        hashed_basename = os.path.basename(hashed)
        if orig.endswith('.js'):
            # src=".../foo.js" -> src=".../foo.HASH.js"
            data = re.sub(
                rb'src="([^"]*/)?' + orig_basename.encode() + rb'(\?v=\d+)?"',
                lambda m: b'src="' + (m.group(1) or b'') + hashed_basename.encode() + b'"',
                data
            )
            # ES module imports: from '.../foo.js' -> from '.../foo.HASH.js'
            # Use simple string replace for absolute paths
            data = data.replace(orig.encode(), hashed.encode())
        elif orig.endswith('.css'):
            data = re.sub(
                rb'href="([^"]*/)?' + orig_basename.encode() + rb'(\?v=\d+)?"',
                lambda m: b'href="' + (m.group(1) or b'') + hashed_basename.encode() + b'"',
                data
            )
    # Remove any remaining ?v= query strings (legacy cleanup)
    data = re.sub(rb"\?v=\d+", b"", data)
    return data


def main():
    # 1. Build manifest (hash = first 32 hex chars of SHA-256)
    # sw.js gets a fresh build ID on every deploy so the SW cache is busted
    # and the browser picks up the new UI immediately.
    build_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    # Write _headers with current build ID so the auto-reload script in HTML
    # can detect stale versions via the x-build-id header.
    _headers_content = f"""/*.html
  Cache-Control: no-store
  X-Build-Id: {build_id}
/stocks/
  Cache-Control: no-store
  X-Build-Id: {build_id}
/stocks
  Cache-Control: no-store
  X-Build-Id: {build_id}
/english/
  Cache-Control: no-store
  X-Build-Id: {build_id}
/voice/
  Cache-Control: no-store
  X-Build-Id: {build_id}
/chess/
  Cache-Control: no-store
  X-Build-Id: {build_id}
/music/
  Cache-Control: no-store
  X-Build-Id: {build_id}
/hub
  Cache-Control: no-store
  X-Build-Id: {build_id}
/
  Cache-Control: no-store
  X-Build-Id: {build_id}
"""
    with open(os.path.join(SRC, "_headers"), "w") as _hf:
        _hf.write(_headers_content)
    manifest = {}
    contents = {}
    # Build content-hash map for JS/CSS files (big-tech style filename hashing)
    # e.g. 'js/foo.js' -> 'js/foo.a1b2c3d4.js'. SW files excluded (use __BUILD__).
    asset_hash_map = build_asset_hash_map(SRC, FILES)
    print(f"Hashed {len(asset_hash_map)} JS/CSS assets for content-based cache busting")
    # Generate asset-manifest.json for debugging (big-tech practice)
    # Maps original filenames to hashed versions
    asset_manifest = {
        "build_id": build_id,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "assets": asset_hash_map,
    }
    with open(os.path.join(SRC, "asset-manifest.json"), "w") as _amf:
        json.dump(asset_manifest, _amf, indent=2)
    print(f"Generated asset-manifest.json with {len(asset_hash_map)} mappings")
    for f in FILES:
        p = os.path.join(SRC, f)
        data = open(p, "rb").read()
        # Determine the deployed filename (hashed for JS/CSS, original for others)
        deploy_name = f
        if f.endswith("sw.js"):
            data = data.replace(b"__BUILD__", build_id.encode())
        elif f in asset_hash_map:
            # Content-hashed asset: process imports/references to use hashed names,
            # then deploy under the hashed filename.
            deploy_name = asset_hash_map[f]
            if f.endswith(".js"):
                # Replace relative JS imports with hashed filenames
                # e.g. from './dom.js' -> from './dom.a1b2c3d4.js'
                def _replace_js_import(m):
                    quote = m.group(1)
                    rel_path = m.group(2).decode()
                    # Resolve relative to current file's directory
                    cur_dir = os.path.dirname(f)
                    abs_path = os.path.normpath(os.path.join(cur_dir, rel_path))
                    if abs_path in asset_hash_map:
                        hashed_abs = asset_hash_map[abs_path]
                        # Convert back to relative, preserving ./ prefix
                        hashed_rel = os.path.relpath(hashed_abs, cur_dir)
                        if rel_path.startswith('./') and not hashed_rel.startswith('.'):
                            hashed_rel = './' + hashed_rel
                        return b"from " + quote + hashed_rel.encode() + quote
                    return m.group(0)
                data = re.sub(rb"from\s+(['\"])(\.\.?/[^'\"?]+\.js)(['\"])", _replace_js_import, data)
                # Dynamic imports: import('../features/books.js')
                def _replace_dyn_import(m):
                    quote = m.group(1)
                    rel_path = m.group(2).decode()
                    cur_dir = os.path.dirname(f)
                    abs_path = os.path.normpath(os.path.join(cur_dir, rel_path))
                    if abs_path in asset_hash_map:
                        hashed_abs = asset_hash_map[abs_path]
                        hashed_rel = os.path.relpath(hashed_abs, cur_dir)
                        # Preserve ../ prefix (relpath already handles it)
                        return b"import(" + quote + hashed_rel.encode() + quote + b")"
                    return m.group(0)
                data = re.sub(rb"import\((['\"])(\.\./[^'\"?]+\.js)(['\"])\)", _replace_dyn_import, data)
        # HTML: replace asset references with content-hashed filenames
        # (big-tech style, replaces ?v= query string cache busting)
        if f.endswith(".html"):
            # Replace __BUILD__ with build ID for stale-HTML self-reload
            data = data.replace(b"__BUILD__", build_id.encode())
            # Replace JS src references: src="js/foo.js" or src="/english/js/foo.js"
            # with hashed versions from asset_hash_map
            for orig, hashed in asset_hash_map.items():
                if orig.endswith('.js'):
                    # Match src="...js/foo.js" with optional ?v=
                    # Handle both relative (js/foo.js) and absolute (/english/js/foo.js)
                    orig_basename = os.path.basename(orig)
                    hashed_basename = os.path.basename(hashed)
                    # Replace in src attributes
                    data = re.sub(
                        rb'src="([^"]*/)?' + orig_basename.encode() + rb'(\?v=\d+)?"',
                        lambda m: b'src="' + (m.group(1) or b'') + hashed_basename.encode() + b'"',
                        data
                    )
                    # Replace in ES module imports: from '/english/js/foo.js'
                    # and from './foo.js' (relative, handled above for JS files,
                    # but HTML also has absolute imports)
                    data = data.replace(
                        orig.encode(),
                        hashed.encode()
                    )
                elif orig.endswith('.css'):
                    orig_basename = os.path.basename(orig)
                    hashed_basename = os.path.basename(hashed)
                    data = re.sub(
                        rb'href="([^"]*/)?' + orig_basename.encode() + rb'(\?v=\d+)?"',
                        lambda m: b'href="' + (m.group(1) or b'') + hashed_basename.encode() + b'"',
                        data
                    )
            # Remove any remaining ?v= query strings (legacy)
            data = re.sub(rb"\?v=\d+", b"", data)
        h = hashlib.sha256(data).hexdigest()[:32]
        manifest[URL_PREFIX + "/" + deploy_name] = {"hash": h, "size": len(data)}
        contents[h] = (deploy_name, data)
    # Stock App (standalone, R2-backed) at /stocks/
    stocks_html = os.path.join(SRC, "stocks.html")
    if os.path.exists(stocks_html):
        sdata = open(stocks_html, "rb").read()
        sdata = apply_hashed_assets_to_html(sdata, asset_hash_map, build_id)
        sh = hashlib.sha256(sdata).hexdigest()[:32]
        manifest["/stocks/"] = {"hash": sh, "size": len(sdata)}
        manifest["/stocks/index.html"] = {"hash": sh, "size": len(sdata)}
        contents[sh] = ("stocks.html", sdata)
        print(f"stocks: standalone app at /stocks/")
    # Chess + Music: standalone apps served from repo HTML (single source of truth)
    for _app, _file in (("chess", "chess.html"), ("music", "music.html")):
        _p = os.path.join(SRC, _file)
        if os.path.exists(_p):
            _d = open(_p, "rb").read()
            _d = apply_hashed_assets_to_html(_d, asset_hash_map, build_id)
            _h = hashlib.sha256(_d).hexdigest()[:32]
            manifest[f"/{_app}/"] = {"hash": _h, "size": len(_d)}
            manifest[f"/{_app}/index.html"] = {"hash": _h, "size": len(_d)}
            contents[_h] = (_file, _d)
            print(f"{_app}: standalone app at /{_app}/")
    # Pocket Personal: / -> public landing page, /login -> login page, /hub.html -> app hub (post-login)
    landing_path = os.path.join(SRC, "landing.html")
    if os.path.exists(landing_path):
        landing_data = open(landing_path, "rb").read()
        landing_data = apply_hashed_assets_to_html(landing_data, asset_hash_map, build_id)
        landing_h = hashlib.sha256(landing_data).hexdigest()[:32]
        manifest["/index.html"] = {"hash": landing_h, "size": len(landing_data)}
        manifest["/"] = {"hash": landing_h, "size": len(landing_data)}
        contents[landing_h] = ("landing.html", landing_data)
        print(f"landing: /index.html + / ({len(landing_data)} bytes)")
    login_path = os.path.join(SRC, "hub-login.html")
    if os.path.exists(login_path):
        login_data = open(login_path, "rb").read()
        login_data = apply_hashed_assets_to_html(login_data, asset_hash_map, build_id)
        login_h = hashlib.sha256(login_data).hexdigest()[:32]
        manifest["/login.html"] = {"hash": login_h, "size": len(login_data)}
        manifest["/login"] = {"hash": login_h, "size": len(login_data)}
        contents[login_h] = ("hub-login.html", login_data)
        print(f"login: /login.html + /login ({len(login_data)} bytes)")
    hub_path = os.path.join(SRC, "hub.html")
    if os.path.exists(hub_path):
        hub_data = open(hub_path, "rb").read()
        hub_data = apply_hashed_assets_to_html(hub_data, asset_hash_map, build_id)
        hub_h = hashlib.sha256(hub_data).hexdigest()[:32]
        manifest["/hub.html"] = {"hash": hub_h, "size": len(hub_data)}
        contents[hub_h] = ("hub.html", hub_data)
        print(f"hub: /hub.html ({len(hub_data)} bytes)")
    # Upgrade/billing page at /upgrade
    upgrade_path = os.path.join(SRC, "upgrade.html")
    if os.path.exists(upgrade_path):
        udata = open(upgrade_path, "rb").read()
        udata = apply_hashed_assets_to_html(udata, asset_hash_map, build_id)
        uh = hashlib.sha256(udata).hexdigest()[:32]
        manifest["/upgrade"] = {"hash": uh, "size": len(udata)}
        manifest["/upgrade/"] = {"hash": uh, "size": len(udata)}
        contents[uh] = ("upgrade.html", udata)
        print(f"upgrade: /upgrade ({len(udata)} bytes)")
    # Voice utility (Pocket Personal) at /voice/
    voice_html = os.path.join(SRC, "voice.html")
    if os.path.exists(voice_html):
        vdata = open(voice_html, "rb").read()
        vdata = apply_hashed_assets_to_html(vdata, asset_hash_map, build_id)
        vh = hashlib.sha256(vdata).hexdigest()[:32]
        manifest["/voice/"] = {"hash": vh, "size": len(vdata)}
        manifest["/voice/index.html"] = {"hash": vh, "size": len(vdata)}
        contents[vh] = ("voice.html", vdata)
        print(f"voice: standalone utility at /voice/")
    # Proxy browser (Pocket Personal) at /browser/
    browser_html = os.path.join(SRC, "browser.html")
    if os.path.exists(browser_html):
        bdata = open(browser_html, "rb").read()
        bdata = apply_hashed_assets_to_html(bdata, asset_hash_map, build_id)
        bh = hashlib.sha256(bdata).hexdigest()[:32]
        manifest["/browser/"] = {"hash": bh, "size": len(bdata)}
        manifest["/browser/index.html"] = {"hash": bh, "size": len(bdata)}
        contents[bh] = ("browser.html", bdata)
        print(f"browser: standalone app at /browser/")
    # AI chat Talk (Pocket Personal) at /talk/ — P1 2026-10-12
    talk_html = os.path.join(SRC, "talk.html")
    if os.path.exists(talk_html):
        tdata = open(talk_html, "rb").read()
        tdata = apply_hashed_assets_to_html(tdata, asset_hash_map, build_id)
        th = hashlib.sha256(tdata).hexdigest()[:32]
        manifest["/talk/"] = {"hash": th, "size": len(tdata)}
        manifest["/talk/index.html"] = {"hash": th, "size": len(tdata)}
        contents[th] = ("talk.html", tdata)
        print(f"talk: AI chat app at /talk/")
    print(f"manifest: {len(manifest)} files (build {build_id})")

    # 2. Create upload session
    r = cf_request(
        "POST",
        f"{API}/accounts/{ACCOUNT}/workers/scripts/{WORKER}/assets-upload-session",
        data=json.dumps({"manifest": manifest}).encode(),
        headers={"Content-Type": "application/json"},
    )
    if not r.get("success"):
        print("SESSION FAILED:", json.dumps(r)[:500])
        sys.exit(1)
    jwt = r["result"]["jwt"]
    buckets = r["result"]["buckets"]
    print(f"session ok, {sum(len(b) for b in buckets)} files to upload")

    # 3. Upload each bucket (multipart, base64, auth = session JWT)
    completion_jwt = jwt
    boundary = "----cfdeploy1234"
    for i, bucket in enumerate(buckets):
        parts = []
        for h in bucket:
            fname, data = contents[h]
            ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
            b64 = base64.b64encode(data).decode()
            parts.append(
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{h}"\r\n'
                f"Content-Type: {ctype}\r\n\r\n"
                f"{b64}\r\n"
            )
        parts.append(f"--{boundary}--\r\n")
        body = "".join(parts).encode()
        req = urllib.request.Request(
            f"{API}/accounts/{ACCOUNT}/workers/assets/upload?base64=true",
            data=body, method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        req.add_header("Authorization", f"Bearer {jwt}")
        # NOTE: asset upload uses the session JWT directly, not the API token
        with urllib.request.urlopen(req, timeout=120) as resp:
            up = read_json_response(resp)
        if up.get("result", {}).get("jwt"):
            completion_jwt = up["result"]["jwt"]
        print(f"bucket {i+1}/{len(buckets)} uploaded")

    # 4. Deploy worker with assets + secure TTS proxy
    # Worker source of truth: ~/workspace/english-lab/worker/src/*.js
    # MUST rebuild the bundle first — deploying a stale worker.js silently
    # ships old backend code (hit 2026-10-11: fixes sat in src/ for ~10h
    # while "DEPLOY OK" kept uploading the 14:46 bundle).
    # 8b: pass BUILD_ID so the bundle's X-Build-Id matches this deploy's
    # build_id (build.sh used its own timestamp -> verify_live_build never
    # matched -> false "DEPLOY FAILED" on every deploy).
    _build_env = dict(os.environ, BUILD_ID=build_id)
    _build = subprocess.run(
        ["bash", os.path.join(SRC, "worker", "build.sh"), build_id],
        capture_output=True, text=True, timeout=180, env=_build_env)
    if _build.returncode != 0:
        print("WORKER BUILD FAILED:\n" + (_build.stderr or _build.stdout)[-2000:])
        sys.exit(1)
    print(_build.stdout.strip().splitlines()[-1] if _build.stdout.strip() else "worker built")
    with open(os.path.join(SRC, "worker.js"), "rb") as _wf:
        worker_js = _wf.read()
    # Embed build ID for X-Build-Id header (stale HTML self-reload)
    worker_js = worker_js.replace(b"__BUILD__", build_id.encode())
    metadata = {
        "main_module": "worker.js",
        "assets": {"jwt": completion_jwt},
        "bindings": [
            {"type": "assets", "name": "ASSETS"},
            {"type": "r2_bucket", "name": "DATA", "bucket_name": "english-lab-data"},
            {"type": "r2_bucket", "name": "AUTHDB", "bucket_name": "english-lab-auth"},
            {"type": "r2_bucket", "name": "DACMUSIC", "bucket_name": "dac-music"},
            {"type": "d1", "name": "DB", "id": "e856db4d-1ee1-42fd-9c1d-1807ca31afb5"},
        ],
    }
    b2 = "----cfdeploy5678"
    body = (
        f"--{b2}\r\n"
        f'Content-Disposition: form-data; name="metadata"\r\n'
        f"Content-Type: application/json\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{b2}\r\n"
        f'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
        f"Content-Type: application/javascript+module\r\n\r\n"
    ).encode() + worker_js + f"\r\n--{b2}--\r\n".encode()

    req = urllib.request.Request(
        f"{API}/accounts/{ACCOUNT}/workers/scripts/{WORKER}",
        data=body, method="PUT")
    req.add_header("Content-Type", f"multipart/form-data; boundary={b2}")
    _auth_request(req)
    with urllib.request.urlopen(req, timeout=60) as resp:
        dep = read_json_response(resp)
    # 8b: log chi tiết response để debug silent failure (2026-10-11)
    _dep_result = dep.get("result", {})
    print(f"Worker deploy response: id={_dep_result.get('id', '?')[:20]}, "
          f"etag={_dep_result.get('etag', '?')[:20]}, "
          f"created_on={_dep_result.get('created_on', '?')}")
    if dep.get("success"):
        print("DEPLOY OK")
        # Purge Cloudflare edge cache so HTML/JS updates go live immediately
        # (Zone ID for lethanhdong.one; requires Cache Purge permission)
        try:
            purge_cache()
        except Exception as e:
            print(f"Cache purge failed (non-fatal): {e}")
        # 8b + big tech (K8s/Vercel): verify live worker version matches.
        # Never trust "API success" — poll until X-Build-Id matches or fail.
        if not verify_live_build(build_id):
            print("DEPLOY FAILED: live worker did not update to build " + build_id)
            sys.exit(1)
        print("LIVE VERIFIED: build " + build_id + " serving")
        # Rung 2 fix #5 (15/10/2026, thay branch protection — xem AGENTS.md):
        # branch protection chỉ chặn code ĐÃ push; họ lỗi #5 là drift chiều
        # VM->GitHub (sửa local, deploy, quên upload) mà rule không thấy được.
        # Check đúng chỗ: ngay sau deploy, khi local chính là production.
        try:
            check_worker_repo_drift()
        except Exception as e:
            print(f"Repo drift check skipped (non-fatal): {e}")
    else:
        print("DEPLOY FAILED:", json.dumps(dep)[:800])
        sys.exit(1)


def check_worker_repo_drift():
    """So worker/src + static assets local với GitHub main.

    Dùng 1 API call duy nhất (git trees, recursive) rồi so git blob SHA —
    nhanh (~vài giây), không tải từng file. Best-effort tuyệt đối: chỉ in
    cảnh báo, KHÔNG BAO GIỜ fail deploy. Lỗi mạng -> bỏ qua lặng lẽ.
    """
    import urllib.request
    tree_url = ("https://api.github.com/repos/lethienhieuhcm-web/"
                "Pocket-Personal-/git/trees/main?recursive=1")
    try:
        req = urllib.request.Request(tree_url)
        req.add_header("User-Agent",
                       "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36")
        with urllib.request.urlopen(req, timeout=15) as resp:
            tree = json.loads(resp.read().decode())
        remote = {t["path"]: t["sha"] for t in tree.get("tree", [])
                  if t.get("type") == "blob"}
    except Exception:
        return  # mạng/API lỗi -> bỏ qua lặng lẽ, không chặn deploy
    def _blob_sha(data: bytes) -> str:
        return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()

    def _check(rel, rpath):
        # binary-safe: so raw bytes, không decode content
        lp = os.path.join(SRC, rel)
        try:
            with open(lp, "rb") as f:
                data = f.read()
        except OSError:
            return None
        if rpath not in remote:
            return "missing"
        if remote[rpath] != _blob_sha(data):
            return "drifted"
        return None

    drifted, missing = [], []
    # 1. worker source
    for rel in sorted(_glob.glob("src/*.js", root_dir=SRC + "/worker")) + ["package.json"]:
        st = _check(os.path.join("worker", rel), "worker/" + rel.replace(os.sep, "/"))
        if st == "missing":
            missing.append("worker/" + rel)
        elif st == "drifted":
            drifted.append("worker/" + rel)
    # 2. static assets cf_deploy.py cần (2026-10-15: repo thiếu 27 file tĩnh
    # làm CI deploy 404 dù CI xanh — drift check phải cover cả mảng này).
    # Ngoại lệ: _headers và asset-manifest.json là build artifact (ghi lại mỗi
    # deploy với build_id mới) — không phải source, skip để khỏi báo drift giả.
    for rel in FILES:
        if rel in ("_headers", "asset-manifest.json"):
            continue
        st = _check(rel, rel.replace(os.sep, "/"))
        if st == "missing":
            missing.append(rel)
        elif st == "drifted":
            drifted.append(rel)
    for rel in ["browser.html", "talk.html"]:
        st = _check(rel, rel)
        if st == "missing":
            missing.append(rel + " (optional)")
        elif st == "drifted":
            drifted.append(rel)
    if missing or drifted:
        print("=" * 60)
        print("WARNING: file trên GitHub LỆCH khỏi bản vừa deploy!")
        for rel in missing:
            print(f"  thiếu trên repo: {rel}")
        for rel in drifted:
            print(f"  khác bản local: {rel}")
        print("Hãy upload các file trên lên GitHub (Add file > Upload files)")
        print("để repo khớp production, không thì CI/deploy sau sẽ lệch.")
        print("=" * 60)
    else:
        print("Repo drift check: khớp GitHub main (worker + static assets).")


def verify_live_build(build_id, timeout=60):
    """Poll live site until X-Build-Id matches build_id. Returns True/False.

    8b (2026-10-12): MUST use /policy, not /english/policy.html.
    /english/policy.html 307-redirects to /english/policy which is served
    straight from the asset bucket WITHOUT X-Build-Id, so the old URL
    never matched -> false "DEPLOY FAILED" on every deploy.
    /policy goes through the worker (serveAsset) which always stamps
    X-Build-Id on HTML responses.
    """
    import time
    import urllib.request
    url = "https://lethanhdong.one/policy"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, method="HEAD")
            # Cloudflare blocks Python-urllib's default UA with 403
            # (same trap as publish_snapshot) -> use a browser-like UA
            req.add_header("User-Agent",
                "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36")
            with urllib.request.urlopen(req, timeout=10) as resp:
                live_id = resp.headers.get("X-Build-Id", "")
                if live_id == build_id:
                    return True
        except Exception:
            pass
        time.sleep(5)
    return False


def purge_cache():
    """Purge Cloudflare edge cache for lethanhdong.one zone."""
    import urllib.request
    zone_id = "708957286dce46390cdf3e8e1299367a"
    url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache"
    data = json.dumps({"purge_everything": True}).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    _auth_request(req)
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = read_json_response(resp)
    if result.get("success"):
        print("Cache purged OK")
    else:
        print(f"Cache purge API error: {json.dumps(result)[:200]}")


if __name__ == "__main__":
    main()
