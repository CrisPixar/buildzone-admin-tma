// BuildZone Admin TMA - frontend for plugin-backed spec
// Pages: online, chat, bans, plugins, audit, player card modal
// Auth: Telegram.WebApp.initData -> POST /api/auth (role: owner | moderator)

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const BUILD = "b6-spec";

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
    pmNick: null
  };

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

  function fmtTime(ts) {
    try {
      return new Date(Number(ts) * 1000).toLocaleString("ru-RU", { hour12: false, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
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
    const res = await fetch(path, Object.assign({}, opts, { headers }));
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
      pill.textContent = role === "owner" ? "owner" : "moder";
      pill.classList.toggle("owner", role === "owner");
      // role gating: audit + unban are owner-only
      if (role !== "owner") {
        ["audit", "auditNav", "auditTab"].forEach((id) => {
          const el = $(id);
          if (el) el.style.display = "none";
        });
      }
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
        msg = "Backend API missing (http " + e.status + ") - deploy Pages Functions, then retry.";
      }
      const dbg = "build " + BUILD +
        "\ninitData: " + (state.initData ? state.initData.length + " chars" : "MISSING") +
        "\n" + (e.debug || msg);
      showDenied(msg, uid, dbg);
    }
  }

  /* ---------- online ---------- */

  async function loadStatus() {
    try {
      const r = await api("/api/status");
      const s = r.status || {};
      $("sbOnline").textContent = `${s.online ?? "-"} / ${s.max_players ?? "-"}`;
      $("sbVersion").textContent = s.version || "-";
      $("sbTps").textContent = s.tps ?? "-";
      $("sbUptime").textContent = fmtUptime(s.uptime_sec);
      $("sbWorld").textContent = s.world || "-";
    } catch (e) {
      if (!noteOffline(e)) {
        $("sbOnline").textContent = "err";
      }
    }
  }

  const ACTIONS = [
    { id: "kick", label: "Кик", needReason: true },
    { id: "ban", label: "Бан", needReason: true },
    { id: "alban", label: "Alban", needReason: true },
    { id: "absoluter", label: "Absoluter", needReason: false }
  ];

  async function loadPlayers() {
    const tBody = $("playersBody");
    try {
      const r = await api("/api/game/players");
      state.players = r.players || [];
      $("playersCount").textContent = String(state.players.length);
      if (!state.players.length) {
        tBody.innerHTML = '<tr><td colspan="6" class="td-muted">Никого онлайн.</td></tr>';
        return;
      }
      tBody.innerHTML = "";
      state.players.forEach((p) => {
        const tr = document.createElement("tr");
        const nickTd = document.createElement("td");
        const nickBtn = document.createElement("button");
        nickBtn.type = "button";
        nickBtn.className = "nick-btn";
        nickBtn.innerHTML = colorize(p.name) + (p.is_op ? "<small>OP</small>" : `<small>${escapeHtml(p.os || "")}</small>`);
        nickBtn.onclick = () => openPlayer(p.name);
        nickTd.appendChild(nickBtn);
        tr.appendChild(nickTd);
        const cells = [p.os || "-", p.gamemode || "-", String(p.ping ?? "-"), `${p.x} ${p.y} ${p.z}`];
        cells.forEach((c) => {
          const td = document.createElement("td");
          td.textContent = c;
          tr.appendChild(td);
        });
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
        tBody.appendChild(tr);
      });
    } catch (e) {
      if (!noteOffline(e)) {
        tBody.innerHTML = '<tr><td colspan="6" class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</td></tr>";
      }
    }
  }

  /* ---------- chat ---------- */

  function chatVisible(m) {
    const f = $("chatType").value;
    const q = $("chatSearch").value.trim().toLowerCase();
    if (f === "chat" && m.type !== "chat") return false;
    if (f === "joinquit" && m.type !== "join" && m.type !== "quit") return false;
    if (f === "death" && m.type !== "death") return false;
    if (f === "admin" && m.type !== "admin") return false;
    if (q) {
      const hay = (stripCodes(m.player) + " " + stripCodes(m.text)).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderChat() {
    const box = $("chatBox");
    const list = state.chatLog.filter(chatVisible).slice(-120);
    if (!list.length) {
      box.innerHTML = '<div class="td-muted">Сообщений нет.</div>';
      return;
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.innerHTML = "";
    list.forEach((m) => {
      const d = document.createElement("div");
      d.className = "msg t-" + (m.type || "chat");
      let textHtml = "";
      if (m.type === "join") textHtml = '<span class="m-text">зашел на сервер</span>';
      else if (m.type === "quit") textHtml = '<span class="m-text">вышел с сервера</span>';
      else textHtml = '<div class="m-text">' + colorize(m.text || "") + "</div>";
      d.innerHTML = `<div class="m-head"><span class="m-nick">${colorize(m.player || "")}</span><span class="m-time">${escapeHtml(fmtTime(m.ts))}</span></div>` + textHtml;
      box.appendChild(d);
    });
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  async function pollChat() {
    try {
      const r = await api(`/api/game/chat?since=${state.chatLastId}&limit=100`);
      const msgs = r.messages || [];
      if (msgs.length) {
        state.chatLog.push(...msgs);
        if (state.chatLog.length > 400) state.chatLog.splice(0, state.chatLog.length - 400);
      }
      if (r.last_id) state.chatLastId = r.last_id;
      renderChat();
    } catch (e) {
      noteOffline(e);
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
      box.innerHTML = '<div class="td-muted">Баны не найдены.</div>';
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
          `<td>${p.enabled ? '<span class="pill online">on</span>' : '<span class="pill offline">off</span>'}</td>`;
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
        const d = document.createElement("div");
        d.innerHTML = `<b>${escapeHtml(a.action)}</b> - ${colorize(a.target || "")} - ${escapeHtml(a.details || "")}` +
          `<div class="log-meta">${escapeHtml(fmtTime(a.ts))} - by ${escapeHtml(a.admin || "?")}</div>`;
        box.appendChild(d);
      });
    } catch (e) {
      if (!noteOffline(e)) {
        box.innerHTML = '<div class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</div>";
      }
    }
  }

  /* ---------- confirm modal ---------- */

  let pendingAction = null;

  function askConfirm(action, name) {
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
    state.pmNick = name;
    $("pmNick").innerHTML = colorize(name);
    $("playerModal").hidden = false;
    haptic("tap");

    const p = state.players.find((x) => pmNickMatch(x.name, name)) || {};
    const rows = [
      ["ОС", p.os || "-"],
      ["Режим", p.gamemode || "-"],
      ["Пинг", p.ping ?? "-"],
      ["XYZ", p.x != null ? `${p.x} ${p.y} ${p.z}` : "-"],
      ["Мир", p.dimension || "-"],
      ["HP", p.health ?? "-"],
      ["OP", p.is_op ? "да" : "нет"],
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
      : '<div class="td-muted">Банов нет.</div>';

    if (p.x != null) {
      $("blX").value = p.x;
      $("blY").value = p.y;
      $("blZ").value = p.z;
    }
    await loadNotes(name);
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
  }

  let pollStarted = false;
  function startPollers() {
    if (pollStarted) return;
    pollStarted = true;
    setInterval(() => { if (!document.hidden && !state.demo) loadPlayers(); }, 5000);
    setInterval(() => { if (!document.hidden && !state.demo) pollChat(); }, 2000);
    setInterval(() => { if (!document.hidden && !state.demo) loadStatus(); }, 15000);
    setInterval(() => { if (!document.hidden && !state.demo) loadBans(); }, 30000);
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

    $("chatType").onchange = renderChat;
    let chatT = null;
    $("chatSearch").addEventListener("input", () => {
      clearTimeout(chatT);
      chatT = setTimeout(renderChat, 200);
    });
    $("btnChatSend").onclick = sendChat;
    $("chatInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });

    $("banSearch").addEventListener("input", renderBans);

    $("btnCfOk").onclick = doConfirmed;
    $("btnCfCancel").onclick = () => { $("confirmModal").hidden = true; pendingAction = null; };
    $("confirmModal").addEventListener("click", (e) => {
      if (e.target.id === "confirmModal") {
        $("confirmModal").hidden = true;
        pendingAction = null;
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
