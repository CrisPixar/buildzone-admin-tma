// BuildZone Admin TMA - backend
// Node.js + Express backend with Telegram initData validation (HMAC-SHA256)
// Stack: HTML/CSS/JS frontend in ./public, this file is the API + static server

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isSafeInteger(n));

if (!BOT_TOKEN) {
  console.warn("[warn] BOT_TOKEN is empty. Set it in .env . Auth will fail until set.");
}
if (ADMIN_IDS.length === 0) {
  console.warn("[warn] ADMIN_IDS is empty. No user will get admin access until set.");
}

app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Telegram initData validation ----------

// Parse initData query string into plain object
function parseInitData(initData) {
  const params = new URLSearchParams(initData || "");
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

// Validate hash per Telegram docs:
// secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
// data_check_string = sort keys (except hash), join as "key=value" with \n
// computed = HMAC_SHA256(key=secret_key, msg=data_check_string)
function validateInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) {
    return { ok: false, error: "missing initData or bot token" };
  }
  const data = parseInitData(initData);
  const receivedHash = data.hash || "";
  if (!receivedHash) return { ok: false, error: "missing hash" };
  delete data.hash;

  const dataCheckString = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // timing-safe compare
  const a = Buffer.from(computedHash, "utf8");
  const b = Buffer.from(receivedHash, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "bad hash" };
  }

  // check auth_date freshness (anti-replay)
  const authDate = Number(data.auth_date || 0);
  if (!authDate) return { ok: false, error: "missing auth_date" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - authDate) > maxAgeSec) {
    return { ok: false, error: "initData expired" };
  }

  let user = null;
  try {
    user = JSON.parse(data.user || "null");
  } catch (e) {
    return { ok: false, error: "bad user json" };
  }
  if (!user || !user.id) return { ok: false, error: "missing user" };

  return { ok: true, user, authDate, raw: data };
}

function getInitDataFromReq(req) {
  // priority: Authorization header, x-telegram-init-data header, body.initData, query initData
  const h1 = req.headers["x-telegram-init-data"];
  if (h1) return String(h1);
  const auth = req.headers["authorization"] || "";
  if (typeof auth === "string" && auth.startsWith("tma ")) return auth.slice(4);
  if (req.body && req.body.initData) return String(req.body.initData);
  if (req.query && req.query.initData) return String(req.query.initData);
  return "";
}

// Auth middleware: validates initData and admin allow-list
function requireAdmin(req, res, next) {
  const initData = getInitDataFromReq(req);
  const v = validateInitData(initData, BOT_TOKEN);
  if (!v.ok) {
    return res.status(401).json({ ok: false, error: "unauthorized: " + v.error });
  }
  const uid = Number(v.user.id);
  if (!ADMIN_IDS.includes(uid)) {
    return res.status(403).json({ ok: false, error: "forbidden: not in ADMIN_IDS", user: { id: uid } });
  }
  req.tgUser = v.user;
  req.tgAuthDate = v.authDate;
  next();
}

// ---------- Demo in-memory data (replace with real DB) ----------

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

// ---------- API ----------

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "buildzone-admin-tma", time: new Date().toISOString() });
});

// Transparent login: frontend sends initData, backend validates hash + admin list
app.post("/api/auth", (req, res) => {
  const initData = getInitDataFromReq(req);
  const v = validateInitData(initData, BOT_TOKEN);
  if (!v.ok) {
    return res.status(401).json({ ok: false, error: "unauthorized: " + v.error });
  }
  const uid = Number(v.user.id);
  const isAdmin = ADMIN_IDS.includes(uid);
  if (!isAdmin) {
    return res.status(403).json({
      ok: false,
      error: "forbidden: your Telegram ID is not in admin list",
      user: { id: uid, username: v.user.username || "", first_name: v.user.first_name || "" }
    });
  }
  pushLog(v.user.username || String(uid), "admin.login", "TMA auth ok");
  return res.json({
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
});

// All routes below require valid admin initData
app.get("/api/stats", requireAdmin, (req, res) => {
  const online = demoPlayers.filter((p) => p.status === "online").length;
  res.json({
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
});

app.get("/api/players", requireAdmin, (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  let list = demoPlayers;
  if (q) list = list.filter((p) => p.nick.toLowerCase().includes(q) || String(p.tgId).includes(q));
  res.json({ ok: true, players: list });
});

app.post("/api/players/:id/ban", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const p = demoPlayers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ ok: false, error: "player not found" });
  p.banned = true;
  p.status = "banned";
  pushLog(req.tgUser.username || String(req.tgUser.id), "player.ban", `${p.nick} banned. reason: ${req.body.reason || "no reason"}`);
  res.json({ ok: true, player: p });
});

app.post("/api/players/:id/unban", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const p = demoPlayers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ ok: false, error: "player not found" });
  p.banned = false;
  p.status = "offline";
  pushLog(req.tgUser.username || String(req.tgUser.id), "player.unban", `${p.nick} unbanned`);
  res.json({ ok: true, player: p });
});

app.post("/api/broadcast", requireAdmin, (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "empty text" });
  if (text.length > 1000) return res.status(400).json({ ok: false, error: "text too long (max 1000)" });
  // TODO: integrate real send via Bot API (sendMessage to channel or player list)
  pushLog(req.tgUser.username || String(req.tgUser.id), "broadcast.send", text.slice(0, 120));
  res.json({ ok: true, sent: 1840, preview: text.slice(0, 140) });
});

app.get("/api/logs", requireAdmin, (req, res) => {
  res.json({ ok: true, logs: demoLogs.slice(0, 100) });
});

// SPA fallback for any non-API route
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`[ok] BuildZone Admin TMA running on :${PORT}`);
  console.log(`[ok] Admins configured: ${ADMIN_IDS.length}`);
});

module.exports = { app, validateInitData, parseInitData };
