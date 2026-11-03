/* Fan-out frame song H1 — ham thuan (khong import, khong I/O) de test
 * truc tiep bang Node lan bundle vao Worker (ESM thuan). Thiet ke doi
 * ung §2.2/§2.3 (Chot 16:20 29/10/2026): frame q/idx mang seq do DO
 * cap; Ably an theo cung seq. Gioi han: DO /ingest nhan toi da 60
 * frame/lan; moi lan publish toi da 180 frame q (vuot -> cat bot +
 * dem, du lieu day du van nam o R2, client nap lai bang reload 60s).
 * Frame _ib KHONG bao gio vao day — hStockPublish chi goi
 * buildFanoutFrames voi khoa chinh.
 */
export const FANOUT = {
  MAX_Q_PER_BATCH: 180,
  MAX_DO_PER_CALL: 60,
  MAX_IDX_ROWS: 30,
  // DO ingest timeout 10s (tang tu 2s, 03/11): DO bi evict/recreate
  // trong ngay thi lan ingest dau tien phai cold-start (thuc day DO +
  // xu ly 60 frame) — 2s khong du, fetch abort, DO khong nhan frame
  // nao, client noi DO xong chi thay im lang ("quiet") du refresher
  // van publish moi phut. Day la goc cua (c) seq-fallback 1..103 lap.
  // 10s du cho cold-start; khong retry (DO cap seq — retry co the
  // trung frame).
  DO_TIMEOUT_MS: 10000,
  ABLY_TIMEOUT_MS: 5000,
};

function numOrUndef(v) {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/* Mốc đồng hồ thị trường (epoch ms) cho frame — §8 muc 7 (P1-2). Lay tu
 * publish body: _prov.retrieved_at (VM ghi khi fetch), roi neu co den
 * `time` ngay phien cua dong chi so dau tien. KHONG dung dong ho server
 * luc fan-out — do la `srv_ts`, tam` riêng ben DO. Khong derived ->
 * undefined (frame khong mang ts; DO se tu dung Date.now() lam fallback
 * va dat dau tsFallback de client phat hien ts khong phai cua phien).
 */
export function deriveMarketTs(body) {
  if (!body || typeof body !== "object") return undefined;
  const p = body._prov && body._prov.retrieved_at;
  if (p) { const t = Date.parse(String(p)); if (Number.isFinite(t)) return t; }
  const lists = [body.indices, body.sector_indices];
  for (const rows of lists) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (r && r.time != null) { const t = Date.parse(String(r.time)); if (Number.isFinite(t)) return t; }
    }
  }
  return undefined;
}

/* Dung body publish (khoa chinh) -> {q:[frame], idx:frame|null, truncated}.
 * Frame q: {t:"q", s, p?, c?, pc?, v?, tv?, fb?, fs?, fn?} — chi field
 * co so moi co mat (client delta dung cai nao co). Frame idx:
 * {t:"idx", rows:[{s, p?, pc?}]} tu body.indices + body.sector_indices.
 * Entry khong co field so nao (chi t+s) -> bo.
 */
