# BikeBoss Telegram Mini App

React UI running inside Telegram — bike status, live location, event history, trips, and subscription renewal.

The Map tab uses Leaflet raster rendering so it works in Telegram Desktop
without WebGL. The default staging provider is OpenStreetMap's standard tile
service with visible attribution. Override it without code changes by setting
`VITE_MAP_TILE_URL` to a compatible `{z}/{x}/{y}` provider URL. The community
OSM service is best-effort and should be replaced with a provider that offers
an SLA before high-volume production use.

## Dev

```bash
npm install
npm run dev          # http://localhost:3000 — proxies /api → wrangler dev (:8787)
```

Outside Telegram it runs in **demo mode** using device `BB-00000001`.

## Production

- **URL:** https://bikeboss.creative-studio.blog (Cloudflare Pages project `bikeboss-app`)
- **API:** https://api.creative-studio.blog
- Bot menu button opens the Mini App URL above.

Deploy updates:

```bash
npm run build
npx wrangler pages deploy dist --project-name bikeboss-app
```

Then in @BotFather, keep the menu button pointed at the custom domain (already set).

## Staging

- **Mini App:** https://staging.bikeboss-app.pages.dev
- **API:** https://bikeboss-api-staging.sokpanha-nov1999.workers.dev

Build and deploy the isolated preview without changing production:

```powershell
$env:VITE_API_BASE='https://bikeboss-api-staging.sokpanha-nov1999.workers.dev'
$env:VITE_ENABLE_DEVELOPER_TOOLS='true'
npm run build
npx wrangler pages deploy dist --project-name bikeboss-app --branch staging
```

The staging-only Developer Field Lab is available from **Account → Developer
Field Lab**. It provides live GPS/uplink/motion/power diagnostics and guided
phone-only field-test sessions with pass/fail results, notes, local evidence
snapshots, and report sharing. Session data stays in the phone browser's local
storage. The lab intentionally does not expose remote crash or relay triggers.


## Telegram integration

- `index.html` loads `telegram-web-app.js`; `src/api.js` exposes `getTelegramContext()`
  (user id, initData) with a demo-mode fallback.
- The app exchanges Telegram `initData` for a short-lived v2 bearer session.
  Location, device commands, device claiming, language changes, and zone CRUD
  derive the user from that server-validated session rather than a client-sent
  Telegram ID.
- Subscription invoice creation and status checks are owner-derived v2 calls;
  legacy v1 calls remain only for demo and staged migration compatibility.
- Dedicated-device owners can manage up to eight trusted Wi-Fi profiles from
  Account → Connection details. Passwords are write-only, encrypted for that
  tracker, and never returned by the API; shared prototype aliases remain
  read-only.

## Structure

```
src/
├── main.jsx               # bootstrap + Telegram WebApp expand
├── App.jsx                # secure polling shell + navigation/build gates
├── api.js                 # v2 session client + Telegram context + haptics
├── styles.css             # responsive light/dark enterprise design system
├── components/            # sheets, skeletons, toasts and SVG icons
└── screens/
    ├── HomeScreen.jsx     # security state + command acknowledgement lifecycle
    ├── MapScreen.jsx      # live map + full zone CRUD + smart suggestions
    ├── ActivityScreen.jsx # trips + evidence-rich event acknowledgement
    ├── AccountScreen.jsx  # device, settings and secure invoice flow
    ├── DeveloperScreen.jsx # staging-only phone field-test console
    └── Onboarding.jsx     # welcome + secure device linking
```
