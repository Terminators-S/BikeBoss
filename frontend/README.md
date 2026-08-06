# BikeBoss Telegram Mini App

React UI running inside Telegram — bike status, live location, event history, trips, and subscription renewal.

## Dev

```bash
npm install
npm run dev          # http://localhost:3000 — proxies /api → wrangler dev (:8787)
```

Outside Telegram it runs in **demo mode** using device `BB-00000001`.

## Production wiring

1. Deploy: `npm run build` → host `dist/` (Cloudflare Pages or serve from the Worker).
2. In @BotFather: `/newapp` (or edit app) → set the Mini App URL.
3. Set `VITE_API_BASE` to the Worker origin at build time if not same-origin.

## Telegram integration

- `index.html` loads `telegram-web-app.js`; `src/api.js` exposes `getTelegramContext()`
  (user id, initData) with a demo-mode fallback.
- **TODO:** validate `initData` server-side (HMAC with bot token) before trusting
  `userId` for sensitive actions (payments).

## Structure

```
src/
├── main.jsx               # bootstrap + Telegram WebApp expand
├── App.jsx                # polling shell (15s refresh)
├── api.js                 # API client + Telegram context
├── styles.css             # Telegram theme CSS variables
└── components/
    ├── StatusCard.jsx     # arm state, battery, speed, last seen
    ├── LocationCard.jsx   # coords + map link + geofences
    ├── EventsList.jsx     # recent alerts (crash/power-cut/breach)
    ├── TripsList.jsx      # trip history + scores
    └── SubscribeCard.jsx  # KHQR invoice flow
```
