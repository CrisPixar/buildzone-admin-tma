// BuildZone Admin TMA - frontend
// Auth flow: read Telegram.WebApp.initData, POST to /api/auth, then call protected APIs

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

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

  function setNet(on, text) {
    const box = $("netStatus");
    if (!box) return;
    box.classList.toggle("on", !!on);
    const t = $("netStatusText");
    if (t) t.textContent = text || (on ? "online" : "offline");
  }

  function showTab(name) {
    document.querySelectorAll("[data-tab]").forEach((el) => {
      const isBtn = el.classList.contains("tab") || el.classList.contains("btab");
      if (isBtn) el.classList.toggle("active", el.dataset.tab === name);
    });
    document.querySelectorAll(".tabpage").forEach((p) => {
      p.classList.toggle("active", p.id === "page-" + name);
    });
    haptic("tap");
    if (name === "players") loadPlayers();
    if (name === "logs") loadLogs();
  }

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

  function showDenied(msg, id) {
    $("screenLoading").hidden = true;
    $("app").hidden = true;
    $("bottomNav").hidden = true;
    const d = $("screenDenied");
    d.hidden = false;
    if (msg) $("deniedText").textContent = msg;
    $("deniedId").textContent = "id: " + (id || (state.user && state.user.id) || "-");
    setNet(false, "denied");
    haptic("err");
  }

  function showApp(user) {
    $("screenLoading").hidden = true;
    $("screenDenied").hidden = true;
    $("app").hidden = false;
    $("bottomNav").hidden = false;
    setNet(true, "secured");
    const chip = $("userChip");
    chip.hidden = false;
    $("userName").textContent = user.first_name || user.username || ("id " + user.id);
    $("userId").textContent = "id " + user.id + (user.username ? " - @" + user.username : "");
    if (user.photo_url) {
      const img = $("userAvatar");
      img.src = user.photo_url;
      img.hidden = false;
    }
    loadStats();
    loadPlayers();
    loadLogs();
  }

  async function doAuth() {
    $("screenDenied").hidden = true;
    $("screenLoading").hidden = false;
    $("loadingHint").textContent = state.initData
      ? ("initData len: " + state.initData.length)
      : "no initData - open inside Telegram";

    // Demo preview mode: ?demo=1 renders UI without backend auth
    if (state.demo && !state.initData) {
      setNet(true, "demo");
      showApp({ id: 0, first_name: "Demo Admin", username: "demo" });
      renderDemoStats();
      return;
    }

    if (!state.initData) {
      showDenied("Open this app from your Telegram bot button (no initData found).", "-");
      return;
    }
    try {
      const r = await api("/api/auth", {
        method: "POST",
        body: JSON.stringify({ initData: state.initData })
      });
      state.user = r.user;
      showApp(r.user);
      haptic("ok");
      term("auth ok - welcome @" + (r.user.username || r.user.id));
    } catch (e) {
      const uid = e.data && e.data.user ? e.data.user.id : "-";
      showDenied(e.message || "auth failed", uid);
    }
  }

  function term(line) {
    const box = $("termBody");
    if (!box) return;
    const div = document.createElement("div");
    div.textContent = String(line).slice(0, 160);
    const carets = box.querySelectorAll(".ok");
    if (carets.length) carets[carets.length - 1].before(div);
    else box.appendChild(div);
  }

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
    const q = ($("playerSearch").value || "").trim();
    try {
      const r = await api("/api/players?q=" + encodeURIComponent(q));
      const list = r.players || [];
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="6" class="muted">No players found.</td></tr>';
        return;
      }
      body.innerHTML = "";
      list.forEach((p) => {
        const tr = document.createElement("tr");
        const badge = p.banned
          ? '<span class="badge banned">banned</span>'
          : p.status === "online"
            ? '<span class="badge online">online</span>'
            : '<span class="badge offline">offline</span>';
        tr.innerHTML =
          "<td><b>" + escapeHtml(p.nick) + "</b><div class='small muted mono'>" + p.tgId + "</div></td>" +
          "<td>" + badge + "</td>" +
          "<td>" + p.level + "</td><td>" + p.builds + "</td>" +
          "<td class='muted'>" + escapeHtml(p.lastSeen) + "</td>";
        const td = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "btn xs " + (p.banned ? "primary" : "danger");
        btn.textContent = p.banned ? "Unban" : "Ban";
        btn.onclick = () => toggleBan(p, btn);
        td.appendChild(btn);
        tr.appendChild(td);
        body.appendChild(tr);
      });
    } catch (e) {
      body.innerHTML = '<tr><td colspan="6" class="muted">Error: ' + escapeHtml(e.message) + "</td></tr>";
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
      term((wasBanned ? "unban ok: " : "ban ok: ") + p.nick);
    } catch (e) {
      haptic("err");
      alert("Failed: " + e.message);
      btn.disabled = false;
    }
  }

  async function loadLogs() {
    const box = $("logsBox");
    try {
      const r = await api("/api/logs");
      const logs = r.logs || [];
      box.innerHTML = "";
      logs.forEach((l) => {
        const d = document.createElement("div");
        const time = new Date(l.ts).toLocaleString("ru-RU", { hour12: false });
        d.innerHTML = "<b>" + escapeHtml(l.action) + "</b> - " + escapeHtml(l.detail) +
          "<div class='small muted'>" + escapeHtml(time) + " - by " + escapeHtml(l.actor) + "</div>";
        box.appendChild(d);
      });
      if (!logs.length) box.innerHTML = '<div class="muted">No logs yet.</div>';
    } catch (e) {
      box.innerHTML = '<div class="muted">Error: ' + escapeHtml(e.message) + "</div>";
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function init() {
    if (tg) {
      try {
        tg.ready();
        tg.expand();
        if (tg.setHeaderColor) tg.setHeaderColor("#0b0b10");
        if (tg.setBackgroundColor) tg.setBackgroundColor("#0b0b10");
      } catch (e) { /* noop */ }
      state.initData = tg.initData || "";
    }

    document.querySelectorAll("[data-tab]").forEach((el) => {
      el.addEventListener("click", () => showTab(el.dataset.tab));
    });

    $("btnRetry").onclick = () => { haptic("tap"); doAuth(); };
    $("btnRefresh").onclick = () => { haptic("tap"); loadStats(); term("stats refreshed"); };
    $("btnCopyIp").onclick = async () => {
      haptic("tap");
      try { await navigator.clipboard.writeText("play.buildzone.lol:25903"); term("ip copied"); }
      catch (e) { term("copy failed - select manually"); }
    };
    let searchT = null;
    $("playerSearch").addEventListener("input", () => {
      clearTimeout(searchT);
      searchT = setTimeout(loadPlayers, 250);
    });

    document.querySelectorAll("[data-qa]").forEach((b) => {
      b.onclick = () => {
        haptic("tap");
        $("qaResult").textContent = "Queued: " + b.dataset.qa + " - wire RCON to execute for real.";
        term("qa queued: " + b.dataset.qa);
      };
    });

    $("btnBan").onclick = async () => {
      const t = $("banTarget").value.trim();
      const reason = $("banReason").value.trim() || "no reason";
      if (!t) { $("banResult").textContent = "Enter nick or ID first."; return; }
      haptic("tap");
      $("banResult").textContent = "Banned " + t + " (" + $("banDuration").value + ") - reason: " + reason;
      term("manual ban: " + t);
    };

    const bcText = $("bcText");
    bcText.addEventListener("input", () => { $("bcCount").textContent = String(bcText.value.length); });
    $("btnBcPreview").onclick = () => {
      const p = $("bcPreview");
      p.hidden = false;
      p.textContent = bcText.value.trim() || "(empty)";
    };
    $("btnBcSend").onclick = async () => {
      const text = bcText.value.trim();
      if (!text) { $("bcResult").textContent = "Text is empty."; return; }
      try {
        const r = await api("/api/broadcast", { method: "POST", body: JSON.stringify({ text }) });
        $("bcResult").textContent = "Sent to " + r.sent + " subs (demo count).";
        haptic("ok");
        term("broadcast sent");
      } catch (e) {
        $("bcResult").textContent = "Send failed: " + e.message;
        haptic("err");
      }
    };
    $("btnLogs").onclick = () => loadLogs();

    doAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
