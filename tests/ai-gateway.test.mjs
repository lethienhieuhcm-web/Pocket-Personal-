// tests/ai-gateway.test.mjs — AI Gateway + Workers AI (Chot 16:00 06/11).
// Test offline (fetch/AI.run stub), chung minh:
//   (a) AI Chat goi qua gateway compat tra dung shape (tool call + text);
//   (b) leg 1 (cerebras) loi → fallback leg 2 (google-ai-studio/gemini);
//   (c) het quota Workers AI → loi CO KIEM SOAT (workers_ai_quota), khong crash;
//   (d) consensus verdict no-rating → van DOI LEG (logic giu trong code);
//   (e) gateway loi hoan toan → roi ve duong goi truc tiep cu (hanh vi cu);
//   (f) gateway tat → khong cham gateway, dung duong cu.
// Run: node tests/ai-gateway.test.mjs
import { register } from "node:module";
register("./ai-gateway-hooks.mjs", import.meta.url);

const GW = await import("../worker/src/ai_gateway.js");
const { hAiChat } = await import("../worker/src/ai_chat.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

const GW_URL = "https://gateway.ai.cloudflare.com/v1/acct123/default/compat/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";

// ---------- fetch stub ----------
let calls;
function installFetch(handler){
  calls = [];
  globalThis.fetch = async (url, opts)=>{
    const rec = { url: String(url), headers: (opts && opts.headers) || {},
      body: opts && opts.body ? JSON.parse(opts.body) : null };
    calls.push(rec);
    const out = handler(rec, calls.length);
    if(out instanceof Error) throw out;
    return { status: out.status || 200, ok: (out.status || 200) < 400,
      json: async ()=>out.json, text: async ()=>JSON.stringify(out.json) };
  };
}
const gwOpenAITool = (name, args)=>({ status: 200, json: {
  choices: [{ finishReason: "tool_calls", message: { content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] } });
const gwOpenAIText = (content)=>({ status: 200, json: {
  choices: [{ finishReason: "stop", message: { content } }] } });
const gwHttp = (status)=>({ status, json: { error: { message: "boom" } } });
const geminiTool = (name, args)=>({ status: 200, json: { candidates: [
  { content: { role: "model", parts: [{ functionCall: { name, args } }] } }] } });
const geminiTextResp = (text)=>({ status: 200, json: { candidates: [
  { content: { role: "model", parts: [{ text }] } }] } });

// ---------- env/DB stub ----------
function mkEnv(extra){
  const logRows = [];
  const env = Object.assign({
    AI_GATEWAY_ENABLED: "1",
    AI_GATEWAY_ACCOUNT_ID: "acct123",
    CEREBRAS_API_KEY: "cerebras-k",
    GEMINI_API_KEYS: "gk1,gk2",
    CLOUDFLARE_ACCOUNT_ID: "acct123",
    CLOUDFLARE_API_TOKEN: "cf-tok",
    DB: { prepare: (sql)=>({
      run: async ()=>({ meta: { changes: 0 } }),
      first: async ()=>null,
      bind: (...vals)=>{
        if(/INSERT INTO ai_chat_log/.test(sql)) logRows.push(vals);
        return { run: async ()=>({ meta: { changes: 0 } }), first: async ()=>null };
      } }),
    },
  }, extra || {});
  env.__logRows = logRows;
  return env;
}
const chatReq = (text)=>({
  url: "https://lethanhdong.one/api/ai/chat",
  headers: { get: ()=>null },
  json: async ()=>({ messages: [{ role: "user", text }], lang: "vi" }),
});
globalThis.__GWTEST__ = { toolRuns: [] };
async function runChat(env, text){
  const res = await hAiChat(chatReq(text), env);
  return await res.json();
}

/* ================= (a) shape: tool call qua gateway leg 1 ================= */
{
  const env = mkEnv();
  installFetch((rec)=>{
    if(rec.url === GW_URL){
      if(rec.body.model === "cerebras/gpt-oss-120b"){
        // body phai dang OpenAI: messages + tools.function + system
        return gwOpenAITool("get_quote", { symbol: "FPT" });
      }
      return gwOpenAIText(""); // lead pass → khong co dan
    }
    return geminiTool("get_quote", { symbol: "FPT" }); // duong cu (khong expecting hit o pass1)
  });
  const out = await runChat(env, "Gia FPT hom nay the nao");
  check("a1 ok + tool tu gateway", out.ok === true && out.tool === "get_quote" &&
    out.args && out.args.symbol === "FPT", out);
  const first = calls[0];
  check("a2 goi gateway compat URL", first.url === GW_URL, first && first.url);
  check("a3 model provider/model + key tu env (Bearer)",
    first.body.model === "cerebras/gpt-oss-120b" &&
    first.headers.Authorization === "Bearer cerebras-k", first && first.body);
  check("a4 body OpenAI-shape: system + user + tools.function",
    first.body.messages[0].role === "system" &&
    first.body.messages.some((m)=>m.role === "user") &&
    Array.isArray(first.body.tools) && first.body.tools[0].type === "function" &&
    first.body.tools[0].function.parameters.type === "object" &&
    first.body.tool_choice === "auto", first && first.body.tools && first.body.tools[0]);
  check("a5 tool run qua envelope mcp", globalThis.__GWTEST__.toolRuns.length >= 1 &&
    globalThis.__GWTEST__.toolRuns[0].name === "get_quote");
  const row = env.__logRows[env.__logRows.length - 1];
  check("a6 log via = gateway:leg", !!row && row[8] === "gateway:cerebras/gpt-oss-120b", row && row[8]);
  check("a7 khong goi truc tiep Gemini khi gateway leg 1 OK",
    !calls.some((c)=>c.url === GEMINI_URL), calls.map((c)=>c.url));
}

/* ============ (b) leg 1 loi 500 → fallback leg 2 google-ai-studio ============ */
{
  const env = mkEnv();
  installFetch((rec)=>{
    if(rec.url === GW_URL){
      if(rec.body.model === "cerebras/gpt-oss-120b") return gwHttp(500);
      return rec.headers.Authorization === "Bearer gk1"
        ? gwOpenAITool("get_quote", { symbol: "HPG" }) : gwHttp(401);
    }
    return geminiTool("get_quote", { symbol: "HPG" });
  });
  const out = await runChat(env, "Gia HPG hom nay the nao");
  const gwCalls = calls.filter((c)=>c.url === GW_URL);
  check("b1 leg 1 loi → ket qua tu leg 2 gemini", out.ok === true && out.tool === "get_quote" &&
    out.args.symbol === "HPG", out);
  check("b2 thu theo thu tu leg: cerebras roi google-ai-studio",
    gwCalls[0].body.model === "cerebras/gpt-oss-120b" &&
    gwCalls[1].body.model === "google-ai-studio/gemini-3.5-flash",
    gwCalls.map((c)=>c.body.model));
  check("b3 leg 2 dung key GEMINI_API_KEYS tu env",
    gwCalls[1].headers.Authorization === "Bearer gk1", gwCalls[1].headers);
  const row = env.__logRows[env.__logRows.length - 1];
  check("b4 via log leg 2", !!row && row[8] === "gateway:google-ai-studio/gemini-3.5-flash", row && row[8]);
}

/* ====== (e) gateway loi hoan toan → roi ve goi truc tiep nhu cu ====== */
{
  const env = mkEnv();
  installFetch((rec)=>{
    if(rec.url === GW_URL) return gwHttp(503);
    return rec.url === GEMINI_URL ? geminiTool("get_quote", { symbol: "VIC" }) : gwHttp(500);
  });
  const out = await runChat(env, "Gia VIC hom nay the nao");
  const direct = calls.filter((c)=>c.url === GEMINI_URL);
  check("e1 gateway chet het leg → van OK bang duong cu", out.ok === true &&
    out.tool === "get_quote" && out.args.symbol === "VIC", out);
  check("e2 co goi truc tiep Gemini (x-goog-api-key cu)",
    direct.length >= 1 && direct[0].headers["x-goog-api-key"],
    direct[0] && direct[0].headers);
  check("e3 thu gateway TRUOC khi xuong duong cu",
    calls[0].url === GW_URL, calls[0].url);
  const row = env.__logRows[env.__logRows.length - 1];
  check("e4 via = null (duong cu khong gan tag gateway)", !!row && row[8] === null, row && row[8]);
}

/* =============== (f) gateway tat → khong cham gateway =============== */
{
  const env = mkEnv({ AI_GATEWAY_ENABLED: "0" });
  installFetch((rec)=>geminiTool("get_quote", { symbol: "VNM" }));
  const out = await runChat(env, "Gia VNM hom nay the nao");
  check("f1 van hoat dong nhu cu khi tat gateway", out.ok === true && out.tool === "get_quote");
  check("f2 khong goi gateway.ai.cloudflare.com",
    !calls.some((c)=>/gateway\.ai\.cloudflare\.com/.test(c.url)), calls.map((c)=>c.url));
}

/* ============ (d) no-rating → doi leg (consensus brain) ============ */
{
  const env = mkEnv();
  installFetch((rec)=>{
    if(rec.url === GW_URL){
      if(rec.body.model === "cerebras/gpt-oss-120b") return gwOpenAIText('{"rating": null}');
      if(rec.body.model.indexOf("google-ai-studio") === 0) return gwOpenAIText('{"rating":"Mua","target":100}');
      return gwHttp(500);
    }
    return gwOpenAIText(""); // workersai REST (khong expecting hit)
  });
  const res = await GW.consensusBrainCall(env,
    [{ role: "user", content: "Ket luan dong thuan cho FPT?" }], { env });
  const models = calls.filter((c)=>c.url === GW_URL).map((c)=>c.body.model);
  check("d1 cerebras no-rating → goi tiep leg gemini",
    models[0] === "cerebras/gpt-oss-120b" &&
    models[1] === "google-ai-studio/gemini-3.5-flash", models);
  check("d2 verdict lay tu leg 2", res.ok === true && !res.noRating &&
    res.verdict && res.verdict.rating === "Mua" &&
    res.via === "gw:google-ai-studio/gemini-3.5-flash", res);
}
/* (d2) moi leg no-rating → ket qua no-rating co kiem soat */
{
  const env = mkEnv();
  installFetch((rec)=>{
    if(rec.url === GW_URL) return gwOpenAIText('{"rating":"no rating"}');
    return { status: 200, json: { response: '{"rating":"no rating"}' } };
  });
  const res = await GW.consensusBrainCall(env, [{ role: "user", content: "FPT?" }]);
  check("d3 all no-rating → ok + noRating + cham leg cuoi workersai",
    res.ok === true && res.noRating === true &&
    /workersai/.test(String(res.via)) , res);
}

/* ============ (c) het quota Workers AI → loi co kiem soat ============ */
{
  const env = mkEnv();
  let aiRuns = 0;
  env.AI = { run: async (model, body)=>{
    aiRuns++;
    throw new Error("AIGatewayError: You have run out of the free allocation of 10,000 Neurons for today.");
  } };
  installFetch((rec)=>gwHttp(503)); // moi gateway leg deu chet
  let res, threw = null;
  try { res = await GW.consensusBrainCall(env, [{ role: "user", content: "FPT?" }]); }
  catch (e) { threw = e; }
  check("c1 khong crash (throw) khi het quota", threw === null, threw && String(threw));
  check("c2 reason = workers_ai_quota (đo luong qua binding)",
    res && res.ok === false && res.reason === "workers_ai_quota", res);
  check("c3 Workers AI binding chi goi DUNG 1 lan (khong dot quota them)",
    aiRuns === 1, aiRuns);
}
/* (c2) quota duong REST (HTTP 429 body quota) */
{
  const env = mkEnv();
  installFetch((rec)=>{
    if(rec.url === GW_URL) return gwHttp(503);
    return gwHttp(429); // /ai/run/...
  });
  // them status vao stub tra ve (handler ben tren khong gan status → sua nhanh)
  const res = await GW.consensusBrainCall(env, [{ role: "user", content: "FPT?" }]);
  check("c4 REST quota khong crash", res && (res.reason === "workers_ai_quota" ||
    (res.trace || []).some((t)=>/429|quota/.test(t))), res);
}

/* ============ unit: chuyen Gemini body ↔ OpenAI ============ */
{
  const o = GW.geminiBodyToOpenAI({
    systemInstruction: { parts: [{ text: "SYS" }] },
    contents: [{ role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] }],
    tools: [{ functionDeclarations: [{ name: "t", description: "d",
      parameters: { type: "OBJECT", properties: { a: { type: "STRING" } }, required: ["a"] } }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY" } },
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
  });
  check("u1 system + roles + assistant mapping",
    o.messages[0].role === "system" && o.messages[1].role === "user" &&
    o.messages[2].role === "assistant", o.messages);
  check("u2 schema type lowercased + tool_choice required khi ANY",
    o.tools[0].function.parameters.type === "object" &&
    o.tools[0].function.parameters.properties.a.type === "string" &&
    o.tool_choice === "required" && o.max_tokens === 512 && o.temperature === 0.1, o);
  const g = GW.openaiToGemini({ choices: [{ finishReason: "tool_calls",
    message: { content: "x", tool_calls: [{ function: { name: "get_quote", arguments: '{"symbol":"FPT"}' } }] } }] });
  const fc = (g.candidates[0].content.parts || []).find((p)=>p.functionCall);
  check("u3 openai→gemini shape: functionCall parse duoc",
    fc && fc.functionCall.name === "get_quote" && fc.functionCall.args.symbol === "FPT", g);
  const legs = GW.gatewayLegs(mkEnv(), ["gk1", "gk2"]);
  check("u4 leg order cerebras→gemini→workers-ai (key tu env, khong hardcode)",
    legs.length === 3 && legs[0].model === "cerebras/gpt-oss-120b" &&
    legs[1].model === "google-ai-studio/gemini-3.5-flash" && legs[1].keys.length === 2 &&
    legs[2].model === "workers-ai/@cf/openai/gpt-oss-120b", legs.map((l)=>l.model));
  const legsNoCerebras = GW.gatewayLegs(mkEnv({ CEREBRAS_API_KEY: "" }), ["gk1"]);
  check("u5 leg khong key bi loai (khong goi rong)",
    legsNoCerebras.length === 2 && legsNoCerebras[0].model.indexOf("google") === 0,
    legsNoCerebras.map((l)=>l.model));
}

console.log("\nRESULT " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
