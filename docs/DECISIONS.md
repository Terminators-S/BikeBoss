# BikeBoss — Architecture Decision Records

> Why things are the way they are. Newest at top. Don't reverse a decision without reading its reasoning first.

---

## ADR-010: Device-encrypted trusted Wi-Fi roaming with cellular fallback

**Date:** 2026-08-09 · **Status:** Implemented and deployed to staging; COM7 field flash pending

**Decision:** A dedicated tracker can own up to eight trusted Wi-Fi profiles.
The authenticated Mini App manages exact SSIDs, friendly place labels, write-only
passwords and connection priority. The Worker immediately seals each profile
with AES-256-GCM using a key separated from that device's signing key; D1 stores
only the ciphertext, nonce, key version and non-secret operational metadata.

Profile changes increment a device configuration revision and enqueue only a
non-secret `WIFI_SYNC` command. Signed telemetry responses hydrate that command
with device-encrypted envelopes. Legacy unsigned telemetry is forbidden from
pulling secure configuration. The firmware rejects failed authentication and
revision rollback before replacing its NVS profile set.

The runtime chooses the strongest visible trusted profile with a priority bias,
uses failure cooldown, a two-minute minimum dwell and a 12 dB roaming margin.
When no trusted Wi-Fi works, a separate A7670G state machine checks SIM,
registration, packet attachment and PDP address before declaring 4G online. If
both uplinks fail, the existing bounded local queue retains telemetry for replay.

Telemetry carries only an opaque Wi-Fi profile UUID, signal and friendly label;
it never contains SSID or password. The Worker validates the UUID against the
device and learns a coarse connection center from accurate GPS observations at
most once per ten minutes. This context is diagnostic evidence and never
replaces L76K GPS or geofence math.

**Security gates:** Production hardware must enable ESP32 flash encryption and
secure boot before storing provisioned credentials in NVS. Production rollout
also remains gated on signed A7670G HTTPS/header verification with a real SIM.

**Trade-off:** Cloud-assisted provisioning is easier for owners and supports
remote changes, but the Worker sees the password briefly inside an authenticated
HTTPS request before encryption. Passwords are never returned, logged or stored
as plaintext. A future BLE-local provisioning mode can offer end-to-end owner to
device setup for deployments that do not want cloud-assisted credentials.

---

## ADR-009: Compact, adaptive telemetry for low cellular usage

**Date:** 2026-08-08 · **Status:** Implemented locally; hardware and production rollout gated

**Decision:** Keep the signed HTTPS v2 transport for the first production
release, but make its wire format and cadence intentionally small:

- Target a routine telemetry body of **256 bytes or less** and a command response
  of **96 bytes or less**; enforce a 512-byte routine-body ceiling.
- Send only safety/location aggregates in routine telemetry. Raw accelerometer
  and gyroscope axes belong in crash or explicitly requested diagnostic records.
- Use a versioned compact envelope with scaled integers where this preserves
  more precision than the sensors provide. Normalize it to descriptive fields at
  the Worker boundary so storage and application code remain readable.
- Omit absent, unchanged and empty optional fields. Never omit fix validity,
  accuracy, sample time, sequence, arm state or command acknowledgements when
  they are relevant.
- Use adaptive reporting: 5–15 seconds armed/moving, 15–30 seconds
  armed/stationary, 30–60 seconds disarmed/moving, and 3–5 minutes
  disarmed/stationary. Safety events, state changes and acknowledgements send
  immediately. The server may temporarily request a faster safe cadence.
- Batch buffered history after an outage instead of opening one HTTPS request
  per old sample. Live safety samples are never delayed merely to fill a batch.

**Implemented profile:** Routine packets use `v,id,q,t,a,g,m,b,c,k`, a single
`X-BikeBoss-Auth` signing header, a 512-byte server ceiling and a minimal
`{ok,q,c}` response. The current cadence is 10 seconds armed/moving, 30 seconds
armed/stationary, 60 seconds disarmed/moving, 5 minutes disarmed/stationary and
2 seconds during a confirmed incident. Arm changes send immediately; GPS fix
changes require 5 seconds of stability. Offline resend accepts at most 8 ordered
samples in a 4 KiB request and safely skips an already-committed prefix.
Routine telemetry and crash/power-cut retries use separate SPIFFS queues;
safety records retain their endpoint and body and are never fed to the compact
batch decoder.
Verbose v1 backlog found during a signed upgrade is drained through the legacy
v1 telemetry endpoint before compact batching continues.

The legacy v1 endpoint remains the default build until the signed A7670G header
path is proven on real cellular hardware and the production migration and
credentials are deliberately enabled. The wire contract is documented in
`docs/TELEMETRY_V2_COMPACT_PROTOCOL.md`.

