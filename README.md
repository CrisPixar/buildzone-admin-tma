# buildzone-admin-tma

Admin console for Building Zone as Telegram Mini App. Warm design from building-zone-site. Backend proxies game plugin API on port 26903.

## Auth
- Telegram only: client sends Telegram.WebApp.initData to POST /api/auth
- Server checks HMAC-SHA256 with BOT_TOKEN, then maps Telegram ID to role
- Roles: owner (OWNER_IDS) and moderator (MODERATOR_IDS, ADMIN_IDS is legacy alias)
- Owner-only: unban, audit. Backend enforces, UI hides.

## Plugin contract (fixed by plugin team, do not change)
- Backend calls GAME_API_URL with header X-Auth-Key: GAME_API_KEY
- Key lives in backend env only, never in browser
- Timeout 5s, on failure API answers offline:true and UI shows offline banner
- MOCK=1 enables mock mode with same JSON shapes

## Env
- BOT_TOKEN - from @BotFather
- OWNER_IDS - comma-separated Telegram IDs, e.g. 111,222
- MODERATOR_IDS - comma-separated Telegram IDs
- GAME_API_URL - e.g. http://89.188.109.183:26903 (empty = mock)
- GAME_API_KEY - 40-char plugin key, Secret, never commit
- Optional KV binding NOTES_KV for persistent admin notes (else memory)

## Run local (node)
1. cp .env.example .env and fill values
2. npm install
3. npm start
4. http://localhost:3000 (full auth only inside Telegram, ?demo=1 for UI preview)

## Deploy (Cloudflare Pages)
- Build command: empty, output directory: public
- Functions in ./functions serve /api/* on same domain
- Set env vars in Pages dashboard, then redeploy

## Live backend (Render)
- Frontend API_BASE points to https://api.buildzone.lol (Render Node backend, same routes as server.js)
- Reason: Cloudflare Pages edge blocks direct calls to the plugin IP (1003), Node backend calls it fine
- Render env: GAME_API_URL=http://89.188.109.183:26903 (direct IP), GAME_API_KEY, BOT_TOKEN, OWNER_IDS, MODERATOR_IDS

## Pages
Online (poll 5s, keyed rows, kick/ban/alban/absoluter with confirm), Chat (poll 2s, dedup by id, send, one-tap filter, search), Bans (search, owner unban, ban-by-nick with /find autocomplete), Plugins (readonly), Audit (owner, DENIED entries red), Metrics (poll 5s, CPU/RAM/disk/TPS tiles + SVG history chart), Server power (poll 30s, rights from plugin by Telegram username, restart/stop with confirm modal + 5s countdown + waiting mode), Player card modal (summary, chat excerpt, blocklog, bans, notes).
