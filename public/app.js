// BuildZone Admin Panel - frontend (plugin 1.2.0: metrics + power)
// Pages: players, chat, bans, plugins, audit, metrics, power
// Auth: Telegram.WebApp.initData -> POST /api/auth (role: owner | moderator)

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const BUILD = "b11-power";
  // Backend lives on Render behind a custom domain (CF Pages cannot call
  // the plugin IP directly - edge answers 1003). Same-origin fallback: "".
  const API_BASE = "https://api.buildzone.lol";

  const state = {
    initData: "",
    user: null,
    role: null,
    mock: false,
    demo: new URLSearchParams(location.search).get("demo") === "1",
    players: [],
    bans: [],
    chatLog: [],
    chatLastId: 0,
    chatFilter: "all",
    chatInit: false,
    chatInflight: false,
    playersInflight: false,
    playersInit: false,
    atBottom: true,
    pendingNew: 0,
    pmNick: null,
    lastOnline: 0,
    waiting: false,
    power: null
  };

  const shownIds = new Set();
  const rowByKey = new Map();

  function haptic(kind) {
    try {
      if (tg && tg.HapticFeedback) {
        if (kind === "ok") tg.HapticFeedback.notificationOccurred("success");
        else if (kind === "err") tg.HapticFeedback.notificationOccurred("error");
        else tg.HapticFeedback.impactOccurred("light");
      }
    } catch (e) { /* noop */ }
  }

  /* ---------- text utils: escape + Bedrock color codes ---------- */

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  const MC_COLORS = {
    "0": "#000000", "1": "#0000aa", "2": "#00aa00", "3": "#00aaaa",
    "4": "#aa0000", "5": "#aa00aa", "6": "#ffaa00", "7": "#aaaaaa",
    "8": "#555555", "9": "#5555ff", "a": "#55ff55", "b": "#55ffff",
    "c": "#ff5555", "d": "#ff55ff", "e": "#ffff55", "f": "#ffffff",
    "g": "#ffd76a", "h": "#e8b8ff", "i": "#a0e8ff", "j": "#b8ff9e",
    "m": "#9ad8ff", "n": "#8affc1", "o": "#303030", "p": "#ff9e8a",
    "q": "#ff5f57", "s": "#ff6b4a", "t": "#fe8e68", "u": "#fdab72"
  };

  // escape first (XSS), then turn section-sign codes into spans
  function colorize(s) {
    const esc = escapeHtml(s);
    let out = "";
    let open = 0;
    const push = (code) => {
      if (code === "r") {
        out += "</span>".repeat(open);
        open = 0;
        return;
      }
      const c = MC_COLORS[code.toLowerCase()];
      if (c) {
        out += `<span style="color:${c}">`;
        open++;
        return;
      }
      const st = { l: "font-weight:700", m: "text-decoration:line-through", n: "text-decoration:underline", o: "font-style:italic" }[code.toLowerCase()];
      if (st) {
        out += `<span style="${st}">`;
        open++;
      }
    };
    for (let i = 0; i < esc.length; i++) {
      if (esc[i] === "§" && i + 1 < esc.length) {
        push(esc[i + 1]);
        i++;
      } else {
        out += esc[i];
      }
    }
    out += "</span>".repeat(open);
    return out;
  }

  function stripCodes(s) {
    return String(s == null ? "" : s).replace(/§./g, "");
  }

  function num(v, digits) {
    if (v == null || isNaN(Number(v))) return null;
    return Number(v).toLocaleString("ru-RU", { maximumFractionDigits: digits == null ? 1 : digits });
  }

  function fmtTime(ts) {
    try {
      return new Date(Number(ts) * 1000).toLocaleString("ru-RU", { hour12: false, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  function fmtHM(ts) {
    try {
      return new Date(Number(ts) * 1000).toLocaleString("ru-RU", { hour12: false, hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  function fmtUptime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}д ${h}ч`;
    if (h > 0) return `${h}ч ${m}м`;
    return `${m}м`;
  }

  function fmtUptimeFull(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d} д ${h} ч ${m} м`;
    if (h > 0) return `${h} ч ${m} м`;
    return `${m} м`;
  }

  function fmtBytes(b) {
    if (b == null || isNaN(Number(b))) return "неизвестно";
    b = Number(b);
    if (b >= 1073741824) return `${(b / 1073741824).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ`;
    if (b >= 1048576) return `${Math.round(b / 1048576)} МБ`;
    if (b >= 1024) return `${Math.round(b / 1024)} КБ`;
    return `${b} Б`;
  }

  function barColor(pct) {
    if (pct == null) return "";
    if (pct >= 90) return "bad";
    if (pct >= 70) return "warn";
    return "";
  }

  /* ---------- preloader / net / offline ---------- */

  function preSet(pct, label) {
    const fill = $("pre-fill");
    const count = $("pre-count");
    if (fill) fill.style.width = pct + "%";
    if (count) count.textContent = (label || "auth") + " " + String(Math.round(pct)).padStart(3, "0") + " %";
  }

  function preDone() {
    const pre = $("preloader");
    if (!pre) return;
    preSet(100, "done");
    setTimeout(() => pre.classList.add("done"), 250);
  }

  function setNet(mode, text) {
    const box = $("netStatus");
    if (!box) return;
    box.classList.toggle("on", mode === "on");
    box.classList.toggle("bad", mode === "bad");
    const t = $("netStatusText");
    if (t) t.textContent = text || mode;
  }

  function setOffline(on, text) {
    const b = $("offlineBanner");
    if (!b) return;
    b.hidden = !on;
    if (on && text) $("offlineText").textContent = text;
  }

  /* ---------- api ---------- */

  async function api(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (state.initData) headers["X-Telegram-Init-Data"] = state.initData;
    const res = await fetch(API_BASE + path, Object.assign({}, opts, { headers }));
    const raw = await res.text().catch(() => "");
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("http " + res.status));
      err.status = res.status;
      err.data = data;
      err.offline = !!(data && data.offline);
      err.debug = "http " + res.status + " - body: " + (raw ? raw.slice(0, 200) : "(empty)");
      throw err;
    }
    setOffline(false);
    return data;
  }

  function noteOffline(e) {
    if (e && e.offline) {
      setOffline(true, "Сервер офлайн - плагин недоступен. Показаны последние данные.");
      return true;
    }
    return false;
  }

  /* ---------- screens ---------- */

  function showDenied(msg, id, debug) {
    preDone();
    setTimeout(() => {
      $("app").hidden = true;
      $("bottomNav").hidden = true;
      $("screenDenied").hidden = false;
      if (msg) $("deniedText").textContent = msg;
      $("deniedId").textContent = "id: " + (id || (state.user && state.user.id) || "-");
      const dbg = $("deniedDebug");
      if (dbg) {
        if (debug) {
          dbg.textContent = debug;
          dbg.hidden = false;
        } else {
          dbg.hidden = true;
        }
      }
      setNet("bad", "denied");
      haptic("err");
    }, 500);
  }

  function showApp(user, role, mock) {
    preDone();
    setTimeout(() => {
      $("screenDenied").hidden = true;
      $("app").hidden = false;
      $("bottomNav").hidden = false;
      setNet("on", "online");
      const chip = $("userChip");
      chip.hidden = false;
      $("userName").textContent = user.first_name || user.username || ("id " + user.id);
      if (user.photo_url) {
        const img = $("userAvatar");
        img.src = user.photo_url;
        img.hidden = false;
      }
      const pill = $("rolePill");
      pill.hidden = false;
      pill.textContent = role === "owner" ? "Владелец" : "Модератор";
      pill.classList.toggle("owner", role === "owner");
      if (role !== "owner") {
        ["audit", "auditNav", "auditTab"].forEach((id) => {
          const el = $(id);
          if (el) el.style.display = "none";
        });
      }
      // power section visibility is decided by plugin answer in loadPower
      ["power", "powerNav", "powerTab"].forEach((id) => {
        const el = $(id);
        if (el) el.style.display = "none";
      });
      if (mock) {
        const mb = $("mockBadge");
        if (mb) mb.hidden = false;
      }
      initReveal();
      refreshAll();
      startPollers();
    }, 500);
  }

  async function doAuth() {
    $("screenDenied").hidden = true;
    preSet(18, "auth");

    if (state.demo && !state.initData) {
      preSet(70, "demo");
      state.role = "owner";
      state.mock = true;
      showApp({ id: 0, first_name: "Demo Admin", username: "demo" }, "owner", true);
      return;
    }

    if (!state.initData) {
      showDenied("Открой приложение кнопкой бота в Telegram (initData не найден).", "-", "build " + BUILD + "\ninitData: MISSING");
      return;
    }
    try {
      preSet(55, "verify");
      const r = await api("/api/auth", {
        method: "POST",
        body: JSON.stringify({ initData: state.initData })
      });
      preSet(88, "welcome");
      state.user = r.user;
      state.role = r.role;
      state.mock = !!r.mock;
      showApp(r.user, r.role, state.mock);
      haptic("ok");
    } catch (e) {
      const uid = e.data && e.data.user ? e.data.user.id : "-";
      let msg = e.message || "auth failed";
      if (e.status === 404 || e.status === 405) {
        msg = "Backend API missing (http " + e.status + ") - deploy backend, then retry.";
      }
      if (e instanceof TypeError) {
        msg = "Backend unreachable - check API_BASE and hosting.";
      }
      const dbg = "build " + BUILD +
        "\napi: " + (API_BASE || "(same origin)") +
        "\ninitData: " + (state.initData ? state.initData.length + " chars" : "MISSING") +
        "\n" + (e.debug || msg);
      showDenied(msg, uid, dbg);
    }
  }

  /* ---------- players ---------- */

  async function loadStatus() {
    try {
      const r = await api("/api/status");
      const s = r.status || {};
      state.lastOnline = Number(s.online || 0);
      $("sbOnline").textContent = `${s.online ?? "-"} / ${s.max_players ?? "-"}`;
      $("sbVersion").textContent = s.version || "-";
      $("sbTps").textContent = s.tps ?? "-";
      $("sbUptime").textContent = fmtUptime(s.uptime_sec);
      $("sbWorld").textContent = s.world || "-";
      return true;
    } catch (e) {
      if (!noteOffline(e)) {
        $("sbOnline").textContent = "err";
      }
      return false;
    }
  }

  const ACTIONS = [
    { id: "kick", label: "Кикнуть", needReason: true },
    { id: "ban", label: "Забанить", needReason: true },
    { id: "alban", label: "Alban", needReason: true },
    { id: "absoluter", label: "Absoluter", needReason: false }
  ];

  function playerKey(name) {
    return stripCodes(name).toLowerCase();
  }

  function playerPrint(p) {
    return JSON.stringify([p.name, p.os, p.gamemode, p.ping, p.x, p.y, p.z, p.health, p.is_op]);
  }

  function buildPlayerRow(p) {
    const tr = document.createElement("tr");
    const nickTd = document.createElement("td");
    const nickBtn = document.createElement("button");
    nickBtn.type = "button";
    nickBtn.className = "nick-btn";
    nickBtn.onclick = () => openPlayer(p.name);
    nickTd.appendChild(nickBtn);
    tr.appendChild(nickTd);
    const cellOs = document.createElement("td");
    const cellGm = document.createElement("td");
    const cellPing = document.createElement("td");
    const cellXyz = document.createElement("td");
    tr.append(cellOs, cellGm, cellPing, cellXyz);
    const actTd = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "act-row";
    ACTIONS.forEach((a) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-mini danger";
      b.textContent = a.label;
      b.onclick = () => askConfirm(a, p.name);
      wrap.appendChild(b);
    });
    actTd.appendChild(wrap);
    tr.appendChild(actTd);
    tr._cells = { nickBtn, cellOs, cellGm, cellPing, cellXyz };
    paintPlayerRow(tr, p);
    return tr;
  }

  function paintPlayerRow(tr, p) {
    const c = tr._cells;
    c.nickBtn.innerHTML = colorize(p.name) + (p.is_op ? "<small>OP</small>" : `<small>${escapeHtml(p.os || "")}</small>`);
    c.cellOs.textContent = p.os || "-";
    c.cellGm.textContent = p.gamemode || "-";
    c.cellPing.textContent = String(p.ping ?? "-");
    c.cellXyz.textContent = `${p.x} ${p.y} ${p.z}`;
    tr._print = playerPrint(p);
  }

  function updatePlayersTable() {
    const tBody = $("playersBody");
    if (!state.playersInit) {
      state.playersInit = true;
      tBody.innerHTML = "";
      rowByKey.clear();
    }
    const seen = new Set();
    state.players.forEach((p) => {
      const key = playerKey(p.name);
      seen.add(key);
      const print = playerPrint(p);
      let tr = rowByKey.get(key);
      if (!tr) {
        tr = buildPlayerRow(p);
        rowByKey.set(key, tr);
        tBody.appendChild(tr);
      } else if (tr._print !== print || tr._name !== p.name) {
        tr._name = p.name;
        paintPlayerRow(tr, p);
      }
    });
    for (const [key, tr] of rowByKey) {
      if (!seen.has(key)) {
        tr.remove();
        rowByKey.delete(key);
      }
    }
    if (!state.players.length) {
      tBody.innerHTML = '<tr><td colspan="6" class="td-muted">Никого онлайн.</td></tr>';
      state.playersInit = false;
      rowByKey.clear();
    }
    $("playersCount").textContent = String(state.players.length);
  }

  async function loadPlayers() {
    if (state.playersInflight) return;
    state.playersInflight = true;
    try {
      const r = await api("/api/game/players");
      state.players = r.players || [];
      updatePlayersTable();
    } catch (e) {
      if (!noteOffline(e) && !state.playersInit) {
        $("playersBody").innerHTML = '<tr><td colspan="6" class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</td></tr>";
      }
    } finally {
      state.playersInflight = false;
    }
  }

  /* ---------- chat ---------- */

  const SYS_TEXT = { join: "зашел на сервер", quit: "вышел с сервера", death: "погиб" };

  function chatVisible(m) {
    const f = state.chatFilter;
    const q = $("chatSearch").value.trim().toLowerCase();
    if (f === "chat" && m.type !== "chat") return false;
    if (f === "events" && m.type !== "join" && m.type !== "quit" && m.type !== "death") return false;
    if (f === "admin" && m.type !== "admin") return false;
    if (q) {
      const hay = (stripCodes(m.player) + " " + stripCodes(m.text)).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function chatMsgNode(m) {
    const d = document.createElement("div");
    const sys = m.type === "join" || m.type === "quit" || m.type === "death";
    d.className = "msg t-" + (m.type || "chat") + (sys ? " sys" : "");
    const time = document.createElement("span");
    time.className = "m-time";
    time.textContent = fmtHM(m.ts);
    time.title = fmtTime(m.ts);
    d.appendChild(time);
    if (sys) {
      const t = document.createElement("span");
      t.className = "m-text";
      t.innerHTML = colorize(m.player || "") + " - " + (SYS_TEXT[m.type] || m.type) +
        (m.type === "death" && m.text ? ": " + colorize(m.text) : "");
      d.appendChild(t);
    } else {
      const nick = document.createElement("button");
      nick.type = "button";
      nick.className = "m-nick";
      nick.innerHTML = colorize(m.player || "");
      nick.title = stripCodes(m.player || "");
      nick.onclick = () => openPlayer(m.player);
      d.appendChild(nick);
      const t = document.createElement("span");
      t.className = "m-text";
      t.innerHTML = colorize(m.text || "");
      d.appendChild(t);
    }
    return d;
  }

  function fullRenderChat() {
    const box = $("chatBox");
    box.innerHTML = "";
    const list = state.chatLog.filter(chatVisible).slice(-120);
    if (!list.length) {
      box.innerHTML = '<div class="td-muted">Сообщений нет.</div>';
      return;
    }
    list.forEach((m) => box.appendChild(chatMsgNode(m)));
    box.scrollTop = box.scrollHeight;
    state.atBottom = true;
    hidePill();
  }

  function updatePill() {
    const pill = $("newMsgPill");
    if (state.pendingNew > 0 && !state.atBottom) {
      pill.hidden = false;
      pill.textContent = `новые сообщения ↓ (${state.pendingNew})`;
    } else {
      pill.hidden = true;
    }
  }

  function hidePill() {
    state.pendingNew = 0;
    $("newMsgPill").hidden = true;
  }

  function scrollChatBottom() {
    const box = $("chatBox");
    box.scrollTop = box.scrollHeight;
    state.atBottom = true;
    hidePill();
  }

  async function pollChat() {
    if (state.chatInflight) return;
    state.chatInflight = true;
    try {
      const r = await api(`/api/game/chat?since=${state.chatLastId}&limit=100`);
      if (r.search) return;
      const msgs = r.messages || [];
      if (!state.chatInit) {
        state.chatInit = true;
        $("chatBox").innerHTML = "";
      }
      let added = 0;
      for (const m of msgs) {
        if (m.id == null || shownIds.has(m.id)) continue;
        shownIds.add(m.id);
        state.chatLog.push(m);
        if (chatVisible(m)) {
          const box = $("chatBox");
          const empty = box.querySelector(".td-muted");
          if (empty) empty.remove();
          box.appendChild(chatMsgNode(m));
          added++;
        }
      }
      if (typeof r.last_id === "number") {
        state.chatLastId = Math.max(state.chatLastId, r.last_id);
      } else if (msgs.length) {
        state.chatLastId = Math.max(state.chatLastId, ...msgs.map((m) => m.id).filter((x) => x != null));
      }
      if (state.chatLog.length > 400) {
        state.chatLog.splice(0, state.chatLog.length - 400);
        fullRenderChat();
        return;
      }
      if (added > 0) {
        if (state.atBottom) {
          scrollChatBottom();
        } else {
          state.pendingNew += added;
          updatePill();
        }
      }
    } catch (e) {
      noteOffline(e);
    } finally {
      state.chatInflight = false;
    }
  }

  async function sendChat() {
    const inp = $("chatInput");
    const text = inp.value.trim();
    if (!text) return;
    try {
      const r = await api("/api/game/chat", { method: "POST", body: JSON.stringify({ text }) });
      inp.value = "";
      haptic("ok");
      if (r.last_id) state.chatLastId = Math.max(state.chatLastId, r.last_id);
      await pollChat();
      scrollChatBottom();
    } catch (e) {
      haptic("err");
      if (!noteOffline(e)) alert("Не отправлено: " + e.message);
    }
  }

  /* ---------- bans / plugins / audit ---------- */

  function renderBans() {
    const box = $("bansBox");
    const q = $("banSearch").value.trim().toLowerCase();
    const list = state.bans.filter((b) => {
      if (!q) return true;
      return (stripCodes(b.name) + " " + (b.reason || "")).toLowerCase().includes(q);
    });
    if (!list.length) {
      box.innerHTML = '<div class="td-muted">Блокировки не найдены.</div>';
      return;
    }
    box.innerHTML = "";
    list.forEach((b) => {
      const d = document.createElement("div");
      d.className = "ban-card";
      d.innerHTML = `<div><b>${colorize(b.name)}</b><span class="ban-kind">${escapeHtml(b.kind || "ban")}</span>` +
        `<div class="ban-meta">${escapeHtml(b.reason || "без причины")} - ${escapeHtml(b.source || "?")} - ${escapeHtml(fmtTime(b.created))}</div></div>`;
      if (state.role === "owner") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-mini";
        btn.textContent = "Разбанить";
        btn.onclick = () => askConfirm({ id: "unban", label: "Разбан", needReason: false }, stripCodes(b.name));
        d.appendChild(btn);
      }
      box.appendChild(d);
    });
  }

  async function loadBans() {
    try {
      const r = await api("/api/game/bans");
      state.bans = r.bans || [];
      renderBans();
    } catch (e) {
      if (!noteOffline(e)) {
        $("bansBox").innerHTML = '<div class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</div>";
      }
    }
  }

  async function loadPlugins() {
    const tBody = $("pluginsBody");
    try {
      const r = await api("/api/game/plugins");
      const list = r.plugins || [];
      if (!list.length) {
        tBody.innerHTML = '<tr><td colspan="3" class="td-muted">Список пуст.</td></tr>';
        return;
      }
      tBody.innerHTML = "";
      list.forEach((p) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><b>${escapeHtml(p.name)}</b></td><td class="td-muted">${escapeHtml(p.version || "-")}</td>` +
          `<td>${p.enabled ? '<span class="pill online">вкл</span>' : '<span class="pill offline">выкл</span>'}</td>`;
        tBody.appendChild(tr);
      });
    } catch (e) {
      if (!noteOffline(e)) {
        tBody.innerHTML = '<tr><td colspan="3" class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</td></tr>";
      }
    }
  }

  async function loadAudit() {
    if (state.role !== "owner") return;
    const box = $("auditBox");
    try {
      const r = await api("/api/game/audit?limit=100");
      const list = r.audit || [];
      if (!list.length) {
        box.innerHTML = '<div class="td-muted">Пока пусто.</div>';
        return;
      }
      box.innerHTML = "";
      list.forEach((a) => {
        const denied = /denied/i.test(a.action || "") || a.ok === 0 || a.ok === false;
        const d = document.createElement("div");
        if (denied) d.className = "denied";
        d.innerHTML = `<b>${escapeHtml(a.action)}</b> - ${colorize(a.target || "")} - ${escapeHtml(a.details || "")}` +
          `<div class="log-meta">${escapeHtml(fmtTime(a.ts))} - ${escapeHtml(a.admin || "?")}</div>`;
        box.appendChild(d);
      });
    } catch (e) {
      if (!noteOffline(e)) {
        box.innerHTML = '<div class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</div>";
      }
    }
  }

  /* ---------- metrics ---------- */

  function setTile(vId, barId, sId, valueText, pct, subText) {
    const v = $(vId);
    const bar = $(barId);
    const s = $(sId);
    if (v) v.textContent = valueText;
    if (bar) {
      bar.style.width = (pct == null ? 0 : Math.max(0, Math.min(100, pct))) + "%";
      bar.className = barColor(pct);
    }
    if (s) s.textContent = subText;
  }

  function drawChart(history) {
    const svg = $("mChart");
    if (!svg) return;
    const W = 600;
    const H = 180;
    const ns = "http://www.w3.org/2000/svg";
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const grid = (y) => {
      const l = document.createElementNS(ns, "line");
      l.setAttribute("x1", "0");
      l.setAttribute("x2", String(W));
      l.setAttribute("y1", String(y));
      l.setAttribute("y2", String(y));
      l.setAttribute("stroke", "rgba(253,171,114,0.15)");
      l.setAttribute("stroke-width", "1");
      svg.appendChild(l);
    };
    [10, 60, 110, 160].forEach(grid);
    if (!history || history.length < 2) return;
    const series = [
      { key: "cpu", color: "#fdab72", norm: (x) => x },
      { key: "mem", color: "#55b8ff", norm: (x) => x },
      { key: "tps", color: "#4ade80", norm: (x) => (x / 20) * 100 }
    ];
    series.forEach((sr) => {
      const pts = history.map((h, i) => {
        const x = (i / (history.length - 1)) * W;
        const val = Math.max(0, Math.min(100, Number(h[sr.key]) || 0));
        const y = 165 - (val / 100) * 150;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      const pl = document.createElementNS(ns, "polyline");
      pl.setAttribute("points", pts);
      pl.setAttribute("fill", "none");
      pl.setAttribute("stroke", sr.color);
      pl.setAttribute("stroke-width", "2");
      pl.setAttribute("stroke-linejoin", "round");
      svg.appendChild(pl);
    });
  }

  async function loadMetrics() {
    try {
      const r = await api("/api/game/metrics");
      const m = r.metrics || {};
      const cpu = m.cpu || {};
      const mem = m.memory || {};
      const disk = m.disk || {};
      const game = m.game || {};

      const cpuP = num(cpu.system_percent);
      setTile("mCpuV", "mCpuBar", "mCpuS",
        cpuP == null ? "…" : cpuP + " %",
        cpu.system_percent,
        cpu.process_percent == null ? "замер..." : `процесс ${num(cpu.process_percent)} % - ядер ${cpu.cores ?? "-"}`);

      const memP = num(mem.percent);
      setTile("mMemV", "mMemBar", "mMemS",
        memP == null ? "…" : memP + " %",
        mem.percent,
        mem.limit == null ? "лимит неизвестен" : `${fmtBytes(mem.used)} / ${fmtBytes(mem.limit)}`);

      const diskP = num(disk.percent);
      setTile("mDiskV", "mDiskBar", "mDiskS",
        diskP == null ? "…" : diskP + " %",
        disk.percent,
        disk.total == null ? "неизвестно" : `${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}`);

      const tps = game.tps == null ? null : Number(game.tps);
      const tpsBar = $("mTpsBar");
      $("mTpsV").textContent = tps == null ? "…" : num(tps);
      if (tpsBar) {
        tpsBar.style.width = (tps == null ? 0 : Math.max(0, Math.min(100, (tps / 20) * 100))) + "%";
        tpsBar.className = tps == null ? "" : tps < 15 ? "bad" : tps < 18 ? "warn" : "";
      }
      $("mTpsS").textContent = game.mspt == null ? "-" : `${num(game.mspt)} мс на тик`;

      $("mLoad").textContent = cpu.loadavg ? cpu.loadavg.join(" / ") : "-";
      $("mRss").textContent = fmtBytes(mem.process_rss);
      $("mUptime").textContent = "время работы: " + fmtUptimeFull(m.uptime_sec);
      drawChart(m.history);
    } catch (e) {
      noteOffline(e);
    }
  }

  /* ---------- power ---------- */

  let pendingPower = null;
  let waitTimer = null;
  let waitTries = 0;

  function renderPower(p) {
    state.power = p;
    const ids = ["power", "powerNav", "powerTab"];
    const showSection = !!p && (p.you_allowed || p.power_enabled);
    ids.forEach((id) => {
      const el = $(id);
      if (el) el.style.display = showSection ? "" : "none";
    });
    if (!showSection || !p) return;

    $("powerLocked").hidden = !p.locked_by_owner;
    const deny = $("powerDeny");
    if (!p.you_allowed && p.power_enabled) {
      deny.hidden = false;
      deny.textContent = p.deny_reason || "Нет прав на управление питанием.";
    } else {
      deny.hidden = true;
    }
    const ctl = $("powerControls");
    ctl.hidden = !p.you_allowed;
    if (p.you_allowed) {
      const locked = !!p.locked_by_owner || state.waiting;
      $("btnRestart").disabled = locked || !p.can_restart;
      $("btnStop").disabled = locked || !p.can_stop;
      const who = [];
      if (p.you) who.push("вы: " + p.you);
      if (p.allowed_admins && p.allowed_admins.length) who.push("допущены: " + p.allowed_admins.join(", "));
      $("powerState").textContent = who.join(" - ");
    }
    const start = $("powerStart");
    start.hidden = !p.you_allowed;
    if (p.you_allowed) {
      $("powerStartHint").textContent = p.start_hint || "";
      $("powerHostLink").href = p.host_panel_url || "#";
    }
  }

  async function loadPower() {
    try {
      const r = await api("/api/game/power");
      renderPower(r.power || null);
    } catch (e) {
      if (!noteOffline(e)) {
        ["power", "powerNav", "powerTab"].forEach((id) => {
          const el = $(id);
          if (el) el.style.display = "none";
        });
      }
    }
  }

  function askPower(action) {
    const p = state.power;
    if (!p || state.waiting) return;
    if (action === "restart" && !p.can_restart) return;
    if (action === "stop" && !p.can_stop) return;
    pendingPower = action;
    const n = state.lastOnline;
    $("pwTitle").textContent = action === "restart" ? "Перезапустить сервер?" : "Остановить сервер?";
    $("pwText").textContent = action === "restart"
      ? `Перезапустить сервер? Все игроки (${n} онлайн) будут отключены.`
      : `Остановить сервер? Все игроки (${n} онлайн) будут отключены.`;
    $("btnPowerYes").textContent = action === "restart" ? "Да, перезапустить" : "Да, остановить";
    $("powerModal").hidden = false;
    haptic("tap");
  }

  async function doPower() {
    if (!pendingPower) return;
    const action = pendingPower;
    pendingPower = null;
    $("powerModal").hidden = true;
    try {
      const r = await api("/api/game/power", { method: "POST", body: JSON.stringify({ action }) });
      haptic("ok");
      if (tg && tg.showAlert) tg.showAlert(r.result || "Готово");
      startWaiting(action);
      if (state.role === "owner") await loadAudit();
    } catch (e) {
      haptic("err");
      if (!noteOffline(e)) {
        if (tg && tg.showAlert) tg.showAlert("Ошибка: " + e.message);
        else alert("Ошибка: " + e.message);
      }
    }
  }

  function startWaiting(action) {
    state.waiting = true;
    const box = $("powerCountdown");
    box.hidden = false;
    let left = 5;
    const render = () => {
      box.textContent = action === "restart"
        ? `Перезапуск через ${left}... опросы приостановлены`
        : `Остановка через ${left}... опросы приостановлены`;
    };
    render();
    renderPower(state.power);
    clearInterval(waitTimer);
    waitTries = 0;
    waitTimer = setInterval(async () => {
      left--;
      if (left > 0) {
        render();
        return;
      }
      box.textContent = "Ожидание сервера... проверяю раз в 10 секунд";
      clearInterval(waitTimer);
      waitTimer = setInterval(async () => {
        waitTries++;
        const ok = await loadStatus();
        if (ok) {
          clearInterval(waitTimer);
          state.waiting = false;
          box.textContent = "Сервер в сети - опросы возобновлены";
          setTimeout(() => { box.hidden = true; }, 4000);
          renderPower(state.power);
          refreshAll();
        } else if (waitTries >= 30) {
          clearInterval(waitTimer);
          state.waiting = false;
          box.textContent = "Не дождались ответа - обнови вручную";
          renderPower(state.power);
        }
      }, 10000);
    }, 1000);
  }

  /* ---------- ban by nick with autocomplete ---------- */

  let findTimer = null;

  async function findPlayers(q) {
    const box = $("banSuggest");
    try {
      const r = await api("/api/game/find?q=" + encodeURIComponent(q) + "&limit=8");
      const list = r.found || [];
      if (!list.length) {
        box.hidden = true;
        return;
      }
      box.innerHTML = "";
      list.forEach((f) => {
        const b = document.createElement("button");
        b.type = "button";
        b.innerHTML = `<span class="s-dot${f.online ? " on" : ""}"></span><span>${colorize(f.name)}</span><small>${f.online ? "в сети" : "офлайн"}</small>`;
        b.onclick = () => {
          $("banNickInput").value = stripCodes(f.name);
          box.hidden = true;
        };
        box.appendChild(b);
      });
      box.hidden = false;
    } catch (e) {
      if (!noteOffline(e)) box.hidden = true;
    }
  }

  /* ---------- confirm modal ---------- */

  let pendingAction = null;

  function askConfirm(action, name) {
    name = stripCodes(name).trim();
    if (!name) {
      haptic("err");
      return;
    }
    pendingAction = { action, name };
    $("cfTitle").textContent = action.label + " - подтверждение";
    $("cfNick").innerHTML = colorize(name);
    $("cfReasonWrap").style.display = action.needReason ? "" : "none";
    $("cfReason").value = "";
    $("confirmModal").hidden = false;
    haptic("tap");
  }

  async function doConfirmed() {
    if (!pendingAction) return;
    const { action, name } = pendingAction;
    const reason = $("cfReason").value.trim();
    $("confirmModal").hidden = true;
    try {
      const r = await api("/api/game/" + action.id, {
        method: "POST",
        body: JSON.stringify({ name, reason })
      });
      haptic("ok");
      pendingAction = null;
      await loadPlayers();
      await loadBans();
      if (state.role === "owner") await loadAudit();
      if (tg && tg.showAlert) tg.showAlert(r.result || "Готово");
    } catch (e) {
      haptic("err");
      if (!noteOffline(e)) {
        if (tg && tg.showAlert) tg.showAlert("Ошибка: " + e.message);
        else alert("Ошибка: " + e.message);
      }
    }
  }

  /* ---------- player card modal ---------- */

  function pmNickMatch(a, b) {
    return stripCodes(a).toLowerCase() === stripCodes(b).toLowerCase();
  }

  async function openPlayer(name) {
    state.pmNick = stripCodes(name);
    $("pmNick").innerHTML = colorize(name);
    $("playerModal").hidden = false;
    haptic("tap");

    const p = state.players.find((x) => pmNickMatch(x.name, name)) || {};
    const rows = [
      ["ОС", p.os || "-"],
      ["Режим", p.gamemode || "-"],
      ["Пинг", p.ping ?? "-"],
      ["Координаты", p.x != null ? `${p.x} ${p.y} ${p.z}` : "-"],
      ["Мир", p.dimension || "-"],
      ["Здоровье", p.health ?? "-"],
      ["Оператор", p.is_op ? "да" : "нет"],
      ["XUID", p.xuid || "(пусто)"],
      ["device_id", p.device_id || "-"],
      ["IP", p.ip || "-"]
    ];
    $("pmSummary").innerHTML = rows.map(([k, val]) => `<div><span>${escapeHtml(k)}</span>${escapeHtml(String(val))}</div>`).join("");

    const mine = state.chatLog.filter((m) => pmNickMatch(m.player, name)).slice(-5);
    $("pmChat").innerHTML = mine.length
      ? mine.map((m) => `<div><b>${escapeHtml(fmtTime(m.ts))}</b> - ${colorize(m.text || m.type)}</div>`).join("")
      : '<div class="td-muted">Сообщений не найдено.</div>';

    const pb = state.bans.filter((b) => pmNickMatch(b.name, name));
    $("pmBans").innerHTML = pb.length
      ? pb.map((b) => `<div><b>${escapeHtml(b.kind || "ban")}</b> - ${escapeHtml(b.reason || "")} <span class="log-meta">${escapeHtml(fmtTime(b.created))}</span></div>`).join("")
      : '<div class="td-muted">Блокировок нет.</div>';

    if (p.x != null) {
      $("blX").value = p.x;
      $("blY").value = p.y;
      $("blZ").value = p.z;
    }
    await loadNotes(state.pmNick);
  }

  async function lookupBlocklog() {
    const box = $("blBox");
    const q = new URLSearchParams({
      x: $("blX").value || "0",
      y: $("blY").value || "0",
      z: $("blZ").value || "0",
      dimension: $("blDim").value,
      limit: "20"
    }).toString();
    box.innerHTML = '<div class="td-muted">Ищу...</div>';
    try {
      const r = await api("/api/game/blocklog?" + q);
      const list = r.entries || [];
      box.innerHTML = list.length
        ? list.map((e) => `<div><b>${escapeHtml(e.action)}</b> - ${colorize(e.player || "")} - ${escapeHtml(e.block || "")} <span class="log-meta">${escapeHtml(fmtTime(e.ts))}</span></div>`).join("")
        : '<div class="td-muted">Записей нет.</div>';
    } catch (e) {
      if (!noteOffline(e)) box.innerHTML = '<div class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</div>";
    }
  }

  async function loadNotes(name) {
    const box = $("notesBox");
    try {
      const r = await api("/api/notes?name=" + encodeURIComponent(name));
      const list = r.notes || [];
      box.innerHTML = (list.length
        ? list.map((n) => `<div>${escapeHtml(n.text)} <span class="log-meta">${escapeHtml(n.by || "?")} - ${escapeHtml(fmtTime(n.ts))}</span></div>`).join("")
        : '<div class="td-muted">Заметок нет.</div>') +
        (r.storage === "memory" ? '<div class="td-muted">Хранилище: память (подключи KV NOTES_KV для постоянства).</div>' : "");
    } catch (e) {
      box.innerHTML = '<div class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</div>";
    }
  }

  async function addNote() {
    const inp = $("noteInput");
    const text = inp.value.trim();
    if (!text || !state.pmNick) return;
    try {
      await api("/api/notes", { method: "POST", body: JSON.stringify({ name: state.pmNick, text }) });
      inp.value = "";
      haptic("ok");
      await loadNotes(state.pmNick);
    } catch (e) {
      haptic("err");
      alert("Не сохранено: " + e.message);
    }
  }

  /* ---------- refresh + pollers ---------- */

  async function refreshAll() {
    await loadStatus();
    await loadPlayers();
    await pollChat();
    await loadBans();
    await loadPlugins();
    await loadAudit();
    await loadMetrics();
    await loadPower();
  }

  let pollStarted = false;
  function startPollers() {
    if (pollStarted) return;
    pollStarted = true;
    const go = () => !document.hidden && !state.demo && !state.waiting;
    setInterval(() => { if (go()) loadPlayers(); }, 5000);
    setInterval(() => { if (go()) pollChat(); }, 2000);
    setInterval(() => { if (go()) loadStatus(); }, 15000);
    setInterval(() => { if (go()) loadBans(); }, 30000);
    setInterval(() => { if (go()) loadMetrics(); }, 5000);
    setInterval(() => { if (go()) loadPower(); }, 30000);
  }

  /* ---------- chrome: progress, nav, reveal ---------- */

  function initChrome() {
    const nav = $("nav");
    const progress = $("progress");
    const onScroll = () => {
      const y = window.scrollY || 0;
      if (nav) nav.classList.toggle("scrolled", y > 24);
      if (progress) {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.transform = "scaleX(" + (h > 0 ? Math.min(1, y / h) : 0) + ")";
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  function initReveal() {
    const els = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("visible"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add("visible");
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.08 });
    els.forEach((el) => io.observe(el));
  }

  /* ---------- init ---------- */

  function init() {
    if (tg) {
      try {
        tg.ready();
        tg.expand();
        if (tg.setHeaderColor) tg.setHeaderColor("#0D0704");
        if (tg.setBackgroundColor) tg.setBackgroundColor("#0D0704");
      } catch (e) { /* noop */ }
      state.initData = tg.initData || "";
    }

    initChrome();
    preSet(8, "auth");
    const tag = $("buildTag");
    if (tag) tag.textContent = BUILD;

    $("btnRetry").onclick = () => { haptic("tap"); doAuth(); };
    $("btnRefreshAll").onclick = () => { haptic("tap"); refreshAll(); };
    $("btnCopyIp").onclick = async () => {
      haptic("tap");
      try { await navigator.clipboard.writeText("play.buildzone.lol:25903"); }
      catch (e) { /* noop */ }
    };
    $("btnOfflineRetry").onclick = () => { haptic("tap"); refreshAll(); };

    document.querySelectorAll("#chatSeg button").forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll("#chatSeg button").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        state.chatFilter = b.dataset.chatf;
        haptic("tap");
        if (state.chatInit) fullRenderChat();
      };
    });
    let chatT = null;
    $("chatSearch").addEventListener("input", () => {
      clearTimeout(chatT);
      chatT = setTimeout(() => { if (state.chatInit) fullRenderChat(); }, 200);
    });
    $("chatBox").addEventListener("scroll", () => {
      const box = $("chatBox");
      state.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (state.atBottom) hidePill();
    });
    $("newMsgPill").onclick = () => { haptic("tap"); scrollChatBottom(); };
    $("btnChatSend").onclick = sendChat;
    $("chatInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });

    $("banSearch").addEventListener("input", renderBans);

    const nickInput = $("banNickInput");
    nickInput.addEventListener("input", () => {
      clearTimeout(findTimer);
      const q = nickInput.value.trim();
      if (!q) {
        $("banSuggest").hidden = true;
        return;
      }
      findTimer = setTimeout(() => findPlayers(q), 250);
    });
    nickInput.addEventListener("blur", () => {
      setTimeout(() => { $("banSuggest").hidden = true; }, 200);
    });
    nickInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("banSuggest").hidden = true;
    });
    document.querySelectorAll("[data-nickact]").forEach((b) => {
      b.onclick = () => {
        const meta = ACTIONS.find((a) => a.id === b.dataset.nickact);
        if (meta) askConfirm(meta, nickInput.value);
      };
    });

    $("btnCfOk").onclick = doConfirmed;
    $("btnCfCancel").onclick = () => { $("confirmModal").hidden = true; pendingAction = null; };
    $("confirmModal").addEventListener("click", (e) => {
      if (e.target.id === "confirmModal") {
        $("confirmModal").hidden = true;
        pendingAction = null;
      }
    });

    $("btnRestart").onclick = () => askPower("restart");
    $("btnStop").onclick = () => askPower("stop");
    $("btnPowerYes").onclick = doPower;
    $("btnPowerNo").onclick = () => { $("powerModal").hidden = true; pendingPower = null; };
    $("powerModal").addEventListener("click", (e) => {
      if (e.target.id === "powerModal") {
        $("powerModal").hidden = true;
        pendingPower = null;
      }
    });

    $("pmClose").onclick = () => { $("playerModal").hidden = true; state.pmNick = null; };
    $("playerModal").addEventListener("click", (e) => {
      if (e.target.id === "playerModal") {
        $("playerModal").hidden = true;
        state.pmNick = null;
      }
    });
    $("btnBlGo").onclick = lookupBlocklog;
    $("btnNoteAdd").onclick = addNote;

    document.querySelectorAll('a[href^="#"]').forEach((a) => {
      a.addEventListener("click", () => haptic("tap"));
    });

    doAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
