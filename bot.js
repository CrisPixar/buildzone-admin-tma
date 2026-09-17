// BuildZone Admin bot: /start gate, panel button, owner request stats.
// Long polling inside the Render Node service (started from server.js).
// Env: BOT_TOKEN, OWNER_IDS, MODERATOR_IDS (ADMIN_IDS = legacy alias), PANEL_URL.
// Local runs must keep ENABLE_BOT empty or they steal updates from prod.

const TG = "https://api.telegram.org/bot";
const DENIED = "Не-авторизованный запрос";
const HELLO = "Здравия желаю";

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

// Pure: reply for /start. Panel button needs PANEL_URL, stats button is owner-only.
function buildStartReply(role) {
  if (!role) return { text: DENIED };
  const panelUrl = String(process.env.PANEL_URL || "").trim();
  const rows = [];
  if (panelUrl) rows.push([{ text: "Открыть панель", web_app: { url: panelUrl } }]);
  if (role === "owner") rows.push([{ text: "Статистика", callback_data: "stats" }]);
  const out = { text: HELLO };
  if (rows.length) out.reply_markup = { inline_keyboard: rows };
  return out;
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

// Pure: stats object from server.js -> message text.
function formatStats(s) {
  const lines = [
    "Статистика запросов к сайту",
    `Время работы: ${fmtUptime(s.uptime_sec)}`,
    `Всего запросов: ${s.total}`,
    `Ошибки: 4xx - ${s.err4xx}, 5xx - ${s.err5xx}`
  ];
  if (s.by_route && s.by_route.length) {
    lines.push("Топ эндпоинтов:");
    s.by_route.forEach(([k, c]) => lines.push(`${k} - ${c}`));
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
      const reply = buildStartReply(roleOfId(Number(from.id)));
      await tgCall(token, "sendMessage", Object.assign({ chat_id: u.message.chat.id }, reply));
    }
    return;
  }
  if (u.callback_query) {
    const cq = u.callback_query;
    const role = roleOfId(Number(cq.from && cq.from.id));
    if (cq.data === "stats" && role === "owner") {
      await tgCall(token, "answerCallbackQuery", { callback_query_id: cq.id });
      await tgCall(token, "sendMessage", { chat_id: cq.message.chat.id, text: formatStats(getStats()) });
    } else {
      await tgCall(token, "answerCallbackQuery", { callback_query_id: cq.id, text: DENIED });
    }
  }
}

function startBot(getStats) {
  const token = String(process.env.BOT_TOKEN || "");
  if (!token) {
    console.log("[bot] BOT_TOKEN empty, polling not started");
    return { stop() {} };
  }
  if (!String(process.env.PANEL_URL || "").trim()) {
    console.log("[bot] warning: PANEL_URL empty, panel button will be hidden");
  }
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

module.exports = { startBot, buildStartReply, formatStats, roleOfId };
