// BuildZone Admin TMA - frontend
// Same UX language as building-zone-site: preloader, progress bar, reveal, terminal feed
// Auth: Telegram.WebApp.initData -> POST /api/auth -> protected APIs

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const BUILD = "b5-cachebust";

  const state = {
    initData: "",
    user: null,
    demo: new URLSearchParams(location.search).get("demo") === "1"
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

  /* ---------- preloader ---------- */
  let preTarget = 8;
  function preSet(pct, label) {
    preTarget = Math.max(0, Math.min(100, pct));
    const fill = $("pre-fill");
    const count = $("pre-count");
    if (fill) fill.style.width = preTarget + "%";
    if (count) count.textContent = (label || "auth") + " " + String(Math.round(preTarget)).padStart(3, "0") + " %";
  }
  function preDone() {
    const pre = $("preloader");
    if (!pre) return;
    preSet(100, "done");
    setTimeout(() => pre.classList.add("done"), 250);
  }

  /* ---------- net badge + user chip ---------- */
  function setNet(mode, text) {
    const box = $("netStatus");
    if (!box) return;
    box.classList.toggle("on", mode === "on");
    box.classList.toggle("bad", mode === "bad");
    const t = $("netStatusText");
    if (t) t.textContent = text || mode;
  }

  /* ---------- terminal feed ---------- */
  function term(line, ok) {
    const box = $("termBody");
    if (!box) return;
    const div = document.createElement("div");
    if (ok) div.className = "ok-line";
    div.textContent = String(line).slice(0, 180);
    box.prepend(div);
    while (box.children.length > 30) box.removeChild(box.lastChild);
  }

  /* ---------- api ---------- */
  async function api(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (state.initData) headers["X-Telegram-Init-Data"] = state.initData;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("http " + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---------- screens ---------- */
  function showDenied(msg, id) {
    preDone();
    setTimeout(() => {
      $("app").hidden = true;
      $("bottomNav").hidden = true;
      $("screenDenied").hidden = false;
      if (msg) $("deniedText").textContent = msg;
      $("deniedId").textContent = "id: " + (id || (state.user && state.user.id) || "-");
      setNet("bad", "denied");
      haptic("err");
    }, 500);
  }

  function showApp(user) {
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
      initReveal();
      loadStats();
      loadPlayers();
      loadLogs();
    }, 500);
  }

  async function doAuth() {
    $("screenDenied").hidden = true;
    preSet(18, "auth");

    if (state.demo && !state.initData) {
      preSet(70, "demo");
      showApp({ id: 0, first_name: "Demo Admin", username: "demo" });
      renderDemoStats();
      term("demo mode - backend auth skipped", true);
      return;
    }

    if (!state.initData) {
      showDenied("Открой приложение кнопкой бота в Telegram (initData не найден).", "-");
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
      showApp(r.user);
      haptic("ok");
      term("auth ok - welcome @" + (r.user.username || r.user.id), true);
    } catch (e) {
      const uid = e.data && e.data.user ? e.data.user.id : "-";
      let msg = e.message || "auth failed";
      if (e.status === 404 || e.status === 405) {
        msg = "Backend API missing (http " + e.status + ") - deploy Pages Functions or Node server, then retry.";
      }
      showDenied(msg, uid);
    }
  }

  /* ---------- data ---------- */
  function renderDemoStats() {
    $("stOnline").textContent = "128";
    $("stPlayers").textContent = "1,840";
    $("stBuilds").textContent = "632";
    $("stUptime").textContent = "99.9%";
    $("stReports").textContent = "4";
    $("stJoins").textContent = "37";
  }

  async function loadStats() {
    try {
      const r = await api("/api/stats");
      const s = r.stats || {};
      $("stOnline").textContent = s.online ?? "-";
      $("stPlayers").textContent = Number(s.playersTotal || 0).toLocaleString("en-US");
      $("stBuilds").textContent = s.buildsTotal ?? "-";
      $("stUptime").textContent = s.uptime ?? "-";
      $("stReports").textContent = s.pendingReports ?? "-";
      $("stJoins").textContent = s.todayJoins ?? "-";
    } catch (e) {
      if (state.demo) renderDemoStats();
      else term("stats error: " + e.message);
    }
  }

  async function loadPlayers() {
    const body = $("playersBody");
    if (!body) return;
    const q = ($("playerSearch").value || "").trim();
    try {
      const r = await api("/api/players?q=" + encodeURIComponent(q));
      const list = r.players || [];
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="6" class="td-muted">Игроки не найдены.</td></tr>';
        return;
      }
      body.innerHTML = "";
      list.forEach((p) => {
        const tr = document.createElement("tr");
        const pill = p.banned
          ? '<span class="pill banned">banned</span>'
          : p.status === "online"
            ? '<span class="pill online">online</span>'
            : '<span class="pill offline">offline</span>';
        tr.innerHTML =
          '<td><span class="nick">' + escapeHtml(p.nick) + "<small>" + p.tgId + "</small></span></td>" +
          "<td>" + pill + "</td>" +
          "<td>" + p.level + "</td><td>" + p.builds + "</td>" +
          '<td class="td-muted">' + escapeHtml(p.lastSeen) + "</td>";
        const td = document.createElement("td");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-mini" + (p.banned ? "" : " danger");
        btn.textContent = p.banned ? "Разбан" : "Бан";
        btn.onclick = () => toggleBan(p, btn);
        td.appendChild(btn);
        tr.appendChild(td);
        body.appendChild(tr);
      });
    } catch (e) {
      body.innerHTML = '<tr><td colspan="6" class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</td></tr>";
    }
  }

  async function toggleBan(p, btn) {
    btn.disabled = true;
    const wasBanned = !!p.banned;
    try {
      const path = "/api/players/" + p.id + (wasBanned ? "/unban" : "/ban");
      const r = await api(path, { method: "POST", body: JSON.stringify({ reason: "action from TMA" }) });
      Object.assign(p, r.player);
      haptic("ok");
      loadPlayers();
      term((wasBanned ? "unban ok: " : "ban ok: ") + p.nick, true);
    } catch (e) {
      haptic("err");
      term("ban error: " + e.message);
      btn.disabled = false;
    }
  }

  async function loadLogs() {
    const box = $("logsBox");
    if (!box) return;
    try {
      const r = await api("/api/logs");
      const logs = r.logs || [];
      box.innerHTML = "";
      logs.forEach((l) => {
        const d = document.createElement("div");
        const time = new Date(l.ts).toLocaleString("ru-RU", { hour12: false });
        d.innerHTML = "<b>" + escapeHtml(l.action) + "</b> - " + escapeHtml(l.detail) +
          '<div class="log-meta">' + escapeHtml(time) + " - by " + escapeHtml(l.actor) + "</div>";
        box.appendChild(d);
      });
      if (!logs.length) box.innerHTML = '<div class="td-muted">Пока пусто.</div>';
    } catch (e) {
      box.innerHTML = '<div class="td-muted">Ошибка: ' + escapeHtml(e.message) + "</div>";
    }
  }

  /* ---------- site-like chrome: progress, nav, reveal ---------- */
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

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      term("copied: " + text, true);
      if (btn) {
        const old = btn.textContent;
        btn.textContent = "ok";
        btn.classList.add("ok");
        setTimeout(() => { btn.textContent = old; btn.classList.remove("ok"); }, 1200);
      }
      haptic("tap");
    } catch (e) {
      term("copy failed - select manually");
    }
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

    document.querySelectorAll("[data-copy]").forEach((b) => {
      b.addEventListener("click", () => copyText(b.dataset.copy || "", b));
    });
    document.querySelectorAll("[data-qa]").forEach((b) => {
      b.addEventListener("click", () => {
        haptic("tap");
        $("qaResult").textContent = "В очереди: " + b.dataset.qa + " - подключи RCON для реального исполнения.";
        term("queued: " + b.dataset.qa);
      });
    });

    $("btnRetry").onclick = () => { haptic("tap"); doAuth(); };
    $("btnRefresh").onclick = () => { haptic("tap"); loadStats(); term("stats refreshed", true); };
    $("btnCopyIp").onclick = (e) => copyText("play.buildzone.lol:25903", e.currentTarget);

    let searchT = null;
    $("playerSearch").addEventListener("input", () => {
      clearTimeout(searchT);
      searchT = setTimeout(loadPlayers, 250);
    });

    $("btnBan").onclick = () => {
      const t = $("banTarget").value.trim();
      const reason = $("banReason").value.trim() || "no reason";
      if (!t) { $("banResult").textContent = "Сначала введи ник или ID."; return; }
      haptic("tap");
      $("banResult").textContent = "Забанен " + t + " (" + $("banDuration").value + ") - причина: " + reason;
      term("manual ban: " + t);
    };

    const bcText = $("bcText");
    bcText.addEventListener("input", () => { $("bcCount").textContent = String(bcText.value.length); });
    $("btnBcPreview").onclick = () => {
      const p = $("bcPreview");
      p.hidden = false;
      p.textContent = bcText.value.trim() || "(пусто)";
    };
    $("btnBcSend").onclick = async () => {
      const text = bcText.value.trim();
      if (!text) { $("bcResult").textContent = "Текст пустой."; return; }
      try {
        const r = await api("/api/broadcast", { method: "POST", body: JSON.stringify({ text }) });
        $("bcResult").textContent = "Отправлено " + r.sent + " подписчикам (демо-счетчик).";
        haptic("ok");
        term("broadcast sent", true);
      } catch (e) {
        $("bcResult").textContent = "Ошибка отправки: " + e.message;
        haptic("err");
      }
    };
    $("btnLogs").onclick = () => loadLogs();

    // smooth anchor taps with haptic
    document.querySelectorAll('a[href^="#"]').forEach((a) => {
      a.addEventListener("click", () => haptic("tap"));
    });

    doAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
