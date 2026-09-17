// BuildZone Admin TMA - Node.js backend (alternative to Pages Functions)
// Same routes: Telegram initData auth + roles + proxy to plugin API (:26903)
// Env: PORT, BOT_TOKEN, OWNER_IDS, MODERATOR_IDS (ADMIN_IDS = legacy alias),
//      GAME_API_URL, GAME_API_KEY. Key never leaves this process.

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const GAME_API_URL = String(process.env.GAME_API_URL || "").replace(/\/$/, "");
const GAME_API_KEY = process.env.GAME_API_KEY || "";
const MOCK = /^(1|true|yes)$/i.test(String(process.env.MOCK || ""));
const PLUGIN_TIMEOUT_MS = 5000;

function parseIds(s) {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isSafeInteger(n));
}
const OWNER_IDS = parseIds(process.env.OWNER_IDS);
const MODERATOR_IDS = [...parseIds(process.env.MODERATOR_IDS), ...parseIds(process.env.ADMIN_IDS)];

function roleOf(uid) {
  if (OWNER_IDS.includes(uid)) return "owner";
  if (MODERATOR_IDS.includes(uid)) return "moderator";
  return null;
}
function adminName(user) {
  if (user.username) return "@" + user.username;
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || ("id" + user.id);
}
function powerNick(user) {
  if (user.username) return String(user.username).replace(/^@/, "");
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || ("id" + user.id);
}

app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseInitData(initData) {
  const params = new URLSearchParams(initData || "");
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function validateInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) return { ok: false, error: "missing initData or bot token" };
  const data = parseInitData(initData);
  const receivedHash = data.hash || "";
  if (!receivedHash) return { ok: false, error: "missing hash" };
  delete data.hash;
  const dataCheckString = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const a = Buffer.from(computedHash, "utf8");
  const b = Buffer.from(receivedHash, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "bad hash" };
  const authDate = Number(data.auth_date || 0);
  if (!authDate) return { ok: false, error: "missing auth_date" };
  if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > maxAgeSec) return { ok: false, error: "initData expired" };
  let user = null;
  try {
    user = JSON.parse(data.user || "null");
  } catch (e) {
    return { ok: false, error: "bad user json" };
  }
  if (!user || !user.id) return { ok: false, error: "missing user" };
  return { ok: true, user, authDate };
}

function getInitDataFromReq(req) {
  const h1 = req.headers["x-telegram-init-data"];
  if (h1) return String(h1);
  const auth = req.headers["authorization"] || "";
  if (typeof auth === "string" && auth.startsWith("tma ")) return auth.slice(4);
  if (req.body && req.body.initData) return String(req.body.initData);
  if (req.query && req.query.initData) return String(req.query.initData);
  return "";
}

function needAuth(req, res, next) {
  const v = validateInitData(getInitDataFromReq(req), BOT_TOKEN);
  if (!v.ok) return res.status(401).json({ ok: false, error: "unauthorized: " + v.error });
  const role = roleOf(Number(v.user.id));
  if (!role) return res.status(403).json({ ok: false, error: "forbidden: not in admin list" });
  req.tgUser = v.user;
  req.role = role;
  req.admin = adminName(v.user);
  next();
}
function needOwner(req, res, next) {
  if (req.role !== "owner") return res.status(403).json({ ok: false, error: "forbidden: owner only" });
  next();
}

async function pluginCall(p, opts = {}) {
  const key = String(GAME_API_KEY || "").trim();
  if (!GAME_API_URL) return { error: "plugin not configured (set GAME_API_URL)", offline: true };
  try {
    const res = await fetch(GAME_API_URL + p, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", "X-Auth-Key": key, "User-Agent": "BuildZone-Admin/1.0" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS)
    });
    const raw = await res.text().catch(() => "");
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    if (res.status === 401) return { error: "bad GAME_API_KEY (plugin said 401)", pluginHttp: 401 };
    if (res.status === 429) return { error: "plugin rate limited, retry later", pluginHttp: 429 };
    if (!res.ok || !data) {
      const snippet = raw ? raw.replace(/\s+/g, " ").slice(0, 160) : "(empty)";
      return { error: `plugin http ${res.status} - body: ${snippet}`, offline: res.status >= 500, pluginHttp: res.status };
    }
    if (!data.ok) return { error: data.error || "plugin error", pluginHttp: res.status };
    return { data: data.data, pluginHttp: res.status };
  } catch (e) {
    return { error: "plugin unreachable (" + String((e && e.name) || "fetch") + ")", offline: true };
  }
}
const passError = (res, r) => res.status(r.offline ? 502 : 400).json({ ok: false, error: r.error, offline: !!r.offline });

