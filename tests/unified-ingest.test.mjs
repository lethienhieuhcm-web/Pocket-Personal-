// Test ham thuan cua unified-ingest.js (nap bang vm, khong DOM/window).
// Run: node tests/unified-ingest.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "js", "features", "unified-ingest.js"), "utf8");
const moduleObj = { exports: {} };
const sandbox = {
  module: moduleObj, exports: moduleObj.exports, console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  URLSearchParams: URLSearchParams,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const U = moduleObj.exports;

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
function eq(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

check("exports du", ["shouldAcceptSeq", "parseFrame", "nextRetryDelay", "channelFor", "isTestChannel", "buildDoSub", "deltaPlan"].every(k => typeof U[k] === "function"), Object.keys(U));

// shouldAcceptSeq
check("seq 1>0", U.shouldAcceptSeq(1, 0) === true);
check("seq trung", U.shouldAcceptSeq(5, 5) === false);
check("seq cu", U.shouldAcceptSeq(4, 5) === false);
check("seq 0", U.shouldAcceptSeq(0, 0) === false);
check("seq thap phan", U.shouldAcceptSeq(4.5, 0) === false);
check("seq string", U.shouldAcceptSeq("3", 0) === false);

// parseFrame
check("parse q string", eq(U.parseFrame('{"t":"q","seq":3,"s":"ACB","p":22500}'), { t: "q", seq: 3, s: "ACB", p: 22500 }));
check("parse q object", U.parseFrame({ t: "q", seq: 1, s: "MWG" }).s === "MWG");
check("parse idx", U.parseFrame({ t: "idx", seq: 2, rows: [{ s: "VNINDEX", p: 1700 }] }).rows.length === 1);
check("ping khong seq -> null", U.parseFrame({ name: "update", data: "{}" }) === null);
check("q thieu s -> null", U.parseFrame({ t: "q", seq: 1 }) === null);
check("idx thieu rows -> null", U.parseFrame({ t: "idx", seq: 1 }) === null);
check("chu rac -> null", U.parseFrame("{khong phai json") === null);
check("control DO khong seq -> null", U.parseFrame({ t: "resumed", seq: undefined }) === null);
check("t la -> null", U.parseFrame({ t: "snap", seq: 1 }) === null);

// nextRetryDelay: 1s/2s/5s, keo dai giu 5s.
check("retry delays", U.nextRetryDelay(0) === 1000 && U.nextRetryDelay(1) === 2000 && U.nextRetryDelay(2) === 5000 && U.nextRetryDelay(9) === 5000);

// channelFor
check("pushchan hop le", U.channelFor("?pushchan=staging-h1-20261029") === "staging-h1-20261029");
check("pushchan sai dinh dang", U.channelFor("?pushchan=market") === "market");
check("khong pushchan", U.channelFor("") === "market");
check("isTestChannel", U.isTestChannel("staging-h1-20261029") === true && U.isTestChannel("market") === false);

// buildDoSub
check("sub detail", eq(U.buildDoSub("v-detail", "acb"), { syms: ["ACB"] }));
check("sub market", eq(U.buildDoSub("v-market", null), { syms: [], view: "market" }));
check("sub view khac -> market", eq(U.buildDoSub("v-screen", null), { syms: [], view: "market" }));

// deltaPlan
const qf = { t: "q", seq: 1, s: "ACB" };
check("plan idx", U.deltaPlan({ t: "idx", seq: 1, rows: [] }, "v-market", null, false) === "idx");
check("plan q-market", U.deltaPlan(qf, "v-market", null, false) === "q-market");
check("plan q-detail khop", U.deltaPlan(qf, "v-detail", "ACB", false) === "q-detail");
check("plan q-detail khac ma", U.deltaPlan(qf, "v-detail", "MWG", false) === "ignore");
check("plan q-detail idxMode", U.deltaPlan(qf, "v-detail", "ACB", true) === "ignore");
check("plan q view khac", U.deltaPlan(qf, "v-screen", null, false) === "ignore");
check("plan null", U.deltaPlan(null, "v-market", null, false) === "ignore");

console.log("unified-ingest: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
