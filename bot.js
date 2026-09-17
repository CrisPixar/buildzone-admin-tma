// BuildZone Admin bot: /start gate, panel button, owner request stats.
// Long polling inside the Render Node service (started from server.js).
// Env: BOT_TOKEN, OWNER_IDS, MODERATOR_IDS (ADMIN_IDS = legacy alias).
// PANEL_URL overrides the default panel address below.
// Polling is ON by default. Local runs must set ENABLE_BOT=0 or they steal updates from prod.
//
// Button facts (Bot API docs): an inline web_app button opens any HTTPS URL,
// no BotFather registration needed, but it only works in private chats
// between the user and the bot (in groups Telegram answers BUTTON_TYPE_INVALID).

const TG = "https://api.telegram.org/bot";
const DENIED = "Не-авторизованный запрос";
const DEFAULT_PANEL_URL = "https://api.buildzone.lol/";

function parseIds(s) {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isSafeInteger(n));
}

function roleOfId(uid) {
  const owners = parseIds(process.env.OWNER_IDS);
  const mods = [...parseIds(process.env.MODERATOR_IDS), ...parseIds(process.env.ADMIN_IDS)];
  if (owners.includes(uid)) return "owner";
  if (mods.includes(uid)) return "moderator";
  return null;
}

function panelUrl() {
  return String(process.env.PANEL_URL || "").trim() || DEFAULT_PANEL_URL;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function roleLabel(role) {
  return role === "owner" ? "Владелец" : "Модератор";
}

// Pure: reply for /start. Panel button is always present, stats is owner-only.
function buildStartReply(role, name) {
  if (!role) return { text: DENIED };
  const safe = escapeHtml(name || "админ");
  const text = `👋 <b>Здравия желаю, ${safe}!</b>\n\n🛡 Роль: <b>${roleLabel(role)}</b>\n🧱 Сервер: <b>Building Zone</b>\n\nЖми кнопку ниже, чтобы открыть панель управления.`;
  const rows = [[{ text: "🌐 Открыть панель", web_app: { url: panelUrl() } }]];
  if (role === "owner") rows.push([{ text: "📊 Статистика", callback_data: "stats" }]);
  return { text, parse_mode: "HTML", reply_markup: { inline_keyboard: rows } };
}

function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} д ${h} ч ${m} м`;
  if (h > 0) return `${h} ч ${m} м`;
  return `${m} м`;
}

// Pure: stats object from server.js -> message text (HTML).
function formatStats(s) {
  const lines = [
    "📊 <b>Статистика запросов к сайту</b>",
    "",
    `⏱ Время работы: <b>${fmtUptime(s.uptime_sec)}</b>`,
    `📥 Всего запросов: <b>${s.total}</b>`,
    `⚠️ Ошибки: 4xx - <b>${s.err4xx}</b>, 5xx - <b>${s.err5xx}</b>`
  ];
  if (s.by_route && s.by_route.length) {
    lines.push("", "<b>Топ эндпоинтов:</b>");
    s.by_route.forEach(([k, c]) => lines.push(`<code>${escapeHtml(k)}</code> - ${c}`));
  }
  return lines.join("\n");
}

async function tgCall(token, method, body) {
  const res = await fetch(`${TG}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    throw new Error(`telegram ${method}: ${res.status} ${data && data.description ? data.description : ""}`.trim());
  }
  return data.result;
}

async function handleUpdate(token, getStats, u) {
  if (u.message && typeof u.message.text === "string") {
    const cmd = u.message.text.trim().split(/\s/)[0];
    if (cmd === "/start" || cmd.startsWith("/start@")) {
      const from = u.message.from || {};
      const name = from.first_name || (from.username ? "@" + from.username : "") || "админ";
      const reply = buildStartReply(roleOfId(Number(from.id)), name);
      await tgCall(token, "sendMessage", Object.assign({ chat_id: u.message.chat.id }, reply));
    }
    return;
  }
  if (u.callback_query) {
    const cq = u.callback_query;
    const role = roleOfId(Number(cq.from && cq.from.id));
    if (cq.data === "stats" && role === "owner") {
      await tgCall(token, "answerCallbackQuery", { callback_query_id: cq.id });
      await tgCall(token, "sendMessage", { chat_id: cq.message.chat.id, text: formatStats(getStats()), parse_mode: "HTML" });
    } else {
      await tgCall(token, "answerCallbackQuery", { callback_query_id: cq.id, text: DENIED });
    }
  }
}

// Best-effort bot profile design. Idempotent, never blocks polling.
async function setupProfile(token) {
  const jobs = [
    ["setMyShortDescription", { short_description: "Панель управления сервером Building Zone. Жми /start." }],
    ["setMyDescription", { description: "Building Zone - Admin Panel.\n\n/start - открыть панель управления (только для админов).\nВладелец также видит статистику запросов к сайту." }]
  ];
  for (const [method, body] of jobs) {
    try {
      await tgCall(token, method, body);
      console.log(`[bot] profile ${method} ok`);
    } catch (e) {
      console.log(`[bot] profile ${method} skipped:`, e.message);
    }
  }
}

function startBot(getStats) {
  const token = String(process.env.BOT_TOKEN || "");
  if (!token) {
    console.log("[bot] BOT_TOKEN empty, polling not started");
    return { stop() {} };
  }
  console.log("[bot] panel url:", panelUrl());
  setupProfile(token).catch(() => {});
  let stop = false;
  let offset = 0;
  (async () => {
    console.log("[bot] polling started");
    while (!stop) {
      try {
        const updates = await tgCall(token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
        for (const u of updates || []) {
          offset = Math.max(offset, (u.update_id || 0) + 1);
          try {
            await handleUpdate(token, getStats, u);
          } catch (e) {
            console.log("[bot] update error:", e.message);
          }
        }
      } catch (e) {
        console.log("[bot] poll error:", e.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
  return { stop() { stop = true; } };
}

module.exports = { startBot, buildStartReply, formatStats, roleOfId, panelUrl };
