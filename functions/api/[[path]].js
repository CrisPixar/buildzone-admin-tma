// BuildZone Admin TMA - Cloudflare Pages Functions backend
// Catch-all route for /api/* with Telegram initData validation (HMAC-SHA256 via WebCrypto)
// Env vars (Pages dashboard - Settings - Environment Variables): BOT_TOKEN, ADMIN_IDS

// ---------- demo in-memory data (per isolate, replace with KV/D1 for real) ----------

const demoPlayers = [
  { id: 1, nick: "Padjilloi", tgId: 111111111, status: "online", level: 42, builds: 128, lastSeen: "now", banned: false },
  { id: 2, nick: "AstutePlot58", tgId: 222222222, status: "online", level: 37, builds: 96, lastSeen: "now", banned: false },
  { id: 3, nick: "Dezik9410", tgId: 333333333, status: "offline", level: 51, builds: 210, lastSeen: "12 min ago", banned: false },
  { id: 4, nick: "WaryMold3335", tgId: 444444444, status: "offline", level: 29, builds: 54, lastSeen: "1 h ago", banned: false },
  { id: 5, nick: "UniBlock", tgId: 555555555, status: "banned", level: 15, builds: 11, lastSeen: "3 d ago", banned: true }
];

const demoLogs = [
  { ts: Date.now() - 1000 * 60 * 2, actor: "system", action: "server.online", detail: "124 players online" },
  { ts: Date.now() - 1000 * 60 * 14, actor: "Padjilloi", action: "build.approved", detail: "Spawn plaza v3" },
  { ts: Date.now() - 1000 * 60 * 47, actor: "moderation", action: "grief.rollback", detail: "12 chunks restored" },
  { ts: Date.now() - 1000 * 60 * 90, actor: "Dezik9410", action: "player.warn", detail: "spam in chat" }
];

function pushLog(actor, action, detail) {
  demoLogs.unshift({ ts: Date.now(), actor, action, detail: String(detail || "").slice(0, 300) });
  if (demoLogs.length > 200) demoLogs.length = 200;
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

// ---------- router ----------

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const BOT_TOKEN = (env && env.BOT_TOKEN) || "";
  const ADMIN_IDS = String((env && env.ADMIN_IDS) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n));

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

  const needAdmin = async () => {
    const v = await validateInitData(getInitData(), BOT_TOKEN);
    if (!v.ok) return { error: json({ ok: false, error: "unauthorized: " + v.error }, 401) };
    const uid = Number(v.user.id);
    if (!ADMIN_IDS.includes(uid)) {
      return { error: json({ ok: false, error: "forbidden: not in ADMIN_IDS", user: { id: uid } }, 403) };
    }
    return { user: v.user, authDate: v.authDate };
  };

  // GET /api/health
  if (route === "health" && request.method === "GET") {
    return json({ ok: true, service: "buildzone-admin-tma-pages", time: new Date().toISOString() });
  }

  // POST /api/auth
  if (route === "auth" && request.method === "POST") {
    const v = await validateInitData(getInitData(), BOT_TOKEN);
    if (!v.ok) return json({ ok: false, error: "unauthorized: " + v.error }, 401);
    const uid = Number(v.user.id);
    if (!ADMIN_IDS.includes(uid)) {
      return json({
        ok: false,
        error: "forbidden: your Telegram ID is not in admin list",
        user: { id: uid, username: v.user.username || "", first_name: v.user.first_name || "" }
      }, 403);
    }
    pushLog(v.user.username || String(uid), "admin.login", "TMA auth ok (pages)");
    return json({
      ok: true,
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

  // GET /api/stats
  if (route === "stats" && request.method === "GET") {
    const a = await needAdmin();
    if (a.error) return a.error;
    const online = demoPlayers.filter((p) => p.status === "online").length;
    return json({
      ok: true,
      stats: {
        online: 124 + online,
        playersTotal: 1840,
        buildsTotal: 632,
        uptime: "99.9%",
        season: 3,
        pendingReports: 4,
        todayJoins: 37
      }
    });
  }

  // GET /api/players
  if (route === "players" && request.method === "GET") {
    const a = await needAdmin();
    if (a.error) return a.error;
    const q = String(url.searchParams.get("q") || "").toLowerCase();
    let list = demoPlayers;
    if (q) list = list.filter((p) => p.nick.toLowerCase().includes(q) || String(p.tgId).includes(q));
    return json({ ok: true, players: list });
  }

  // POST /api/players/:id/ban and /unban
  if (segs[0] === "players" && segs.length === 3 && (segs[2] === "ban" || segs[2] === "unban") && request.method === "POST") {
    const a = await needAdmin();
    if (a.error) return a.error;
    const id = Number(segs[1]);
    const p = demoPlayers.find((x) => x.id === id);
    if (!p) return json({ ok: false, error: "player not found" }, 404);
    if (segs[2] === "ban") {
      p.banned = true;
      p.status = "banned";
      pushLog(a.user.username || String(a.user.id), "player.ban", `${p.nick} banned. reason: ${body.reason || "no reason"}`);
    } else {
      p.banned = false;
      p.status = "offline";
      pushLog(a.user.username || String(a.user.id), "player.unban", `${p.nick} unbanned`);
    }
    return json({ ok: true, player: p });
  }

  // POST /api/broadcast
  if (route === "broadcast" && request.method === "POST") {
    const a = await needAdmin();
    if (a.error) return a.error;
    const text = String(body.text || "").trim();
    if (!text) return json({ ok: false, error: "empty text" }, 400);
    if (text.length > 1000) return json({ ok: false, error: "text too long (max 1000)" }, 400);
    pushLog(a.user.username || String(a.user.id), "broadcast.send", text.slice(0, 120));
    return json({ ok: true, sent: 1840, preview: text.slice(0, 140) });
  }

  // GET /api/logs
  if (route === "logs" && request.method === "GET") {
    const a = await needAdmin();
    if (a.error) return a.error;
    return json({ ok: true, logs: demoLogs.slice(0, 100) });
  }

  return json({ ok: false, error: "not found: /api/" + route }, 404);
}
