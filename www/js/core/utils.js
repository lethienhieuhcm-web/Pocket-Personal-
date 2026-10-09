// js/core/utils.js — pure text helpers. Zero dependencies.
export function chunkText(text, max=4500){
  const t = text.trim();
  if(t.length <= max) return [t];
  const parts = t.split(/(?<=[.!?])\s+/);
  const chunks = []; let cur = "";
  for(const p of parts){
    if(cur && (cur+" "+p).length > max){ chunks.push(cur.trim()); cur = p; }
    else cur = cur ? cur+" "+p : p;
  }
  if(cur.trim()) chunks.push(cur.trim());
  return chunks;
}
export function hashStr(s){ let h=5381; for(let i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))|0; return (h>>>0).toString(36); }
export function fmtT(s){ s=Math.max(0,Math.floor(s||0)); return Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); }
export function splitSents(text){
  return cleanOCRText(text).replace(/\s*\n\s*/g," ")
    .split(/(?<=[.!?])\s+/)
    .map(s=>s.trim()).filter(s=>s.length>10);
}

export function cleanOCRText(text){
  const lines = text.split("\n");
  const kept = [];
  for(let line of lines){
    line = line.trim();
    if(!line) continue;
    if(/https?:\/\//i.test(line)) continue;                    // URLs
    if(/\/\d{4}\/\d{2}\//.test(line)) continue;                // date paths like /2026/10/04/
    if(/\b\w+\.(com|org|net|io|vn|edu)\b/i.test(line) && /[^\w.]/.test(line)) continue; // domains
    if((line.match(/>/g)||[]).length >= 2) continue;           // tab bars: > A > B >
    if(line.length < 20) continue;                            // UI fragments: X, +, end
    const letters = (line.match(/[A-Za-z]/g)||[]).length;
    if(letters < line.length * 0.6) continue;                 // mostly symbols
    kept.push(line);
  }
  return kept.join("\n");
}
export function classifyCEFR(sent){
  const words = sent.match(/[A-Za-z]+(?:'[a-z]+)?/g) || [];
  if(!words.length) return null;
  const avgLen = words.join("").length / words.length;
  const nWords = words.length;
  const hasSub = /\b(because|although|though|while|whereas|unless|until|since|if|when|that|which|who|whom|whose)\b/i.test(sent);
  const hasPass = /\b(am|is|are|was|were|been|be)\s+\w+ed\b/i.test(sent);
  const hasPerf = /\b(have|has|had)\s+\w+ed\b/i.test(sent);
  const longRatio = words.filter(w => w.length >= 8).length / words.length;
  let s = 0;
  s += Math.min(nWords / 4, 5);
  s += Math.min(Math.max(0, avgLen - 3.5) * 2, 4);
  s += longRatio * 6;
  s += hasSub ? 2 : 0;
  s += hasPass ? 1.5 : 0;
  s += hasPerf ? 1 : 0;
  if(s < 4) return "A1";
  if(s < 7) return "A2";
  if(s < 10) return "B1";
  if(s < 13) return "B2";
  if(s < 16) return "C1";
  return "C2";
}
