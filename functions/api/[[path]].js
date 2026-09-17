// BuildZone Admin TMA - Cloudflare Pages Functions backend
// Telegram initData auth + roles + proxy to game plugin API (port 26903)
// Env: BOT_TOKEN, OWNER_IDS, MODERATOR_IDS (ADMIN_IDS = legacy alias),
//      GAME_API_URL (e.g. http://89.188.109.183:26903), GAME_API_KEY,
//      optional KV binding NOTES_KV for admin notes
// Iron rule: GAME_API_KEY lives here only, never sent to browser.

const PLUGIN_TIMEOUT_MS = 5000;

// ---------- roles ----------

function parseIds(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n));
}

function roleOf(uid, env) {
  if (parseIds(env.OWNER_IDS).includes(uid)) return "owner";
  const mods = [...parseIds(env.MODERATOR_IDS), ...parseIds(env.ADMIN_IDS)];
  if (mods.includes(uid)) return "moderator";
  return null;
}

function adminName(user) {
  if (user.username) return "@" + user.username;
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || ("id" + user.id);
}

// nick for plugin personal checks: plain username, no @ prefix
function powerNick(user) {
  if (user.username) return String(user.username).replace(/^@/, "");
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || ("id" + user.id);
}

// ---------- Telegram initData validation (WebCrypto) ----------

async function hmacSha256Bytes(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

async function validateInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) return { ok: false, error: "missing initData or bot token" };
  const params = new URLSearchParams(initData);
  const data = {};
  for (const [k, v] of params.entries()) data[k] = v;
  const received = data.hash || "";
  if (!received) return { ok: false, error: "missing hash" };
  delete data.hash;
  const checkString = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join("\n");
  const secret = await hmacSha256Bytes(new TextEncoder().encode("WebAppData"), botToken);
  const computedBytes = await hmacSha256Bytes(secret, checkString);
  const computed = [...computedBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (computed !== received) return { ok: false, error: "bad hash" };
  const authDate = Number(data.auth_date || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || Math.abs(now - authDate) > maxAgeSec) return { ok: false, error: "initData expired" };
  let user = null;
  try {
    user = JSON.parse(data.user || "null");
  } catch (e) {
    return { ok: false, error: "bad user json" };
  }
  if (!user || !user.id) return { ok: false, error: "missing user" };
  return { ok: true, user, authDate };
}

// ---------- plugin proxy (server-side only, key never leaks) ----------

async function pluginCall(env, path, opts = {}) {
  const base = String(env.GAME_API_URL || "").replace(/\/$/, "");
  const key = String(env.GAME_API_KEY || "").trim();
  if (!base) return { error: "plugin not configured (set GAME_API_URL)", offline: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PLUGIN_TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", "X-Auth-Key": key, "User-Agent": "BuildZone-Admin/1.0" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal
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
  } finally {
    clearTimeout(timer);
  }
}

// ---------- mock plugin (same contract, used when GAME_API_URL is empty) ----------

