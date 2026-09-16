// BuildZone Admin TMA - Cloudflare Workers alternative backend
// Same auth logic (Telegram initData HMAC-SHA256) in edge runtime
// Deploy: npx wrangler deploy worker.js (set vars BOT_TOKEN and ADMIN_IDS in wrangler.toml or dashboard)
// Note: this worker serves API only. Host ./public on Pages or any static hosting.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const BOT_TOKEN = env.BOT_TOKEN || "";
    const ADMIN_IDS = String(env.ADMIN_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data, Authorization"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json", ...cors }
      });

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "buildzone-admin-tma-worker", time: new Date().toISOString() });
    }

    if (url.pathname === "/api/auth" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const initData =
        request.headers.get("X-Telegram-Init-Data") ||
        (request.headers.get("Authorization") || "").replace(/^tma\s+/, "") ||
        body.initData ||
        "";
      const v = await validateInitData(initData, BOT_TOKEN);
      if (!v.ok) return json({ ok: false, error: "unauthorized: " + v.error }, 401);
      const uid = Number(v.user.id);
      if (!ADMIN_IDS.includes(uid)) {
        return json({ ok: false, error: "forbidden: not in ADMIN_IDS", user: { id: uid } }, 403);
      }
      return json({ ok: true, user: v.user, authDate: v.authDate });
    }

    return json({ ok: false, error: "not found" }, 404);
  }
};

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
