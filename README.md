# BikeBoss Software

IoT motorcycle security, crash detection, and keyless access for Southeast Asia — edge ESP32-S3 firmware, Cloudflare Workers backend, and Telegram Mini App client.

## Repo layout

```
software/
├── PROJECT_CONTEXT.md      # Product & architecture specification (source of truth)
├── firmware/               # PlatformIO — Seeed XIAO ESP32-S3 edge node
│   ├── platformio.ini
│   ├── src/main.cpp
│   ├── include/config.h    # Per-device/build configuration
│   └── README.md
├── backend/                # Cloudflare Workers + D1 serverless API
│   ├── wrangler.toml
│   ├── schema.sql
│   ├── package.json
│   ├── src/
│   │   ├── index.js        # Worker entry + router
│   │   ├── routes/         # Route handlers (telemetry, webhooks, api)
│   │   └── lib/            # haversine, telegram, payments, geofence, trips
│   ├── scripts/
│   │   └── simulate-device.mjs  # Fake on-bike unit for end-to-end testing
│   └── test/
│       └── unit.test.mjs   # Pure-logic tests (node --test)
└── frontend/               # Telegram Mini App (Vite + React)
    ├── package.json
    ├── vite.config.js
    └── src/
```

## Quick start

### Backend (local dev)

```bash
cd backend
npm install
npm test                       # pure-logic unit tests (no cloud needed)
npm run dev                    # wrangler dev (needs wrangler login for D1)
```

Simulate a bike without hardware:

```bash
npm run simulate -- --url http://127.0.0.1:8787 --device BB-00000001 --crash
npm run simulate -- --url http://127.0.0.1:8787 --device BB-00000001 --heartbeat
npm run simulate -- --url http://127.0.0.1:8787 --device BB-00000001 --powercut
```

### Firmware

```bash
cd firmware
pio run                        # build
pio run -t upload              # flash (XIAO ESP32-S3 over USB)
pio device monitor -b 115200   # serial console; type 's' for status
```

Serial debug commands: `a` arm · `d` disarm · `g` GPS · `s` status · `f` flush SPIFFS log.

### Frontend (Mini App)

```bash
cd frontend
npm install
npm run dev
```

## Secrets & config

- Never commit real credentials. Backend reads secrets from Wrangler (`wrangler secret put ...` or `.dev.vars` locally).
- Copy `backend/.dev.vars.example` → `backend/.dev.vars` for local dev.
- Per-device firmware config lives in `firmware/include/config.h`.

## Home-lab hosting

The production Docker Compose stack and migration notes live in
`deploy/homelab/` and `docs/HOMELAB_DEPLOYMENT.md`. It serves the Mini App and
API from one hostname with local SQLite storage and local signed-OTA objects.

## Status

Production-capable release with signed global OTA, offline telemetry replay,
intelligent GPS drift filtering, Telegram Mini App controls, and verified
ESP32-S3 hardware updates. See `docs/PROGRESS.md` for the latest release record.