let mockChatId = 5312;
const mockPlayers = [
  { name: "§lOxxy§r§fgen", xuid: "", uuid: "a73a39b8-1111-4222-8333-0123456789ab", device_id: "b1177f8c001", ip: "176.108.188.2", ping: 33, os: "Android", gamemode: "Creative", x: -11, y: -36, z: -18, dimension: "Overworld", health: 20, is_op: true },
  { name: "AstutePlot58", xuid: "2535000111222333", uuid: "c21d44aa-2222-4333-8444-1123456789ab", device_id: "c2220002", ip: "95.24.11.5", ping: 61, os: "Windows", gamemode: "Survival", x: 120, y: 64, z: -40, dimension: "Overworld", health: 18, is_op: false },
  { name: "Glist", xuid: "", uuid: "d33e55bb-3333-4444-8555-2123456789ab", device_id: "d3330003", ip: "178.66.7.9", ping: 45, os: "iOS", gamemode: "Adventure", x: 8, y: 70, z: 200, dimension: "Nether", health: 20, is_op: false },
  { name: "§aSteve The Builder§r", xuid: "", uuid: "e44f66cc-4444-4555-8666-3123456789ab", device_id: "e4440004", ip: "91.77.3.14", ping: 88, os: "Android", gamemode: "Survival", x: -300, y: 12, z: 90, dimension: "Overworld", health: 10, is_op: false },
  { name: "ltRealme2", xuid: "2535999888777666", uuid: "f55a77dd-5555-4666-8777-4123456789ab", device_id: "f5550005", ip: "5.166.20.30", ping: 52, os: "Windows", gamemode: "Survival", x: 10, y: -38, z: 20, dimension: "Overworld", health: 20, is_op: false }
];
const mockChat = [
  { id: 5308, ts: Date.now() / 1000 - 900, type: "join", player: "Glist", text: "" },
  { id: 5309, ts: Date.now() / 1000 - 840, type: "chat", player: "Glist", text: "привет всем" },
  { id: 5310, ts: Date.now() / 1000 - 500, type: "chat", player: "§lOxxy§r§fgen", text: "§aпривет§r, как стройка?" },
  { id: 5311, ts: Date.now() / 1000 - 320, type: "join", player: "AstutePlot58", text: "" },
  { id: 5312, ts: Date.now() / 1000 - 60, type: "admin", player: "Oxxygen", text: "тихо, ивент через час" }
];
const mockBans = [
  { name: "ltRealme2", xuid: "2535999888777666", uuid: "f55a77dd-5555-4666-8777-4123456789ab", device_id: "f5550005", ip: "5.166.20.30", reason: "грифинг", source: "Oxxygen", created: Date.now() / 1000 - 86400, kind: "alban" }
];
const mockAudit = [
  { ts: Date.now() / 1000 - 86400, admin: "Oxxygen", action: "alban", target: "ltRealme2", details: "грифинг" },
  { ts: Date.now() / 1000 - 4000, admin: "Oxxygen", action: "kick", target: "Steve The Builder", details: "афк на спавне" }
];
const mockKnownExtra = [
  { name: "OldGriefer", clean_name: "OldGriefer", online: false, xuid: "2535111111111111", device_id: "dev-old", last_ip: "2.2.2.2" }
];
function mockFind(q, limit) {
  const known = mockPlayers.map((p) => ({
    name: p.name,
    clean_name: String(p.name).replace(/§./g, ""),
    online: true,
    xuid: p.xuid || "",
    device_id: p.device_id || "",
    last_ip: p.ip || ""
  })).concat(mockKnownExtra);
  const needle = String(q || "").toLowerCase();
  const list = needle ? known.filter((k) => k.clean_name.toLowerCase().includes(needle)) : known;
  return list.slice(0, limit);
}
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
    cpu: {
      system_percent: first ? null : 12.4,
      process_percent: first ? null : 45.0,
      process_of_total: first ? null : 22.5,
      cores: 2,
      loadavg: [0.8, 0.6, 0.5]
    },
    memory: { limit: 2081390592, used: 718000000, percent: 34.5, process_rss: 88000000 },
    disk: { total: 21474836480, used: 4311744512, free: 17163091968, percent: 20.1 },
    game: { tps: 19.8, mspt: 2.4, tick_usage: 11.5 },
    players: { online: mockPlayers.length, max: 44 },
    uptime_sec: 159120,
    history
  };
}
const mockNotesMem = new Map();

function mockResult(action, admin, name, reason) {
  const stamp = Date.now() / 1000;
  mockAudit.unshift({ ts: stamp, admin, action, target: name, details: reason || "" });
  if (action === "ban" || action === "alban") {
    if (!mockBans.some((b) => b.name === name)) {
      mockBans.unshift({ name, xuid: "", uuid: "", device_id: "", ip: "", reason: reason || "", source: admin, created: stamp, kind: action });
    }
  }
  if (action === "unban") {
    const i = mockBans.findIndex((b) => b.name === name);
    if (i >= 0) mockBans.splice(i, 1);
  }
  const verbs = { kick: "кикнут", ban: "забанен", alban: "забанен по всем идентификаторам", absoluter: "забанен (Absoluter)", unban: "разбанен" };
  return { result: `Игрок ${name} ${verbs[action] || action}` };
}

// ---------- notes (KV if bound, else per-isolate memory) ----------

