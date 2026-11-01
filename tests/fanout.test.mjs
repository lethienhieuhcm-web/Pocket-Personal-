// Test ham thuan fan-out H1 (worker/src/fanout.js) — khong mang, khong D1.
// Run: node tests/fanout.test.mjs
import { FANOUT, buildFanoutFrames, chunkFrames, assignFrameSeqs } from "../worker/src/fanout.js";

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
function eq(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

const full = { close: 22500, change: 100, pct_change: 0.45, volume: 1234567, value_vnd: 27700000000, foreign_buy_value: 5000000000, foreign_sell_value: 2000000000, reference: 22400 };

// 1. Entry day du -> frame day field, fn suy tu fb-fs khi thieu.
let r = buildFanoutFrames({ quotes_patch: { ACB: full } });
check("q day field + fn suy", r.q.length === 1 && r.q[0].s === "ACB" && r.q[0].p === 22500 && r.q[0].c === 100 && r.q[0].pc === 0.45 && r.q[0].v === 1234567 && r.q[0].tv === 27700000000 && r.q[0].fb === 5000000000 && r.q[0].fs === 2000000000 && r.q[0].fn === 3000000000, r.q[0]);
check("idx rong khi khong co indices", r.idx === null && r.truncated === 0);

// 2. fn hien co thang khi ca fn + fb/fs deu co.
r = buildFanoutFrames({ quotes_patch: { MWG: Object.assign({}, full, { foreign_net_value: 999 }) } });
check("fn hien thang", r.q[0].fn === 999, r.q[0]);

// 3. close:null -> bo field p, khong tao p=0; entry khong field so nao -> bo.
r = buildFanoutFrames({ quotes_patch: { A: { close: null, change: 50 }, B: { symbol: "B" }, C: { close: "abc" } } });
check("null/abc khong tao field gia", r.q.length === 1 && r.q[0].s === "A" && r.q[0].p === undefined && r.q[0].c === 50, r.q);

// 4. quotes (full map) dung khi khong co quotes_patch; patch uu tien hon quotes.
r = buildFanoutFrames({ quotes: { X: full } });
check("quotes fallback", r.q.length === 1 && r.q[0].s === "X");
r = buildFanoutFrames({ quotes_patch: { P: full }, quotes: { X: full } });
check("patch uu tien", r.q.length === 1 && r.q[0].s === "P");

// 5. _ib KHONG bao gio fan-out.
r = buildFanoutFrames({ quotes_patch_ib: { ACB: full }, indices_ib: [{ symbol: "VNINDEX", close: 1700, pct_change: 0.1 }] });
check("_ib bi loai", r.q.length === 0 && r.idx === null, r);

// 6. indices + sector_indices gop, cap 30.
const idxRows = Array.from({ length: 20 }, (_, i) => ({ symbol: "I" + i, close: 100 + i, pct_change: 0.1 }));
const secRows = Array.from({ length: 20 }, (_, i) => ({ symbol: "S" + i, close: 200 + i, pct_change: -0.2 }));
r = buildFanoutFrames({ indices: idxRows, sector_indices: secRows });
check("idx gop + cap 30", r.idx && r.idx.rows.length === 30 && r.idx.rows[0].s === "I0" && r.idx.rows[29].s === "S9", r.idx && r.idx.rows.length);
check("idx row dung field", r.idx.rows[0].p === 100 && r.idx.rows[0].pc === 0.1);

// 7. Cat bot 180 frame q.
const many = {};
for(let i = 0; i < 200; i++) many["C" + i] = full;
r = buildFanoutFrames({ quotes_patch: many });
check("cat 180", r.q.length === 180 && r.truncated === 20, { n: r.q.length, t: r.truncated });

// 8. chunkFrames.
check("chunk 130 -> 60/60/10", eq(chunkFrames(Array.from({ length: 130 }, (_, i) => i), 60).map(c => c.length), [60, 60, 10]));
check("chunk rong", chunkFrames([], 60).length === 0);

// 9. assignFrameSeqs — (1) seqs[] khop.
let a = assignFrameSeqs([{ t: "q" }, { t: "q" }], { seqs: [7, 8], seq: 8, published: 2 }, 5);
check("seqs[] khop", a.viaDo && !a.fallback && a.frames[0].seq === 7 && a.frames[1].seq === 8 && a.lastSeq === 8, a);
// (2) suy nguoc tu seq cuoi.
a = assignFrameSeqs([{ t: "q" }, { t: "q" }, { t: "q" }], { seq: 10, published: 3 }, 5);
check("suy nguoc", a.viaDo && a.frames[0].seq === 8 && a.frames[2].seq === 10 && a.lastSeq === 10, a);
// (3) DO hong -> fallback, co co.
a = assignFrameSeqs([{ t: "q" }, { t: "q" }], null, 5);
check("fallback", !a.viaDo && a.fallback && a.frames[0].seq === 6 && a.frames[1].seq === 7 && a.frames[0].seqFallback === true && a.lastSeq === 7, a);
// (4) seqs[] lech so luong -> suy nguoc.
a = assignFrameSeqs([{ t: "q" }, { t: "q" }], { seqs: [9], seq: 9, published: 2 }, 5);
check("seqs lech -> suy nguoc", a.viaDo && a.frames[0].seq === 8 && a.frames[1].seq === 9, a);
// (5) published khong khop -> fallback.
a = assignFrameSeqs([{ t: "q" }, { t: "q" }], { seq: 9, published: 1 }, 5);
check("published lech -> fallback", a.fallback && a.frames[0].seq === 6, a);
// (6) seqs[] co so 0 (du lieu hong) nhung seq+published nhat quan
// -> suy nguoc tu seq cuoi van dung (DO tu cap seq, seqs[] la phan hong).
a = assignFrameSeqs([{ t: "q" }], { seqs: [0], seq: 9, published: 1 }, 5);
check("seqs hong + seq nhat quan -> suy nguoc", a.viaDo && !a.fallback && a.frames[0].seq === 9 && a.lastSeq === 9, a);
// (7) seqs[] hong + published lech -> fallback.
a = assignFrameSeqs([{ t: "q" }], { seqs: [0], seq: 9, published: 2 }, 5);
check("seqs hong + published lech -> fallback", a.fallback && a.frames[0].seq === 6, a);

console.log("fanout: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