// mock state (same contract as plugin)
let mockChatId = 5312;
const mockPlayers = [
  { name: "Oxxygen", xuid: "", uuid: "a73a39b8-1111-4222-8333-0123456789ab", device_id: "b1177f8c001", ip: "176.108.188.2", ping: 33, os: "Android", gamemode: "Creative", x: -11, y: -36, z: -18, dimension: "Overworld", health: 20, is_op: true },
  { name: "AstutePlot58", xuid: "2535000111222333", uuid: "c21d44aa-2222-4333-8444-1123456789ab", device_id: "c2220002", ip: "95.24.11.5", ping: 61, os: "Windows", gamemode: "Survival", x: 120, y: 64, z: -40, dimension: "Overworld", health: 18, is_op: false }
];
const mockChat = [
  { id: 5311, ts: Date.now() / 1000 - 320, type: "join", player: "AstutePlot58", text: "" },
  { id: 5312, ts: Date.now() / 1000 - 60, type: "admin", player: "Oxxygen", text: "тихо, ивент через час" }
];
const mockBans = [];
const mockAudit = [];
let mockMetricsFirst = true;
function mockMetricsData() {
  const first = mockMetricsFirst;
  mockMetricsFirst = false;
  const now = Date.now() / 1000;
  const history = [];
  for (let i = 30; i >= 0; i--) {
    history.push({
      ts: Math.floor(now - i * 60),
      cpu: Math.round((12 + Math.sin(i / 3) * 5 + (i % 5)) * 10) / 10,
      mem: Math.round((34 + (i % 7)) * 10) / 10,
      tps: Math.round((19.4 + (i % 3) * 0.2) * 10) / 10
    });
  }
  return {
    ts: now,
    cpu: { system_percent: first ? null : 12.4, process_percent: first ? null : 45.0, process_of_total: first ? null : 22.5, cores: 2, loadavg: [0.8, 0.6, 0.5] },
    memory: { limit: 2081390592, used: 718000000, percent: 34.5, process_rss: 88000000 },
    disk: { total: 21474836480, used: 4311744512, free: 17163091968, percent: 20.1 },
    game: { tps: 19.8, mspt: 2.4, tick_usage: 11.5 },
    players: { online: mockPlayers.length, max: 44 },
    uptime_sec: 159120,
    history
  };
}
const mockNotes = new Map();

function mockResult(action, admin, name, reason) {
  mockAudit.unshift({ ts: Date.now() / 1000, admin, action, target: name, details: reason || "" });
  if (action === "ban" || action === "alban") {
    if (!mockBans.some((b) => b.name === name)) {
      mockBans.unshift({ name, xuid: "", uuid: "", device_id: "", ip: "", reason: reason || "", source: admin, created: Date.now() / 1000, kind: action });
    }
  }
  if (action === "unban") {
    const i = mockBans.findIndex((b) => b.name === name);
    if (i >= 0) mockBans.splice(i, 1);
  }
  const verbs = { kick: "кикнут", ban: "забанен", alban: "забанен по всем идентификаторам", absoluter: "забанен (Absoluter)", unban: "разбанен" };
  return { result: `Игрок ${name} ${verbs[action] || action}` };
}

// ---------- routes ----------

app.get("/api/health", async (req, res) => {
  const info = { ok: true, service: "buildzone-admin-tma-node", mock: MOCK, time: new Date().toISOString() };
  if (!MOCK && GAME_API_URL) {
    const r = await pluginCall("/api/status");
    info.plugin = r.error
      ? { ok: false, http: r.pluginHttp || 0, error: String(r.error).slice(0, 140) }
      : { ok: true, http: r.pluginHttp || 200 };
  } else {
    info.plugin = { ok: false, http: 0, error: MOCK ? "mock mode" : "not configured" };
  }
  res.json(info);
});

app.post("/api/auth", (req, res) => {
  const v = validateInitData(getInitDataFromReq(req), BOT_TOKEN);
  if (!v.ok) return res.status(401).json({ ok: false, error: "unauthorized: " + v.error });
  const uid = Number(v.user.id);
  const role = roleOf(uid);
  if (!role) {
    return res.status(403).json({
      ok: false,
      error: "forbidden: your Telegram ID is not in admin list",
      user: { id: uid, username: v.user.username || "", first_name: v.user.first_name || "" }
    });
  }
  res.json({
    ok: true, role, mock: MOCK,
    user: { id: v.user.id, username: v.user.username || "", first_name: v.user.first_name || "", last_name: v.user.last_name || "", photo_url: v.user.photo_url || "" },
    authDate: v.authDate
  });
});

