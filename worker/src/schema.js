// worker/src/schema.js — Drizzle ORM schema cho 17 bảng D1 pocket-personal.
// Generated from live D1 schema 2026-10-10 (k1 mục 4). Không sửa tay — regenerate khi D1 đổi.

import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";

export const agentChats = sqliteTable("agent_chats", {
  email: text("email").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});

export const agentJobs = sqliteTable("agent_jobs", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  status: text("status").notNull().default("queued"),
  messagesJson: text("messages_json"),
  loopCount: integer("loop_count").default(0),
  geminiReqId: text("gemini_req_id"),
  replyText: text("reply_text"),
  errorMsg: text("error_msg"),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

export const agentStreamChunks = sqliteTable("agent_stream_chunks", {
  jobId: text("job_id").notNull(),
  seq: integer("seq").notNull(),
  chunk: text("chunk").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.jobId, t.seq] }),
]);

export const aiCache = sqliteTable("ai_cache", {
  cacheKey: text("cache_key").primaryKey(),
  response: text("response"),
  createdAt: integer("created_at"),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),
  price: real("price").notNull(),
  active: integer("active").default(1),
  createdAt: integer("created_at").notNull(),
});

export const driveTokens = sqliteTable("drive_tokens", {
  email: text("email").primaryKey(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at"),
});

export const geminiQueue = sqliteTable("gemini_queue", {
  id: text("id").primaryKey(),
  requestJson: text("request_json").notNull(),
  status: text("status").notNull().default("pending"),
  responseJson: text("response_json"),
  errorMsg: text("error_msg"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});


export const ruleAlerts = sqliteTable("rule_alerts", {
  id: integer("id").primaryKey(),
  email: text("email").notNull(),
  symbol: text("symbol").notNull(),
  type: text("type").notNull(),
  threshold: real("threshold").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const portfolioTxns = sqliteTable("portfolio_txns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  price: real("price").notNull(),
  qty: real("qty").notNull(),
  fee: real("fee").default(0),
  note: text("note"),
  date: text("date").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const rateLimits = sqliteTable("rate_limits", {
  ip: text("ip").notNull(),
  endpoint: text("endpoint").notNull(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").default(1),
}, (t) => [primaryKey({ columns: [t.ip, t.endpoint, t.windowStart] })]);

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  email: text("email").notNull(),
  exp: integer("exp").notNull(),
  data: text("data").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const spotifyTokens = sqliteTable("spotify_tokens", {
  email: text("email").primaryKey(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at"),
});

export const subscriptions = sqliteTable("subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  plan: text("plan").notNull(),
  startedAt: integer("started_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  activatedBy: text("activated_by"),
  note: text("note"),
});

export const targets = sqliteTable("targets", {
  email: text("email").notNull(),
  symbol: text("symbol").notNull(),
  takeProfitPct: real("take_profit_pct"),
  stopLossPct: real("stop_loss_pct"),
  tpDone: integer("tp_done").default(0),
  slDone: integer("sl_done").default(0),
}, (t) => [primaryKey({ columns: [t.email, t.symbol] })]);

export const usageDaily = sqliteTable("usage_daily", {
  email: text("email").notNull(),
  date: text("date").notNull(),
  dictLookups: integer("dict_lookups").default(0),
  ttsChars: integer("tts_chars").default(0),
  englishScans: integer("english_scans").default(0),
  englishUploads: integer("english_uploads").default(0),
  backtestCount: integer("backtest_count").default(0),
  aiCalls: integer("ai_calls").default(0),
  agentCalls: integer("agent_calls").default(0),
  browsePages: integer("browse_pages").default(0),
}, (t) => [primaryKey({ columns: [t.email, t.date] })]);

// MCP GD1 (Chot 22/10/2026): nhat ky truy van MCP — bang vat ly
// duoc tao bang CREATE TABLE IF NOT EXISTS trong mcp.js (ensureLog,
// cung pattern dac_playlists cua dac.js); dinh nghia nay de tai lieu
// hoa + truy van drizzle khi can. Giu 90 ngay.
export const mcpLog = sqliteTable("mcp_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: text("ts").notNull(),
  userEmail: text("user_email").notNull(),
  plan: text("plan"),
  tool: text("tool"),
  paramsJson: text("params_json"),
  status: text("status").notNull(),
  refusalCode: text("refusal_code"),
  verificationFlags: text("verification_flags"),
  resultRows: integer("result_rows"),
  latencyMs: integer("latency_ms"),
  asOf: text("as_of"),
});

export const browserCookies = sqliteTable("browser_cookies", {
  email: text("email").notNull(),
  host: text("host").notNull(),
  name: text("name").notNull(),
  value: text("value").default(""),
  path: text("path").default("/"),
  expiresAt: integer("expires_at").default(0),
  secure: integer("secure").default(0),
}, (t) => [primaryKey({ columns: [t.email, t.host, t.path, t.name] })]);

export const users = sqliteTable("users", {
  email: text("email").primaryKey(),
  data: text("data").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const vocabReviews = sqliteTable("vocab_reviews", {
  email: text("email"),
  word: text("word"),
  nextReview: integer("next_review"),
  intervalDays: integer("interval_days").default(1),
  reviews: integer("reviews").default(0),
  correct: integer("correct").default(0),
  updatedAt: integer("updated_at"),
  meaning: text("meaning").default(""),
}, (t) => [primaryKey({ columns: [t.email, t.word] })]);

export const watchlist = sqliteTable("watchlist", {
  email: text("email").notNull(),
  symbol: text("symbol").notNull(),
  addedAt: integer("added_at").notNull(),
}, (t) => [primaryKey({ columns: [t.email, t.symbol] })]);

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").default(""),
  coverUrl: text("cover_url").default(""),
  itemCount: integer("item_count").default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const collectionItems = sqliteTable("collection_items", {
  id: text("id").primaryKey(),
  collectionId: text("collection_id").notNull(),
  title: text("title").notNull(),
  contentType: text("content_type").default("article"),
  contentUrl: text("content_url").default(""),
  excerpt: text("excerpt").default(""),
  durationSec: integer("duration_sec").default(0),
  sortOrder: integer("sort_order").default(0),
  createdAt: integer("created_at").notNull(),
});