export function buildFanoutFrames(body) {
  const q = [];
  let truncated = 0;
  const patch = body && (body.quotes_patch || body.quotes);
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    for (const key of Object.keys(patch)) {
      const e = patch[key];
      if (!e || typeof e !== "object") continue;
      const s = String(e.symbol || key || "").toUpperCase();
      if (!s) continue;
      const f = { t: "q", s: s };
      const p = numOrUndef(e.close); if (p !== undefined) f.p = p;
      const c = numOrUndef(e.change); if (c !== undefined) f.c = c;
      const pc = numOrUndef(e.pct_change); if (pc !== undefined) f.pc = pc;
      const v = numOrUndef(e.volume); if (v !== undefined) f.v = v;
      const tv = numOrUndef(e.value_vnd !== undefined ? e.value_vnd : (e.total_value !== undefined ? e.total_value : e.value));
      if (tv !== undefined) f.tv = tv;
      const fb = numOrUndef(e.foreign_buy_value); if (fb !== undefined) f.fb = fb;
      const fs = numOrUndef(e.foreign_sell_value); if (fs !== undefined) f.fs = fs;
      const fn = numOrUndef(e.foreign_net_value);
      if (fn !== undefined) f.fn = fn;
      else if (fb !== undefined && fs !== undefined) f.fn = fb - fs;
      if (Object.keys(f).length <= 2) continue;
      q.push(f);
    }
  }
  if (q.length > FANOUT.MAX_Q_PER_BATCH) {
    truncated = q.length - FANOUT.MAX_Q_PER_BATCH;
    q.length = FANOUT.MAX_Q_PER_BATCH;
  }
  const rows = [];
  for (const src of [body && body.indices, body && body.sector_indices]) {
    if (!Array.isArray(src)) continue;
    for (const r of src) {
      if (!r || typeof r !== "object") continue;
      const s = String(r.symbol || r.code || "").toUpperCase();
      if (!s) continue;
      const row = { s: s };
      const p = numOrUndef(r.close); if (p !== undefined) row.p = p;
      const pc = numOrUndef(r.pct_change); if (pc !== undefined) row.pc = pc;
      if (Object.keys(row).length <= 1) continue;
      rows.push(row);
      if (rows.length >= FANOUT.MAX_IDX_ROWS) break;
    }
    if (rows.length >= FANOUT.MAX_IDX_ROWS) break;
  }
  const idxFrame = rows.length ? { t: "idx", rows: rows } : null;
  // Gan dong ho thi truong (ts) vao moi frame — §8 muc 7 (P1-2). Frame
  // phat lai tu ring buffer giu ts goc (khong bi dong ho replay de).
  const ts = deriveMarketTs(body);
  if (ts !== undefined) {
    for (const f of q) f.ts = ts;
    if (idxFrame) idxFrame.ts = ts;
  }
  return { q: q, idx: idxFrame, truncated: truncated };
}

export function chunkFrames(frames, size) {
  const out = [];
  for (let i = 0; i < frames.length; i += size) out.push(frames.slice(i, i + size));
  return out;
}

/* Gan seq cho 1 chunk frame theo D-seq (§2.3):
 * (1) DO tra seqs[] khop so luong + toan so nguyen >0 -> dung.
 * (2) DO chi tra seq cuoi + published == so frame -> suy nguoc.
 * (3) Con lai -> seq du phong tu lastKnownSeq, danh dau seqFallback.
 * Tra {frames, viaDo, fallback, lastSeq}.
 */
export function assignFrameSeqs(frames, doRes, lastKnownSeq) {
  const n = frames.length;
  if (doRes && Array.isArray(doRes.seqs) && doRes.seqs.length === n &&
      doRes.seqs.every(function (s) { return Number.isInteger(s) && s > 0; })) {
    return {
      frames: frames.map(function (f, i) { const c = Object.assign({}, f); c.seq = doRes.seqs[i]; return c; }),
      viaDo: true, fallback: false, lastSeq: doRes.seqs[n - 1],
    };
  }
  const last = doRes ? numOrUndef(doRes.seq) : undefined;
  if (doRes && Number.isInteger(doRes.published) && doRes.published === n &&
      Number.isInteger(last) && last >= n) {
    const base = last - n;
    return {
      frames: frames.map(function (f, i) { const c = Object.assign({}, f); c.seq = base + 1 + i; return c; }),
      viaDo: true, fallback: false, lastSeq: last,
    };
  }
  const base = Number.isInteger(lastKnownSeq) ? lastKnownSeq : 0;
  return {
    frames: frames.map(function (f, i) { const c = Object.assign({}, f); c.seq = base + 1 + i; c.seqFallback = true; return c; }),
    viaDo: false, fallback: true, lastSeq: base + n,
  };
}