app.get("/api/status", needAuth, async (req, res) => {
  if (MOCK) return res.json({ ok: true, mock: true, status: { online: mockPlayers.length, max_players: 44, version: "1.21.50", uptime_sec: 151200, world: "Building Zone", tps: 19.8 } });
  const r = await pluginCall("/api/status");
  if (r.error) return passError(res, r);
  res.json({ ok: true, status: r.data });
});

app.get("/api/game/players", needAuth, async (req, res) => {
  if (MOCK) return res.json({ ok: true, mock: true, players: mockPlayers });
  const r = await pluginCall("/api/players");
  if (r.error) return passError(res, r);
  res.json({ ok: true, players: r.data });
});

app.get("/api/game/chat", needAuth, async (req, res) => {
  const since = Number(req.query.since || 0);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
  const q = String(req.query.q || "").trim();
  if (MOCK) {
    if (q) {
      const needle = q.toLowerCase();
      const msgs = mockChat.filter((m) => ((m.player || "") + " " + (m.text || "")).toLowerCase().includes(needle)).slice(-limit);
      return res.json({ ok: true, mock: true, search: true, last_id: since, global_last: mockChatId, messages: msgs });
    }
    const msgs = mockChat.filter((m) => m.id > since).slice(-limit);
    return res.json({ ok: true, mock: true, last_id: mockChat.length ? mockChat[mockChat.length - 1].id : 0, global_last: mockChatId, messages: msgs });
  }
  const r = await pluginCall(`/api/chat?since=${since}&limit=${limit}` + (q ? `&q=${encodeURIComponent(q)}` : ""));
  if (r.error) return passError(res, r);
  res.json({ ok: true, last_id: r.data.last_id, global_last: r.data.global_last, search: !!r.data.search, messages: r.data.messages });
});

app.post("/api/game/chat", needAuth, async (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 500);
  if (!text) return res.status(400).json({ ok: false, error: "empty text" });
  if (MOCK) {
    mockChat.push({ id: ++mockChatId, ts: Date.now() / 1000, type: "admin", player: req.admin, text });
    return res.json({ ok: true, mock: true, result: "отправлено в игровой чат", last_id: mockChatId });
  }
  const r = await pluginCall("/api/chat", { method: "POST", body: { admin: req.admin, text } });
  if (r.error) return passError(res, r);
  res.json({ ok: true, result: r.data.result || "sent" });
});

for (const action of ["kick", "ban", "alban", "absoluter"]) {
  app.post("/api/game/" + action, needAuth, async (req, res) => {
    const name = String(req.body.name || "").trim();
    const reason = String(req.body.reason || "").trim().slice(0, 300);
    if (!name) return res.status(400).json({ ok: false, error: "empty name" });
    if (MOCK) return res.json({ ok: true, mock: true, ...mockResult(action, req.admin, name, reason) });
    const r = await pluginCall("/api/" + action, { method: "POST", body: { admin: req.admin, name, reason } });
    if (r.error) return passError(res, r);
    res.json({ ok: true, result: r.data.result || "done" });
  });
}

app.post("/api/game/unban", needAuth, needOwner, async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "empty name" });
  if (MOCK) return res.json({ ok: true, mock: true, ...mockResult("unban", req.admin, name, "") });
  const r = await pluginCall("/api/unban", { method: "POST", body: { admin: req.admin, name } });
  if (r.error) return passError(res, r);
  res.json({ ok: true, result: r.data.result || "done" });
});

app.get("/api/game/bans", needAuth, async (req, res) => {
  if (MOCK) return res.json({ ok: true, mock: true, bans: mockBans });
  const r = await pluginCall("/api/bans");
  if (r.error) return passError(res, r);
  res.json({ ok: true, bans: r.data });
});

app.get("/api/game/plugins", needAuth, async (req, res) => {
  if (MOCK) return res.json({ ok: true, mock: true, plugins: [{ name: "ocos", version: "1.3.0", enabled: true }] });
  const r = await pluginCall("/api/plugins");
  if (r.error) return passError(res, r);
  res.json({ ok: true, plugins: r.data });
});

app.get("/api/game/audit", needAuth, needOwner, async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
  if (MOCK) return res.json({ ok: true, mock: true, audit: mockAudit.slice(0, limit) });
  const r = await pluginCall(`/api/audit?limit=${limit}`);
  if (r.error) return passError(res, r);
  res.json({ ok: true, audit: r.data });
});