**Why:** Request frequency and TLS/network overhead dominate cellular usage.
Removing duplicated fields helps, but adaptive cadence, small responses and
offline batching produce the larger saving while preserving alert speed.

**Trade-off:** A compact envelope is less readable on the wire and needs strict
versioned decoder tests. CBOR, MQTT or a persistent socket may reduce overhead
further, but should follow measured SIM data rather than complicating the first
production release.

---

## ADR-008: MapLibre with OpenFreeMap for the initial production map

**Date:** 2026-08-08 · **Status:** Accepted

**Decision:** Use MapLibre GL JS with the free OpenFreeMap Liberty style. Keep
the style URL configurable so a paid-SLA or self-hosted provider can replace it
without rewriting the map UI.

**Why:**
- Google Maps Platform requires billing and becomes paid beyond its allowance
- MapLibre is open source and provider-neutral
- OpenFreeMap supplies vector map styles without an API key
- OpenStreetMap attribution remains visible in the map

**Trade-off:** The free hosted provider has no BikeBoss-specific enterprise SLA.
Before a large commercial rollout, review usage, reliability, Cambodia label
quality, and the option to host PMTiles on R2.

---

## ADR-007: External L76K is the GPS source on the T-A7670G bench board

**Date:** 2026-08-07 · **Status:** Accepted · **Pinout confirmed:** 2026-08-08

**Decision:** Use the LilyGO board's separate L76K module for GNSS. The XIAO
receives NMEA on D2 from LilyGO GPIO22. The A7670G remains the 4G modem only.

**Why:**
- Live hardware probing detected valid L76K NMEA at 9600 baud
- A7670G returned `ERROR` for internal GNSS commands
- LilyGO's official documentation confirms A7670G has no internal GNSS
- The supplied T-A7670G R2 pinout exposes GPIO22 on the right-side header as
  `22 / Wire_SCL`, so it can be tapped to XIAO D2 on this board revision

**Bench integration:** The LilyGO onboard ESP32 runs `modem-test/` to power the
A7670G, wake the L76K, and release modem UART GPIO26/GPIO27 to the XIAO.

---

## ADR-006: Server-side geofence checking (not on-device)

**Date:** 2026-08-05 · **Status:** Accepted

**Decision:** Geofence breach detection runs in the Cloudflare Worker on each telemetry POST, not on the ESP32-S3.

**Why:**
- Zone edits take effect immediately — no OTA firmware update needed
- Saves device battery (no GPS math on MCU)
- Cloud has full zone list; device stays dumb
- AI/ML learning needs historical data that only exists in D1

**Trade-off:** Breach detection latency = telemetry interval (30s armed). Acceptable for theft alerts.

---

## ADR-005: Telegram Mini App instead of native mobile app

**Decision:** User interface is a Telegram Mini App (React web app inside Telegram), not iOS/Android native.

**Why:**
- Zero app-store friction for Cambodian users (Telegram is ubiquitous)
- Free push notifications via Bot API
- Built-in auth (Telegram identity = user account)
- One codebase (web) instead of two (iOS + Android)

---

## ADR-004: Cloudflare Workers + D1 instead of traditional server

**Decision:** Serverless edge compute (Workers) + serverless SQLite (D1).

**Why:**
- Zero cold-start latency for alerts
- Pay-per-request pricing (cheap at low volume, scales free tier first)
- No server maintenance
- D1 is SQLite — simple relational schema, familiar SQL

---

## ADR-003: ABA PayWay KHQR for payments

**Decision:** Subscription payments via KHQR codes through ABA PayWay gateway.

**Why:**
- KHQR is Cambodia's national QR standard (Bakong) — works with every local bank app
- ABA is the largest bank in Cambodia
- $15/year price point too small for international card processing fees
- Webhook verification is cryptographic (HMAC signature)

**Status:** Verified with real merchant account (2026-08-06).

---

## ADR-002: SIMCom A7670E modem (4G LTE Cat-1 + GNSS)

**Status:** Superseded in part by ADR-007 after live T-A7670G hardware discovery.

**Original decision:** Single module handling cellular + GPS, vs separate GPS chip.

**Why:**
- $10/year Cellcard AO data SIM (365-day validity) — cheapest connectivity in Cambodia
- Cat-1 sufficient for 30s telemetry pings
- Original assumption was integrated GNSS; the actual A7670G board uses L76K instead (ADR-007)
- Fallback: Wi-Fi BSSID geolocation when GPS blocked (underground)

---

## ADR-001: ESP32-S3 as edge MCU

**Decision:** Seeed XIAO ESP32-S3 (dual-core 240MHz, 8MB PSRAM).

**Why:**
- Native BLE 5.0 for keyless proximity unlock
- Vector instructions → TinyML crash classifier on-device (Edge Impulse)
- Tiny form factor fits inside motorcycle body panels
- PlatformIO ecosystem, cheap (~$8)
