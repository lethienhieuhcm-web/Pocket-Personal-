/* DO `market-room` — H1 pha DO (thiet ke luot 1 §5.2, staging-only).
 * 1 DO/phien (ten theo ngay ICT, Worker chon). Hibernation bat buoc:
 * khong setInterval, alarm 1 lan/phut don socket chet. Ring buffer 60
 * frame trong bo nho; client resume bang since: seq. Khong ghi R2/D1.
 * Seq: DO gan neu frame chua co seq; giu nguyen neu frame da co seq
 * lon hon (de duong Ably sau nay cung 1 seq). Frame trung seq -> bo.
 * Loc theo tag o bo nho (sym:{MA} / view:{ten}); socket vua thuc sau
 * hibernation chua co tag -> fail-open (gui tat ca, client tu loc).
 * Loi KHONG nuot im lang: auth sai, batch qua co, rate-limit deu log.
 */
import { DurableObject } from "cloudflare:workers";
import { dbGetSession } from "./db.js";

const MAX_BATCH_BYTES = 512 * 1024;
const MAX_BUFFER = 60;
const MAX_MSG_PER_SEC = 10;
const IDLE_CLOSE_MS = 10 * 60 * 1000;

export class MarketRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.buffer = []; // frame gan nhat, toi da 60, theo thu tu seq
    this.lastSeq = 0;
    this.sockets = new Map(); // ws -> {authed, email, syms:Set, views:Set, lastSeen, winStart, msgCount}
    this.alarmSet = false;
  }

  _state(ws) {
    let st = this.sockets.get(ws);
    if (!st) {
      st = { authed: false, email: "", syms: new Set(), views: new Set(), lastSeen: Date.now(), winStart: Date.now(), msgCount: 0 };
      this.sockets.set(ws, st);
    }
    return st;
  }

  _armAlarm() {
    if (this.alarmSet) return;
    this.alarmSet = true;
    this.ctx.storage.setAlarm(Date.now() + 60000).catch(() => {});
  }

  async alarm() {
    this.alarmSet = false;
    const now = Date.now();
    for (const [ws, st] of this.sockets) {
      if (now - st.lastSeen > IDLE_CLOSE_MS) {
        try { ws.close(1000, "idle"); } catch (e) {}
        this.sockets.delete(ws);
      }
    }
    if (this.sockets.size > 0) this._armAlarm();
  }

  _match(st, frame) {
    if (frame.t === "q") return st.syms.has(frame.s) || st.views.has("market");
    if (frame.t === "idx") return st.views.has("market");
    return false;
  }

  _broadcast(frame) {
    const data = JSON.stringify(frame);
    for (const [ws, st] of this.sockets) {
      if (!st.authed) continue;
      if (!this._match(st, frame)) continue;
      try { ws.send(data); } catch (e) {
        console.error(`[do] send loi: ${e && e.message ? e.message : e}`);
        this.sockets.delete(ws);
      }
    }
  }

  _ingest(frames) {
    let published = 0;
    const seqs = [];
    for (const f of frames) {
      if (!f || typeof f !== "object") continue;
      const t = f.t === "idx" ? "idx" : "q";
      if (t === "q" && typeof f.s !== "string") continue;
      let seq = Number(f.seq);
      if (!Number.isInteger(seq) || seq <= 0) seq = this.lastSeq + 1;
      if (seq <= this.lastSeq) continue; // trung / cu -> bo
      const frame = Object.assign({}, f, { t, seq, ts: Date.now() });
      this.lastSeq = seq;
      this.buffer.push(frame);
      if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
      this._broadcast(frame);
      published++;
      seqs.push(seq);
    }
    return { published, seqs };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade") || "";
    if (upgrade.toLowerCase().includes("websocket")) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this._state(server);
      this._armAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === "POST" && url.pathname === "/ingest") {
      const want = this.env.INTERNAL_SECRET || this.env.STOCK_PUBLISH_SECRET || "";
      const got = request.headers.get("X-Internal-Secret") || "";
      if (!want || got !== want) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
      const text = await request.text();
      if (text.length > MAX_BATCH_BYTES) {
        console.error(`[do] batch qua co: ${text.length} byte > ${MAX_BATCH_BYTES}`);
        return new Response(JSON.stringify({ error: "Batch too large" }), { status: 413 });
      }
      let body;
      try { body = JSON.parse(text); } catch (e) {
        return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400 });
      }
      const frames = Array.isArray(body.frames) ? body.frames : (body.frame ? [body.frame] : []);
      if (frames.length === 0 || frames.length > 60) {
        return new Response(JSON.stringify({ error: "Bad frames" }), { status: 400 });
      }
      const res = this._ingest(frames);
      return new Response(JSON.stringify({ ok: true, published: res.published, seq: this.lastSeq, seqs: res.seqs }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

  async webSocketMessage(ws, message) {
    const st = this._state(ws);
    const now = Date.now();
    st.lastSeen = now;
    if (now - st.winStart >= 1000) { st.winStart = now; st.msgCount = 0; }
    st.msgCount++;
    if (st.msgCount > MAX_MSG_PER_SEC) {
      console.error("[do] socket spam >10 tin/giay, dong");
      try { ws.close(1008, "rate limit"); } catch (e) {}
      this.sockets.delete(ws);
      return;
    }
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "auth") {
      const token = typeof msg.token === "string" ? msg.token : "";
      let sess = null;
      try { sess = token ? await dbGetSession(this.env, token) : null; } catch (e) {
        console.error(`[do] kiem session loi: ${e && e.message ? e.message : e}`);
      }
      if (!sess || (sess.exp && sess.exp < Date.now())) {
        try { ws.send(JSON.stringify({ t: "error", code: 4401 })); } catch (e) {}
        try { ws.close(4401, "unauthorized"); } catch (e) {}
        this.sockets.delete(ws);
        return;
      }
      st.authed = true;
      st.email = sess.email || "";
      try { ws.send(JSON.stringify({ t: "ok" })); } catch (e) {}
      return;
    }

    if (!st.authed) {
      try { ws.send(JSON.stringify({ t: "auth-required" })); } catch (e) {}
      return;
    }

    if (msg.t === "sub") {
      const syms = Array.isArray(msg.syms) ? msg.syms : [];
      for (const s of syms) if (typeof s === "string" && s) st.syms.add(s.toUpperCase());
      if (typeof msg.view === "string" && msg.view) st.views.add(msg.view);
      try { ws.send(JSON.stringify({ t: "subbed" })); } catch (e) {}
      return;
    }
    if (msg.t === "unsub") {
      const syms = Array.isArray(msg.syms) ? msg.syms : [];
      for (const s of syms) st.syms.delete(String(s).toUpperCase());
      return;
    }
    if (msg.t === "resume") {
      const since = Number(msg.since) || 0;
      for (const f of this.buffer) {
        if (f.seq <= since) continue;
        if (!this._match(st, f)) continue;
        try { ws.send(JSON.stringify(f)); } catch (e) { break; }
      }
      try { ws.send(JSON.stringify({ t: "resumed", seq: this.lastSeq })); } catch (e) {}
      return;
    }
    if (msg.t === "ping") {
      try { ws.send(JSON.stringify({ t: "hb", ts: Date.now() })); } catch (e) {}
      return;
    }
    // Frame la -> bo, khong log spam.
  }

  webSocketClose(ws) {
    this.sockets.delete(ws);
  }

  webSocketError(ws, error) {
    console.error(`[do] socket loi: ${error && error.message ? error.message : error}`);
    this.sockets.delete(ws);
  }
}
