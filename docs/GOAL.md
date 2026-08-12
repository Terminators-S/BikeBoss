# BikeBoss — Goal & Scope

> Last updated: 2026-08-08

## Primary Goal

Build the **Geofencing feature** for BikeBoss: an IoT device integrated with motorcycles in Cambodia that lets owners:

1. **Track their motorcycle's real-time location** (external L76K GPS → XIAO ESP32-S3 → A7670G/Wi-Fi uplink → Cloudflare Workers → Telegram Mini App map)
2. **Set geofence safe zones** — user-defined virtual boundaries around parked locations
3. **Receive instant breach alerts** — if the motorcycle exits the zone without the owner present, push an alert to the user's Telegram Mini App / bot

## Secondary Goal (AI/ML Integration)

Enhance geofencing with **intelligent safe-zone automation**:

- **Learn parking patterns** — ML model analyzes historical GPS data to recognize habitual parking spots (home, work, school)
- **Suggest effective safe zones** — automatically propose zone center + radius based on where the user actually parks, instead of manual setup every time
- **Reduce false positives** — distinguish real theft (bike moving away from zone) from benign drift (GPS jitter, owner walking nearby with BLE connected)

## Scope

### In Scope

| Feature | Description | Status |
|---|---|---|
| Real-time GPS tracking | Live location, freshness, accuracy and recent trail on the Mini App map | ✅ Staging |
| Manual geofence zones | Map-centered create/edit/pause/archive with a 50–1000 m radius | ✅ Staging |
| Geofence breach detection | Accuracy-aware, hysteretic per-zone lifecycle with evidence and deduplicated alerts | ✅ Staging |
| Multi-zone support | Multiple named zones per device (home, work, school, parking) | ✅ Staging |
| Owner-presence suppression | Suppress only with fresh authenticated owner proof; ordinary BLE fails closed | Partial — backend/protocol done, native BLE authentication pending |
| AI safe-zone learning | Cluster accurate stationary history and propose reviewable zones | Partial — deterministic suggestion foundation deployed to staging |
| AI false-positive filter | Classify breach events (real theft vs GPS jitter) | ⬜ Not started |
| Zone auto-activate | Auto-arm geofence when bike parked + ignition off | ⬜ Not started |

### Out of Scope (for this phase)

- Crash detection refinement (already specced, separate phase)
- Payment/subscription flows (✅ already done — KHQR verified)
- Firmware hardware bring-up (separate track)
- Predictive battery diagnostics (future cloud AI)

## Success Criteria

1. User parks bike → opens Mini App → sees live location on map
2. User taps "Set safe zone here" → zone saved (anchor + radius)
3. Bike moves >100m from zone while armed → Telegram alert within 30 seconds
4. If owner's phone is BLE-connected to bike → no false alert
5. After 2 weeks of usage → system suggests optimal zones based on parking history

## Key Technical Constraints

- **Geofence check runs server-side** (Cloudflare Worker) on each telemetry POST — not on device (saves battery, allows zone edits without OTA update)
- **Default radius:** 100m, min breach speed 0.5 km/h (filters GPS jitter)
- **Alert dedup:** max 1 breach alert per zone per 10 minutes
- **Bilingual:** all alerts EN + KH

## Data Flow

```
ESP32-S3 (L76K GPS + MPU6050 IMU)
  → signed compact 4G/Wi-Fi POST /api/v2/device/telemetry (adaptive cadence)
  → Cloudflare Worker (routes/telemetry.js)
  → D1: store telemetry
  → lib/geofence.js: checkGeofence() vs active zones
  → breach? → logEvent + Telegram alert (EN/KH)
  → Mini App uses a Telegram-validated v2 session → map, zones and event evidence
```
