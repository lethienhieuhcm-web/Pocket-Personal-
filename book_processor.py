#!/usr/bin/env python3
"""
Book processor for English Lab — full implementation.
Watches R2 for pending PDF uploads, extracts text with pdfplumber,
detects chapters, classifies CEFR, uploads structured JSON.
Auto-merges vocabulary into shared corpus (per owner: no opt-in).
Run via cron every 5 minutes.
"""
import json, re, sys, os, tempfile
from datetime import datetime

# Prefer the bundled copy next to this script (survives VM replacements and
# system skill-path moves); fall back to the live system skill path if present.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if os.path.isdir("/opt/muse/skills/custom-connector-setup/bin"):
    sys.path.insert(1, "/opt/muse/skills/custom-connector-setup/bin")
try:
    from dynamic_credentials import add_surrogate_to_request
except ModuleNotFoundError:
    sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
    from dynamic_credentials import add_surrogate_to_request

import urllib.request

API = "https://api.cloudflare.com/client/v4"
ACCOUNT = "25b2327e932d26e5487c2ba8ad058932"
BUCKET = "english-lab-data"
ALLOWED = ["api.cloudflare.com"]

def api_req(method, path, data=None, raw=False):
    url = API + path
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    if not raw:
        req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token", allowed_hosts=ALLOWED)
    with urllib.request.urlopen(req, timeout=120) as resp:
        if raw:
            return resp.read()
        return json.loads(resp.read().decode())

def r2_download(key):
    """Download binary from R2."""
    return api_req("GET", f"/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}", raw=True)

def r2_list(prefix):
    out = api_req("GET", f"/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects?prefix={prefix}")
    result = out.get("result", [])
    return result if isinstance(result, list) else result.get("objects", [])

def r2_delete(key):
    api_req("DELETE", f"/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}")

def r2_put(key, obj):
    """Upload a JSON object to R2 (raw PUT, no multipart needed for small JSON)."""
    data = json.dumps(obj).encode()
    req = urllib.request.Request(f"{API}/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{key}",
                                 data=data, method="PUT")
    req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token", allowed_hosts=ALLOWED)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status

def r2_put_json(key, obj):
    """Upload JSON via R2 API (uses multipart). Simplified: use worker endpoint."""
    # We'll use the worker's internal API via a direct PUT
    # For now, use the S3-compatible API via cf_api
    import base64
    data = json.dumps(obj).encode()
    # Use R2 multipart via API - simplified approach: base64 in JSON
    # Actually, let's use the worker to write (it has binding)
    pass

def classify_cefr(sent):
    words = re.findall(r"[A-Za-z]+(?:'[a-z]+)?", sent)
    if not words: return "B1"
    avg_len = sum(len(w) for w in words) / len(words)
    n = len(words)
    has_sub = bool(re.search(r"\b(because|although|though|while|whereas|unless|until|since|if|when|that|which|who)\b", sent, re.I))
    long_ratio = sum(1 for w in words if len(w) >= 8) / len(words)
    s = min(n/4, 5) + min(max(0, avg_len-3.5)*2, 4) + long_ratio*6 + (2 if has_sub else 0)
    if s < 4: return "A1"
    if s < 7: return "A2"
    if s < 10: return "B1"
    if s < 13: return "B2"
    if s < 16: return "C1"
    return "C2"

def split_sentences(text):
    text = re.sub(r"\s+", " ", text).strip()
    sents = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])", text)
    return [s.strip() for s in sents if 20 < len(s.strip()) < 600]