async function notesGet(env, name) {
  const key = "notes:" + String(name).toLowerCase();
  if (env.NOTES_KV) {
    try {
      const raw = await env.NOTES_KV.get(key);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
  return mockNotesMem.get(key) || [];
}

async function notesAdd(env, name, note) {
  const key = String(name).toLowerCase();
  const list = await notesGet(env, name);
  list.push(note);
  while (list.length > 50) list.shift();
  if (env.NOTES_KV) {
    await env.NOTES_KV.put("notes:" + key, JSON.stringify(list));
    return { list, storage: "kv" };
  }
  mockNotesMem.set("notes:" + key, list);
  return { list, storage: "memory" };
}

// ---------- router ----------

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const BOT_TOKEN = (env && env.BOT_TOKEN) || "";
  const MOCK = /^(1|true|yes)$/i.test(String((env && env.MOCK) || ""));

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" }
    });

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const segs = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const route = segs.join("/");

  let body = {};
  if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
    body = await request.json().catch(() => ({}));
  }

  const getInitData = () =>
    request.headers.get("X-Telegram-Init-Data") ||
    (request.headers.get("Authorization") || "").replace(/^tma\s+/, "") ||
    body.initData ||
    "";

  // public health + plugin reachability self-test (flags only, no game data, no key)
  if (route === "health" && request.method === "GET") {
    const info = { ok: true, service: "buildzone-admin-tma-pages", mock: MOCK, time: new Date().toISOString() };
    if (!MOCK && String((env && env.GAME_API_URL) || "").trim()) {
      const r = await pluginCall(env, "/api/status");
      info.plugin = r.error
        ? { ok: false, http: r.pluginHttp || 0, error: String(r.error).slice(0, 140) }
        : { ok: true, http: r.pluginHttp || 200 };
    } else {
      info.plugin = { ok: false, http: 0, error: MOCK ? "mock mode" : "not configured" };
    }
    return json(info);
  }

  // POST /api/auth - transparent Telegram login + role
  if (route === "auth" && request.method === "POST") {
    const v = await validateInitData(getInitData(), BOT_TOKEN);
    if (!v.ok) return json({ ok: false, error: "unauthorized: " + v.error }, 401);
    const uid = Number(v.user.id);
    const role = roleOf(uid, env);
    if (!role) {
      return json({
        ok: false,
        error: "forbidden: your Telegram ID is not in admin list",
        user: { id: uid, username: v.user.username || "", first_name: v.user.first_name || "" }
      }, 403);
    }
    return json({
      ok: true,
      role,
      mock: MOCK,
      user: {
        id: v.user.id,
        username: v.user.username || "",
        first_name: v.user.first_name || "",
        last_name: v.user.last_name || "",
        photo_url: v.user.photo_url || ""
      },
      authDate: v.authDate
    });
  }

  // everything below requires auth
  const v = await validateInitData(getInitData(), BOT_TOKEN);
  if (!v.ok) return json({ ok: false, error: "unauthorized: " + v.error }, 401);
  const role = roleOf(Number(v.user.id), env);
  if (!role) return json({ ok: false, error: "forbidden: not in admin list" }, 403);
  const admin = adminName(v.user);
  const needOwner = () => {
    if (role !== "owner") return json({ ok: false, error: "forbidden: owner only" }, 403);
    return null;
  };
  const passError = (r) => json({ ok: false, error: r.error || "plugin error", offline: !!r.offline }, r.offline ? 502 : 400);

  // GET /api/status
  if (route === "status" && request.method === "GET") {
    if (MOCK) {
      return json({ ok: true, mock: true, status: { online: mockPlayers.length, max_players: 44, version: "1.21.50", uptime_sec: 151200, world: "Building Zone", tps: 19.8 } });
    }
    const r = await pluginCall(env, "/api/status");
    if (r.error) return passError(r);
    return json({ ok: true, status: r.data });
  }

  // GET /api/game/players
  if (route === "game/players" && request.method === "GET") {
    if (MOCK) return json({ ok: true, mock: true, players: mockPlayers });
    const r = await pluginCall(env, "/api/players");
    if (r.error) return passError(r);
    return json({ ok: true, players: r.data });
  }

  // GET /api/game/chat?since&limit&q - q triggers plugin search mode (search:true, cursor untouched)
  if (route === "game/chat" && request.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
    const q = (url.searchParams.get("q") || "").trim();
    if (MOCK) {
      if (q) {
        const needle = q.toLowerCase();
        const msgs = mockChat.filter((m) => ((m.player || "") + " " + (m.text || "")).toLowerCase().includes(needle)).slice(-limit);
        return json({ ok: true, mock: true, search: true, last_id: since, global_last: mockChatId, messages: msgs });
      }
      const msgs = mockChat.filter((m) => m.id > since).slice(-limit);
      return json({ ok: true, mock: true, last_id: mockChat.length ? mockChat[mockChat.length - 1].id : 0, global_last: mockChatId, messages: msgs });
    }
    const r = await pluginCall(env, `/api/chat?since=${since}&limit=${limit}` + (q ? `&q=${encodeURIComponent(q)}` : ""));
    if (r.error) return passError(r);
    return json({ ok: true, last_id: r.data.last_id, global_last: r.data.global_last, search: !!r.data.search, messages: r.data.messages });
  }

  // POST /api/game/chat {text}
  if (route === "game/chat" && request.method === "POST") {
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) return json({ ok: false, error: "empty text" }, 400);
    if (MOCK) {
      mockChat.push({ id: ++mockChatId, ts: Date.now() / 1000, type: "admin", player: admin, text });
      return json({ ok: true, mock: true, result: "отправлено в игровой чат", last_id: mockChatId });
    }
    const r = await pluginCall(env, "/api/chat", { method: "POST", body: { admin, text } });
    if (r.error) return passError(r);
    return json({ ok: true, result: r.data.result || "sent" });
  }

  // POST /api/game/kick|ban|alban|absoluter {name, reason?}
  if (segs[0] === "game" && segs.length === 2 && ["kick", "ban", "alban", "absoluter"].includes(segs[1]) && request.method === "POST") {
    const action = segs[1];
    const name = String(body.name || "").trim();
    const reason = String(body.reason || "").trim().slice(0, 300);
    if (!name) return json({ ok: false, error: "empty name" }, 400);
    if (MOCK) return json({ ok: true, mock: true, ...mockResult(action, admin, name, reason) });
    const r = await pluginCall(env, "/api/" + action, { method: "POST", body: { admin, name, reason } });
    if (r.error) return passError(r);
    return json({ ok: true, result: r.data.result || "done" });
  }

  // POST /api/game/unban {name} - owner only
  if (route === "game/unban" && request.method === "POST") {
    const denied = needOwner();
    if (denied) return denied;
    const name = String(body.name || "").trim();
    if (!name) return json({ ok: false, error: "empty name" }, 400);
    if (MOCK) return json({ ok: true, mock: true, ...mockResult("unban", admin, name, "") });
    const r = await pluginCall(env, "/api/unban", { method: "POST", body: { admin, name } });
    if (r.error) return passError(r);
    return json({ ok: true, result: r.data.result || "done" });
  }

  // GET /api/game/bans
  if (route === "game/bans" && request.method === "GET") {
    if (MOCK) return json({ ok: true, mock: true, bans: mockBans });
    const r = await pluginCall(env, "/api/bans");
    if (r.error) return passError(r);
    return json({ ok: true, bans: r.data });
  }

  // GET /api/game/plugins
  if (route === "game/plugins" && request.method === "GET") {
    if (MOCK) return json({ ok: true, mock: true, plugins: [{ name: "ocos", version: "1.3.0", enabled: true }] });
    const r = await pluginCall(env, "/api/plugins");
    if (r.error) return passError(r);
    return json({ ok: true, plugins: r.data });
  }

  // GET /api/game/audit - owner only
  if (route === "game/audit" && request.method === "GET") {
    const denied = needOwner();
    if (denied) return denied;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
    if (MOCK) return json({ ok: true, mock: true, audit: mockAudit.slice(0, limit) });
    const r = await pluginCall(env, `/api/audit?limit=${limit}`);
    if (r.error) return passError(r);
    return json({ ok: true, audit: r.data });
  }

  // GET /api/game/blocklog?x&y&z&dimension&limit
  if (route === "game/blocklog" && request.method === "GET") {
    const q = new URLSearchParams({
      x: url.searchParams.get("x") || "0",
      y: url.searchParams.get("y") || "0",
      z: url.searchParams.get("z") || "0",
      dimension: url.searchParams.get("dimension") || "Overworld",
      limit: String(Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 40))))
    }).toString();
    if (MOCK) {
      return json({
        ok: true,
        mock: true,
        entries: [
          { ts: Date.now() / 1000 - 7200, action: "place", player: "ltRealme2", block: "minecraft:soul_sand", old_block: "minecraft:air" },
          { ts: Date.now() / 1000 - 3600, action: "break", player: "ltRealme2", block: "minecraft:oak_log", old_block: "minecraft:oak_log" }
        ]
      });
    }
    const r = await pluginCall(env, "/api/blocklog?" + q);
    if (r.error) return passError(r);
    return json({ ok: true, entries: r.data });
  }

  // GET /api/game/find?q&limit - search among ALL known players (plugin 1.0.2)
  if (route === "game/find" && request.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(25, Math.max(1, Number(url.searchParams.get("limit") || 8)));
    if (MOCK) return json({ ok: true, mock: true, found: mockFind(q, limit) });
    const r = await pluginCall(env, `/api/find?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (r.error) return passError(r);
    return json({ ok: true, found: r.data });
  }

  // GET /api/game/metrics (plugin 1.1.0)
  if (route === "game/metrics" && request.method === "GET") {
    if (MOCK) return json({ ok: true, mock: true, metrics: mockMetricsData() });
    const r = await pluginCall(env, "/api/metrics");
    if (r.error) return passError(r);
    return json({ ok: true, metrics: r.data });
  }

  // GET /api/game/power - rights are personal, nick from Telegram profile (plugin 1.2.0)
  if (route === "game/power" && request.method === "GET") {
    const nick = powerNick(v.user);
    if (MOCK) {
      return json({ ok: true, mock: true, power: {
        can_stop: true, can_restart: true, can_start: false, power_enabled: true,
        you: nick, you_allowed: true, deny_reason: "", locked_by_owner: false,
        start_hint: "Запуск возможен только из панели хостинга: когда сервер выключен, плагин не работает и принять команду не может.",
        host_panel_url: "https://panel.superhub.host/",
        allowed_admins: [nick], owners: ["oxxygen"]
      } });
    }
    const r = await pluginCall(env, "/api/power?admin=" + encodeURIComponent(nick));
    if (r.error) return passError(r);
    return json({ ok: true, power: r.data });
  }

  // POST /api/game/power {action} - plugin is the authority, any authed role may ask
  if (route === "game/power" && request.method === "POST") {
    const action = String(body.action || "");
    if (action !== "restart" && action !== "stop") return json({ ok: false, error: "bad action" }, 400);
    const nick = powerNick(v.user);
    if (MOCK) {
      return json({ ok: true, mock: true, result: action === "restart"
        ? "сервер перезапустится через 5 сек. (если хостинг настроен на автоподъём)"
        : "сервер остановится через 5 сек." });
    }
    const r = await pluginCall(env, "/api/power", { method: "POST", body: { admin: nick, action } });
    if (r.error) return passError(r);
    return json({ ok: true, result: r.data.result || "done" });
  }

  // GET /api/notes?name - admin notes (KV or memory)
  if (route === "notes" && request.method === "GET") {
    const name = String(url.searchParams.get("name") || "").trim();
    if (!name) return json({ ok: false, error: "empty name" }, 400);
    const list = await notesGet(env, name);
    return json({ ok: true, notes: list, storage: env.NOTES_KV ? "kv" : "memory" });
  }

  // POST /api/notes {name, text}
  if (route === "notes" && request.method === "POST") {
    const name = String(body.name || "").trim();
    const text = String(body.text || "").trim().slice(0, 500);
    if (!name || !text) return json({ ok: false, error: "empty name or text" }, 400);
    const note = { ts: Date.now() / 1000, by: admin, text };
    const r = await notesAdd(env, name, note);
    return json({ ok: true, note, storage: r.storage });
  }

  return json({ ok: false, error: "not found: /api/" + route }, 404);
}
