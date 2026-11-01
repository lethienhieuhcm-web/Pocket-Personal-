// Tests for the staging test mode (Chot 16:14 01/11/2026): getSession in
// worker/src/auth.js accepts a fixed test credential ONLY on the staging
// host (staging.lethanhdong.one) when env.TEST_CREDENTIAL is set, returning
// a free-tier test identity; everything else falls through to the Bearer
// flow unchanged. Covers the guard (both layers), strict comparison,
// Bearer compatibility, resolveCaller tier 0, hMcp tools/list 4 tools,
// and the production-host / admin / no-credential denials.
// Real auth.js + real mcp.js; in-memory db stub; no network, no D1, no deploy.
// Run: node tests/auth-test-mode.test.mjs
import { register } from "node:module";
register("./auth-hooks.mjs", import.meta.url);

const { getSession, getUser, TEST_USER_EMAIL, STAGING_HOST, OWNER_EMAIL } =
  await import("../worker/src/auth.js");
const { resolveCaller, hMcp } = await import("../worker/src/mcp.js");
const { dbGetSession, __seedSession, __seedUser, __reset } =
  await import("./stubs/auth-db.mjs");

// Fixed unit-test-only credential constant. This is NOT the staging secret
// (that value lives only on the staging worker + the operator's store, and
// never appears in the repo). The test checks equality logic, not the secret.
const TEST_CREDENTIAL = "test-credential-unit-only";