app.get("/api/game/blocklog", needAuth, async (req, res) => {
  const q = new URLSearchParams({
    x: req.query.x || "0", y: req.query.y || "0", z: req.query.z || "0",
    dimension: req.query.dimension || "Overworld",
    limit: String(Math.min(100, Math.max(1, Number(req.query.limit || 40))))
  }).toString();
  if (MOCK) return res.json({ ok: true, mock: true, entries: [] });
  const r = await pluginCall("/api/blocklog?" + q);
  if (r.error) return passError(res, r);
  res.json({ ok: true, entries: r.data });
});

app.get("/api/game/find", needAuth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = Math.min(25, Math.max(1, Number(req.query.limit || 8)));
  if (MOCK) {
    const needle = q.toLowerCase();
    const known = mockPlayers.map((p) => ({
      name: p.name, clean_name: String(p.name).replace(/§./g, ""), online: true,
      xuid: p.xuid || "", device_id: p.device_id || "", last_ip: p.ip || ""
    }));
    const list = needle ? known.filter((k) => k.clean_name.toLowerCase().includes(needle)) : known;
    return res.json({ ok: true, mock: true, found: list.slice(0, limit) });
  }
  const r = await pluginCall(`/api/find?q=${encodeURIComponent(q)}&limit=${limit}`);
  if (r.error) return passError(res, r);
  res.json({ ok: true, found: r.data });
});

app.get("/api/game/metrics", needAuth, async (req, res) => {
  if (MOCK) return res.json({ ok: true, mock: true, metrics: mockMetricsData() });
  const r = await pluginCall("/api/metrics");
  if (r.error) return passError(res, r);
  res.json({ ok: true, metrics: r.data });
});

app.get("/api/game/power", needAuth, async (req, res) => {
  const nick = powerNick(req.tgUser);
  if (MOCK) {
    return res.json({ ok: true, mock: true, power: {
      can_stop: true, can_restart: true, can_start: false, power_enabled: true,
      you: nick, you_allowed: true, deny_reason: "", locked_by_owner: false,
      start_hint: "Запуск возможен только из панели хостинга: когда сервер выключен, плагин не работает и принять команду не может.",
      host_panel_url: "https://panel.superhub.host/",
      allowed_admins: [nick], owners: ["oxxygen"]
    } });
  }
  const r = await pluginCall("/api/power?admin=" + encodeURIComponent(nick));
  if (r.error) return passError(res, r);
  res.json({ ok: true, power: r.data });
});

app.post("/api/game/power", needAuth, async (req, res) => {
  const action = String(req.body.action || "");
  if (action !== "restart" && action !== "stop") return res.status(400).json({ ok: false, error: "bad action" });
  const nick = powerNick(req.tgUser);
  if (MOCK) {
    return res.json({ ok: true, mock: true, result: action === "restart"
      ? "сервер перезапустится через 5 сек. (если хостинг настроен на автоподъём)"
      : "сервер остановится через 5 сек." });
  }
  const r = await pluginCall("/api/power", { method: "POST", body: { admin: nick, action } });
  if (r.error) return passError(res, r);
  res.json({ ok: true, result: r.data.result || "done" });
});

app.get("/api/notes", needAuth, (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "empty name" });
  res.json({ ok: true, notes: mockNotes.get(name.toLowerCase()) || [], storage: "memory" });
});

app.post("/api/notes", needAuth, (req, res) => {
  const name = String(req.body.name || "").trim();
  const text = String(req.body.text || "").trim().slice(0, 500);
  if (!name || !text) return res.status(400).json({ ok: false, error: "empty name or text" });
  const note = { ts: Date.now() / 1000, by: req.admin, text };
  const key = name.toLowerCase();
  const list = mockNotes.get(key) || [];
  list.push(note);
  while (list.length > 50) list.shift();
  mockNotes.set(key, list);
  res.json({ ok: true, note, storage: "memory" });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Self-ping: keeps free hosting awake by hitting the public URL
// (traffic through the public URL counts as inbound activity).
// Render sets RENDER_EXTERNAL_URL automatically; PUBLIC_URL overrides it.
const SELF_URL = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
if (SELF_URL) {
  const PING_EVERY_MS = 20000;
  setInterval(async () => {
    for (const p of ["/api/health", "/"]) {
      try {
        const r = await fetch(SELF_URL + p, { signal: AbortSignal.timeout(10000) });
        await r.text().catch(() => {});
      } catch (e) { /* stay silent, next round in 20s */ }
    }
  }, PING_EVERY_MS);
  console.log(`[ok] self-ping on: ${SELF_URL} every 20s`);
}

app.listen(PORT, () => {
  console.log(`[ok] BuildZone Admin TMA (node) on :${PORT}, mock=${MOCK}`);
  console.log(`[ok] owners=${OWNER_IDS.length} moderators=${MODERATOR_IDS.length}`);
});

module.exports = { app, validateInitData, parseInitData, roleOf };