def detect_chapters(text):
    pattern = re.compile(r"^(chapter|lesson|unit|b\u00e0i|ch\u01b0\u01a1ng)\s+(\d+|[IVXLC]+)[\s:.\-\u2013]*(.*)$", re.I | re.M)
    matches = list(pattern.finditer(text))
    if len(matches) >= 2:
        chapters = []
        for i, m in enumerate(matches):
            start = m.start()
            end = matches[i+1].start() if i+1 < len(matches) else len(text)
            title = m.group(0).strip()[:100]
            content = text[start:end].strip()
            if len(content) > 100:
                chapters.append({"title": title, "content": content})
        if chapters:
            return chapters
    # Fallback: chunk by 3000 chars
    chunks = [text[i:i+3000] for i in range(0, len(text), 3000)]
    return [{"title": f"Section {i+1}", "content": c} for i, c in enumerate(chunks) if len(c.strip()) > 100]

def extract_text_fast(pdf_bytes, max_pages=200):
    """Extract text page-by-page. PyMuPDF is ~10-30x faster than pdfplumber;
    fall back to pdfplumber if pymupdf is unavailable."""
    try:
        import pymupdf
        parts = []
        with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
            for page in doc[:max_pages]:
                parts.append(page.get_text() or "")
        return parts
    except ImportError:
        pass
    import pdfplumber
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
        tf.write(pdf_bytes)
        tf.flush()
        parts = []
        with pdfplumber.open(tf.name) as pdf:
            for page in pdf.pages[:max_pages]:
                parts.append(page.extract_text() or "")
        os.unlink(tf.name)
    return parts

def extract_epub(epub_bytes):
    """Extract text from EPUB using ebooklib."""
    import ebooklib
    from ebooklib import epub
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tf:
        tf.write(epub_bytes)
        tf.flush()
        book = epub.read_epub(tf.name)
        os.unlink(tf.name)
    parts = []
    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_DOCUMENT:
            # Strip HTML tags
            html = item.get_content().decode('utf-8', errors='ignore')
            text = re.sub(r'<[^>]+>', ' ', html)
            text = re.sub(r'\s+', ' ', text).strip()
            if text:
                parts.append(text)
    return parts

def extract_with_ocr_fallback(pdf_bytes, title):
    """Extract text; if too little (scanned PDF), try OCR via RapidOCR."""
    parts = extract_text_fast(pdf_bytes)
    full = "\n".join(parts).strip()
    # If less than 100 chars per page on average, likely scanned
    if len(full) < len(parts) * 100 and len(parts) > 0:
        print(f"  Low text ({len(full)} chars), trying OCR fallback...")
        try:
            from rapidocr_onnxruntime import RapidOCR
            import pymupdf
            ocr = RapidOCR()
            ocr_parts = []
            with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
                for i, page in enumerate(doc[:50]):  # limit to 50 pages for OCR
                    pix = page.get_pixmap(dpi=150)
                    img_bytes = pix.tobytes("png")
                    import io
                    from PIL import Image
                    img = Image.open(io.BytesIO(img_bytes))
                    import numpy as np
                    result, _ = ocr(np.array(img))
                    if result:
                        ocr_parts.append(" ".join([line[1] for line in result]))
                    if (i+1) % 10 == 0:
                        print(f"  OCR page {i+1}...")
            if ocr_parts:
                return ocr_parts
        except ImportError:
            print("  RapidOCR not available, skipping OCR fallback")
        except Exception as e:
            print(f"  OCR failed: {e}")
    return parts

def process_parts(text_parts, title):
    """Shared pipeline: text parts -> chapters + CEFR + word frequencies.

    Used by both PDF and EPUB processing (EPUB has no OCR stage).
    """
    full_text = "\n".join(text_parts)
    # Clean
    full_text = re.sub(r"\n{3,}", "\n\n", full_text)
    chapters = detect_chapters(full_text)
    result_chapters = []
    all_words = {}
    for ch in chapters:
        sents = split_sentences(ch["content"])
        if not sents:
            continue
        # CEFR for chapter = most common
        cefrs = [classify_cefr(s) for s in sents]
        from collections import Counter
        ch_cefr = Counter(cefrs).most_common(1)[0][0]
        result_chapters.append({
            "title": ch["title"],
            "cefr": ch_cefr,
            "sentences": sents[:200],  # limit per chapter
        })
        # Collect words for corpus
        for s in sents:
            for w in re.findall(r"[a-z]{2,30}", s.lower()):
                all_words[w] = all_words.get(w, 0) + 1
    return {
        "title": title,
        "chapters": result_chapters,
        "ts": int(datetime.now().timestamp() * 1000),
        "status": "done",
    }, all_words