let passed = 0, failed = 0;
function check(name, cond, extra){
  if (cond) { passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

const hdr = (o) => new Headers(o);
const req = (host = STAGING_HOST, headers = {}) =>
  new Request(`https://${host}/api/mcp`, { headers: hdr(headers) });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const env = { TEST_CREDENTIAL };

// Mock env for hMcp (same shape as tests/mcp-gating.test.mjs): R2 DATA +
// a recording D1-ish DB so mcp_log writes succeed without a real database.
function mockEnv(){
  const store = new Map();
  const logRows = [];
  return { store, logRows,
    DATA: {
      get: async (key) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return { json: async () => JSON.parse(JSON.stringify(v)) };
      },
      put: async (key, val) => { store.set(key, JSON.parse(val)); },
    },
    DB: {
      prepare: (sql) => {
        const run = async () => { logRows.push({ sql, args: [] }); return {}; };
        return { run,
          bind: (...args) => ({
            run: async () => { logRows.push({ sql, args }); return {}; },
            first: async () => null,
            all: async () => ({ results: [] }),
          }) };
      },
    },
  };
}
async function callMcpList(headers, e){
  const r = await hMcp(
    new Request(`https://${STAGING_HOST}/api/mcp`, {
      method: "POST",
      headers: hdr({ "content-type": "application/json", ...headers }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    { ...e, TEST_CREDENTIAL });
  return { status: r.status, json: await r.json() };
}

// 1. secret UNSET -> correct test header is ignored -> null (no Bearer)
{
  const s = await getSession(req(STAGING_HOST, { "X-Test-Credential": TEST_CREDENTIAL }), {});
  check("1. secret unset + correct header -> null", s === null, s);
}
// 2. secret = empty string -> same as unset -> null
{
  const s = await getSession(req(STAGING_HOST, { "X-Test-Credential": TEST_CREDENTIAL }),
    { TEST_CREDENTIAL: "" });
  check("2. secret empty + correct header -> null", s === null, s);
}
// 3. secret set + staging host + correct header -> test session, right shape
{
  const before = Date.now();
  const s = await getSession(req(STAGING_HOST, { "X-Test-Credential": TEST_CREDENTIAL }), env);
  check("3. secret set + staging + correct header -> test session",
    s && s.email === TEST_USER_EMAIL && s.email === "test@staging.local" && s.token === "test" &&
    s.exp >= before + 3600_000 && s.exp <= Date.now() + 3600_000, s);
}
// 4. secret set + staging host + WRONG header -> null (falls back to Bearer)
{
  const s = await getSession(req(STAGING_HOST, { "X-Test-Credential": "khong-phai-gia-tri-nay" }), env);
  check("4. secret set + staging + wrong header -> null", s === null, s);
}
// 5. header wrong by 1 char, same length -> no match -> null
{
  const almost = TEST_CREDENTIAL.slice(0, -1) + (TEST_CREDENTIAL.endsWith("a") ? "b" : "a");
  const s = await getSession(req(STAGING_HOST, { "X-Test-Credential": almost }), env);
  check("5. header wrong by 1 char (same length) -> null", s === null, s);
}
// 6. header missing (only secret + staging host) -> null
{
  const s = await getSession(req(STAGING_HOST), env);
  check("6. header missing -> null", s === null, s);
}
// 7. GUARD LAYER 2: secret set + PRODUCTION hostname -> correct header ignored -> null
{
  const s = await getSession(req("lethanhdong.one", { "X-Test-Credential": TEST_CREDENTIAL }), env);
  check("7. secret set + production host -> null", s === null, s);
}
// 8. variant hostnames (other subdomain / prefix / suffix) -> no exact match -> null
{
  check("8a. staging2.lethanhdong.one -> null",
    await getSession(req("staging2.lethanhdong.one", { "X-Test-Credential": TEST_CREDENTIAL }), env) === null);
  check("8b. xstaging.lethanhdong.one -> null",
    await getSession(req("xstaging.lethanhdong.one", { "X-Test-Credential": TEST_CREDENTIAL }), env) === null);
  check("8c. staging.lethanhdong.one.evil.test -> null",
    await getSession(req("staging.lethanhdong.one.evil.test", { "X-Test-Credential": TEST_CREDENTIAL }), env) === null);
}
// 9. no env (undefined) -> no crash, falls back to Bearer -> null
{
  const s = await getSession(req(STAGING_HOST, { "X-Test-Credential": TEST_CREDENTIAL }), undefined);
  check("9. env undefined -> null, no crash", s === null, s);
}
// 10. Valid Bearer still works as before (test mode does not break the old flow)
{
  __reset();
  __seedSession("tok-bearer-1", "user@example.com", Date.now() + 86400_000);
  const s1 = await getSession(req(STAGING_HOST, bearer("tok-bearer-1")), {});
  check("10a. Bearer valid, test mode off -> session",
    s1 && s1.email === "user@example.com" && s1.token === "tok-bearer-1", s1);
  const s2 = await getSession(req(STAGING_HOST, bearer("tok-bearer-1")), env);
  check("10b. Bearer valid, test mode on but no test header -> session",
    s2 && s2.email === "user@example.com", s2);
  const s3 = await getSession(req(STAGING_HOST, bearer('"tok-bearer-1"')), env);
  check("10c. Bearer JSON-quoted token still works",
    s3 && s3.email === "user@example.com", s3);
}
// 11. Bearer + correct test header -> test mode wins (checked BEFORE Bearer)
{
  __reset();
  __seedSession("tok-bearer-1", "user@example.com", Date.now() + 86400_000);
  const s = await getSession(req(STAGING_HOST, {
    ...bearer("tok-bearer-1"), "X-Test-Credential": TEST_CREDENTIAL,
  }), env);
  check("11. Bearer + correct test header -> test identity wins",
    s && s.email === TEST_USER_EMAIL, s);
}
// 12. getUser(test@staging.local) = null -> resolveCaller tier 0 / plan free
{
  __reset();
  check("12a. getUser(test identity) = null",
    await getUser(env, TEST_USER_EMAIL) === null);
  const caller = await resolveCaller(req(STAGING_HOST, { "X-Test-Credential": TEST_CREDENTIAL }), env);
  check("12b. resolveCaller -> free tier 0, not owner",
    caller && caller.email === TEST_USER_EMAIL && caller.user === null &&
    caller.plan === "free" && caller.tier === 0 && caller.email !== OWNER_EMAIL, caller);
}
// 13. resolveCaller without credential -> null (401 at dispatcher/hMcp layer)
{
  __reset();
  check("13a. resolveCaller no credential -> null",
    await resolveCaller(req(STAGING_HOST), env) === null);
  check("13b. resolveCaller test header but secret unset -> null",
    await resolveCaller(req(STAGING_HOST, { "X-Test-Credential": TEST_CREDENTIAL }), {}) === null);
}
// 14. Expired Bearer token -> null (test mode does not change that)
{
  __reset();
  __seedSession("tok-live", "a@example.com", Date.now() + 1000);
  __seedSession("tok-expired", "a@example.com", Date.now() - 1);
  check("14a. live Bearer token resolves",
    await dbGetSession({}, "tok-live") !== null);
  check("14b. expired Bearer token -> null",
    await getSession(req(STAGING_HOST, bearer("tok-expired")), {}) === null);
}
// 15. hMcp direct (bypassing dispatcher) without credential -> 401 -32001 as before
{
  __reset();
  const r = await callMcpList({}, {});
  check("15. hMcp tools/list no credential -> 401 -32001",
    r.status === 401 && r.json.error && r.json.error.code === -32001 &&
    r.json.error.message === "Not logged in", r.json);
}
// 16. hMcp direct + correct test header -> 200, exactly the 4 minTier-0 tools
{
  __reset();
  const e = mockEnv();
  const r = await callMcpList({ "X-Test-Credential": TEST_CREDENTIAL }, e);
  const names = (r.json.result && r.json.result.tools || []).map((t) => t.name).sort();
  check("16. hMcp tools/list + test credential -> 4 tier-0 tools",
    r.status === 200 &&
    JSON.stringify(names) === JSON.stringify(
      ["get_company_profile", "get_indices", "get_ohlcv", "get_quote"]), names);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
