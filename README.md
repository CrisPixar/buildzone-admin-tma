# buildzone-admin-tma

Admin panel as Telegram Mini App. Dark UI. Node backend with Telegram initData check.

## Stack
- Frontend: HTML, CSS, JS in ./public
- Backend: Node.js + Express (server.js)
- Alt backend: Cloudflare Workers (worker.js)

## Auth
- Client sends Telegram.WebApp.initData to POST /api/auth
- Server checks HMAC-SHA256 hash with BOT_TOKEN and checks ADMIN_IDS list
- Each protected API call must send header X-Telegram-Init-Data with fresh initData

## Run local
1. cp .env.example .env
2. Set BOT_TOKEN and ADMIN_IDS in .env
3. npm install
4. npm start
5. Open http://localhost:3000 (full auth works only inside Telegram; use ?demo=1 for UI preview)

## Deploy
- Any Node host: set env BOT_TOKEN and ADMIN_IDS, run npm install && npm start
- Set TMA URL in @BotFather to https://your-host/

## Config
- PORT, BOT_TOKEN, ADMIN_IDS (comma-separated Telegram IDs)