def process_pdf(pdf_bytes, title):
    """PDF path: extract text with OCR fallback, then shared pipeline."""
    return process_parts(extract_with_ocr_fallback(pdf_bytes, title), title)

def process_epub(epub_bytes, title):
    """EPUB path: extract text from EPUB, then shared pipeline."""
    return process_parts(extract_epub(epub_bytes), title)

def main():
    print(f"[{datetime.now()}] Book processor starting", flush=True)
    # Load processor secret
    try:
        secret = open(os.path.expanduser("~/workspace/english-lab/.processor_secret")).read().strip()
    except:
        print("No processor secret found", flush=True)
        return
    try:
        jobs = r2_list("jobs/")
        print(f"Found {len(jobs)} job(s)", flush=True)
        for job_obj in jobs:
            key = job_obj.get("key", "")
            if not key.endswith(".json"):
                continue
            try:
                job_data = r2_download(key)
                job = json.loads(job_data.decode())
                if job.get("status") != "pending":
                    continue
                book_id = job["bookId"]
                user = job["user"]
                title = job.get("title", "Untitled")
                print(f"Processing {book_id} ({title}) for {user}", flush=True)
                
                # Try PDF first, then EPUB
                pdf_key = f"uploads/{user}/{book_id}.pdf"
                epub_key = f"uploads/{user}/{book_id}.epub"
                book_bytes = None
                is_epub = False
                try:
                    book_bytes = r2_download(pdf_key)
                except:
                    try:
                        book_bytes = r2_download(epub_key)
                        is_epub = True
                    except Exception as e:
                        print(f"  File not found: {e}", flush=True)
                        continue
                
                if is_epub:
                    book_json, words = process_epub(book_bytes, title)
                else:
                    book_json, words = process_pdf(book_bytes, title)
                n_sents = sum(len(c['sentences']) for c in book_json['chapters'])
                print(f"  -> {len(book_json['chapters'])} chapters, {n_sents} sentences", flush=True)
                total_chars = sum(len(s) for c in book_json['chapters'] for s in c['sentences'])
                if n_sents < 3 or total_chars < 500:
                    # Scanned-image PDF: no extractable text. Don't upload an
                    # empty "done" book; mark the job failed so the user sees it.
                    r2_put(key, {"bookId": book_id, "user": user, "title": title,
                                 "status": "failed", "reason": "scanned PDF, no extractable text",
                                 "ts": int(datetime.now().timestamp() * 1000)})
                    try:
                        r2_delete(epub_key if is_epub else pdf_key)
                    except: pass
                    print(f"  Job {book_id}: marked failed (scanned PDF, {n_sents} sentences)", flush=True)
                    continue
                
                # Post to worker
                req = urllib.request.Request(
                    "https://lethanhdong.one/api/books/result",
                    data=json.dumps({"bookId": book_id, "user": user, "book": book_json, "words": words}).encode(),
                    method="POST",
                    headers={"Content-Type": "application/json", "X-Processor-Secret": secret,
                             # lethanhdong.one 403s Python-urllib UA (CF error 1010)
                             "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
                )
                with urllib.request.urlopen(req, timeout=60) as resp:
                    print(f"  Uploaded: {resp.status}", flush=True)
                
                # Cleanup original file (keep only extracted JSON text)
                try:
                    r2_delete(epub_key if is_epub else pdf_key)
                except: pass
                
            except Exception as e:
                print(f"  Error {key}: {e}", flush=True)
                import traceback; traceback.print_exc()
    except Exception as e:
        print(f"Fatal: {e}", flush=True)
        import traceback; traceback.print_exc()
    print("Done", flush=True)

if __name__ == "__main__":
    main()
