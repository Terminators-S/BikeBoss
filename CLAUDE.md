# CLAUDE.md — BikeBoss Project Guide

> Auto-loaded every session. Read this first before making changes.

## Project Identity

**BikeBoss** = IoT motorcycle security ecosystem for Cambodia (Phnom Penh).
Hardware device integrated with motorcycles providing:
1. **Geofencing** (PRIMARY FOCUS) — real-time GPS tracking + user-defined safe zones + breach alerts
2. **Crash detection** — 3-stage IMU algorithm (MPU6050)
3. **Keyless access** — BLE proximity unlock + engine immobilizer relay
4. **Anti-theft** — van-lift detection, power-cut alerts, heartbeat monitoring

**Current phase:** Geofencing feature + AI/ML smart safe-zone learning.

**Bench hardware fact:** LilyGO T-A7670G uses A7670G for 4G only and a separate
L76K for GPS. GPS NMEA is LilyGO GPIO22 → XIAO D2; do not use A7670 GNSS AT commands.

## Architecture (3 layers)

| Layer | Stack | Location |
|---|---|---|
| Edge firmware | ESP32-S3, PlatformIO, C++ | `firmware/` |
| Cloud backend | Cloudflare Workers + D1 (SQLite) | `backend/` |
| Client frontend | Telegram Mini App (Vite + React) | `frontend/` |

Payments: ABA PayWay KHQR (verified with real merchant account).
Notifications: Telegram Bot API (bilingual EN/KH).

## Commands

```bash
# Backend
cd backend && npm install
npm test                          # unit tests (node --test)
npm run dev                       # wrangler dev (local)
npm run simulate -- --url http://127.0.0.1:8787 --device BB-00000001 --crash

# Firmware
cd firmware && pio run            # build
pio run -t upload                 # flash XIAO ESP32-S3
pio device monitor -b 115200      # serial console

# Frontend
cd frontend && npm install && npm run dev
```

## Hard Rules

1. **NEVER commit real credentials** — secrets via `wrangler secret put` or `.dev.vars` (gitignored)
2. **PROJECT_CONTEXT.md is the source of truth** for architecture — read before major changes
3. **Update docs/PROGRESS.md** after completing any task — keep the living log current
4. **All user-facing strings bilingual** (EN + KH) via `backend/src/lib/i18n.js`
5. **Non-blocking firmware only** — `millis()` state timers, no `delay()` in main loop (100Hz IMU)
6. **Geofence math** — always use `haversineDistance()` from `lib/geo.js`, never reimplement

## Key Files

| File | Purpose |
|---|---|
| `PROJECT_CONTEXT.md` | Full architecture spec + algorithms |
| `docs/GOAL.md` | Current goal & scope (geofencing + AI) |
| `docs/PROGRESS.md` | Living work log — update after each task |
| `docs/DECISIONS.md` | Architecture decision records |
| `backend/schema.sql` | D1 database schema |
| `backend/src/lib/geofence.js` | Geofence breach engine |
| `backend/src/lib/geo.js` | Haversine math |
| `docs/HARDWARE_PINOUT.md` | Bench wiring map (XIAO ↔ MPU6050 ↔ LilyGO) |

## Environment

- Platform: cross-platform; run commands from the repository root
- Frontend deployed: `bikeboss.creative-studio.blog` (Cloudflare Pages)
- Repo is a git repository — commit with clear messages
