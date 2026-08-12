# BikeBoss — Progress Log

> Living document. Updated after every work session. Newest entries at top.

---

## 2026-08-12 — Home-lab production cutover and OTA 0.1.4 ✅

- Moved the production Mini App, API, Telegram webhook, payment relay, SQLite
  database, scheduled work and signed firmware storage to the home-lab Docker
  stack; Cloudflare now provides only DNS, TLS and Tunnel transport for
  `bikeboss.creative-studio.blog`
- Imported 4 users, 6 devices, 12,287 telemetry records, 273 events, 4 trusted
  Wi-Fi profiles and the existing signed OTA history from D1/R2, with database
  integrity, foreign-key, decryption and restart-persistence checks passing
- Added a hostname-scoped Cloudflare Configuration Rule that disables the
  Managed Challenge only for BikeBoss, preserving the rest of the zone's
  protections while allowing the device API, Telegram webhook and OTA download
- Switched Telegram's webhook and **Open BikeBoss** menu button to the home-lab
  domain with zero pending updates, and changed the payment listener from the
  staging Worker to the same domain
- Published signed firmware `0.1.4` build `2026081206` for `BB-00000001`; it
  retains the GPS drift confidence engine, Wi-Fi-only/any-internet choice and
  announcement UX, and changes the firmware cloud host to the home server
- Deployed staging Worker version `565fe6cf-5280-454e-8518-a7683672e253` as a
  narrow bootstrap relay for device-originated API paths only; the tracker on
  `0.1.3` can therefore receive the rider-approved migration OTA from the home
  server, then bypasses the Worker permanently after `0.1.4` starts
- Verified the 1,601,776-byte OTA through the public device-authenticated URL;
  SHA-256 `9c2e4457c49d8035c685a7661e80aefe0b2dd0904e3d4cc671ad641ab45e2142`
  matched exactly and the Mini App reports the release as installable without
  queuing it automatically
- Added container builds, Nginx same-origin proxying, D1/R2 compatibility
  adapters, transactional migration, daily backups and reusable local firmware
  preparation/publication tools

## 2026-08-12 — Manual-approval OTA publishing gate ✅

- Separated signed firmware publication from installation: publishing creates
  only an immutable release and selected-device eligibility rollout, never a
  device command
- Scoped update discovery to the control device's rollout and added regression
  coverage proving release SQL cannot queue OTA; the authenticated Mini App's
  **Install update** action remains the only command-creation path

## 2026-08-12 — Repository prepared for home-lab migration ✅

- Prepared the complete BikeBoss source and current OTA/GPS reliability release
  for publication to `Terminators-S/BikeBoss` while preserving local history
- Audited the current snapshot and Git history for credential-shaped content;
  real environment files, signing keys, build output and dependencies remain
  ignored
- Replaced the machine-specific VS Code workspace folder with portable,
  repository-relative project and firmware folders
- Added private-key container extensions to the repository safety rules and
  refreshed the root project status for the current production-capable release

## 2026-08-12 — Intelligent GPS drift protection and flexible OTA released ✅

- Released signed firmware `0.1.3` build `2026081205`, release
  `810b5323-e375-4c1b-a6b6-9e3d9743026f`, with private R2 object size
  1,601,808 bytes and SHA-256
  `79c44dc0f05e31ad415e79f270940e09d1ecb6665f31fd60ef1b671542a38570`
- Added rider-selectable **Wi-Fi only (recommended)** and **Any internet** OTA
  policies; Any internet still prefers Wi-Fi but permits A7670G 4G when Wi-Fi is
  unavailable, while signature/hash/size/board/build and parked/disarmed gates
  remain mandatory
- Added an intelligent GPS confidence engine that combines accuracy, HDOP,
  satellite count, recent stationary-location consensus, GPS speed and IMU
  motion; isolated stationary drift is retained as no-fix evidence and cannot
  move the live bike, start a trip or trigger a geofence alert
- Added a bilingual, dismissible premium announcement banner whose action opens
  Firmware Update directly, plus bilingual download-choice and drift-engine UI
- Deployed staging Worker version `f3ad45f9-45c4-499b-90df-e62e78abf92f`,
  production Pages deployment `e7ed5481`, and matching staging Pages deployment
  `b5142bcb`; the live Mini App now targets the verified operational tracker API
- Canary `BB-00000001` received the command over Wi-Fi, downloaded, rebooted,
  passed its 15-second trial health window, and acknowledged build `2026081205`
  as `acked/applied`; D1 rollout status is `installed`
- All 88 backend tests, production Mini App build, Worker dry run, firmware build
  and mobile browser QA pass

## 2026-08-12 — Rider firmware update UI and API deployed ✅

- Applied migration 012 to staging and production after confirming neither D1
  database contained duplicate active OTA commands; exported the production D1
  database before the schema change
- Deployed staging Worker version `97ddc024-5fd2-4e86-b45f-d045af65fca2` and
  the staging Pages branch, then passed health, authentication and bundle smoke
  tests before promotion
- Deployed production Worker version `13e3edce-97a3-45e0-8b7e-b9a7fde966f9`
  and production Pages deployment `c586a51c`; the live bundle contains the new
  Account → Settings → Firmware Update experience and targets production data
- Enabled the production `workers.dev` Worker origin for the Mini App because
  the existing custom domains are protected by a Cloudflare Managed Challenge;
  the custom API route remains available for compatibility while Mini App API
  requests now use the verified challenge-free origin
- Verified the production Worker origin returns health 200, rejects anonymous
  firmware-update access with 401, serves the new route with correct production
  CORS, and that the production unique OTA index exists
- No firmware release was published and no device update was queued by this
  deployment; riders explicitly start a signed update from the Mini App

## 2026-08-12 — Rider-facing firmware update experience completed locally ✅

- Added **Account → Settings → Firmware Update** to the Telegram Mini App with
  a polished mobile sheet, installed/latest version comparison, signed-release
  progress, live readiness checks and one clear Install/Retry action
- Added full English and Khmer copy explaining the GPS reliability update:
  corrupted NMEA rejection, original-time offline replay and impossible-jump
  filtering without losing the following valid location
- Added authenticated owner-only firmware status and install endpoints; the
  server selects only the newest active signed XIAO ESP32-S3 release, rejects
  stale UI requests, requires the signed OTA bootstrap and deduplicates active
  commands while preserving device-side Wi-Fi/parked safety gates
- Corrected the Mini App device contract so `firmware_version` and
  `firmware_build` are visible instead of the UI silently hiding the installed
  version
- Added migration 012 to prevent duplicate active OTA commands for one device
  and release
- Added an offline replay regression using valid → impossible teleport → valid
  GPS points; the teleport becomes no-fix diagnostic evidence and the next real
  point remains accepted
- All 85 backend tests, the production Mini App build, staging Worker dry run,
  whitespace validation and the signed staging firmware build pass; mobile
  visual QA passed at 390×844
- Deployment is intentionally pending so the broader uncommitted worktree can
  be reviewed and shipped as a deliberate staging release; production was not
  modified

## 2026-08-12 — Signed global Wi-Fi OTA verified end to end ✅

- Added internet-reachable firmware delivery through the signed telemetry
  command channel, an authenticated Worker download endpoint, private Cloudflare
  R2 storage and D1 release/rollout state; the operator no longer needs to be on
  the motorcycle's LAN
- Added ECDSA P-256 release-manifest verification, board and monotonic-build
  checks, bounded size and SHA-256 verification, HTTPS certificate validation,
  inactive-slot streaming and a 15-second post-boot health acknowledgement
- OTA installation is allowed only on trusted Wi-Fi while the controller is
  disarmed and stationary; a SIM is not required and cellular firmware download
  remains a future feature
- Created private staging bucket `bikeboss-firmware-staging`, backed up staging
  D1, applied migration 011 and deployed only staging Worker version
  `46dd5d21-e139-4e60-b58c-51acc4680788`; production was not modified
- The first canary exposed a 4 KiB loop-stack download buffer fault; moved the
  buffer to heap, revoked build `2026081202`, cancelled its rollout, and reflashed
  the corrected USB bootstrap before retrying
- Canary build `2026081203` proved signed offer, private remote R2 download,
  binary verification, inactive-slot write, reboot and acknowledgement; a final
  health-window correction prevents early acknowledgement on Arduino cores that
  expose the selected slot as already valid
- Final canary `0.1.2` build `2026081204`, release
  `248cb4ac-58d3-4a07-b2a4-e052b452f7f6`, installed on `BB-00000001`; serial
  proved the 15-second health window and D1 recorded rollout `installed`, command
  `acked/applied`, matching firmware metadata and continuing signed telemetry
- Added a staging release tool with remote-R2 upload and duplicate-build
  preflight, plus `docs/GLOBAL_OTA_RUNBOOK.md` covering required inputs, cohort
  expansion, revocation, SIM setup and remaining production gates
- All 82 backend tests, the signed release firmware build, staging Worker dry
  run, whitespace checks, public health check and unsigned-download rejection
  pass

## 2026-08-11 — GPS corruption and reconnect replay hardening ✅

- Audited 7,357 staging telemetry rows from August 10–11 and confirmed 1,533
  delayed uploads (maximum delay 2,082 seconds) during real connectivity loss
- Found impossible accepted fixes, including an approximately 11,464 km jump
  to `0.25, 0.383333`, a 246 km longitude jump to `102.650003`, and immediate
  returns to Phnom Penh; several corrupt rows reported HDOP 29–999.9 or zero
  satellites despite `gps_fix=1`
- Identified two independent amplifiers: L76K NMEA was parsed without checksum
  or degree/minute validation, and replayed offline telemetry was ranked by
  upload time instead of the original GPS capture time
- Added firmware NMEA XOR checksum verification, strict coordinate and
  hemisphere parsing, rejection counters and serial diagnostics
- Added a cloud defense using the shared `haversineDistance()` implementation:
  unusable-HDOP and physically impossible jumps are stored as no-fix evidence,
  excluded from trips/geofences/Wi-Fi learning, and logged for diagnosis
- Live telemetry now ranks samples by capture time while connectivity uses the
  newest receipt time; recent and historical trails remove impossible jumps
  and preserve the following valid point
- Added regression tests using the exact observed corrupt coordinates; all 80
  backend tests pass and the signed staging ESP32-S3 firmware builds successfully
- Deployment and device flashing remain pending because the worktree contains
  broader in-progress changes that must ship together deliberately

---

## 2026-08-10 — Current bot and Mini App user guide added ✅

- Added `docs/CURRENT_BOT_APP_USER_GUIDE.md` for teammates and field testers
- Marked the current documented bot and Mini App release as **V0.3**
- Documented first-time Telegram setup, device linking, all current bot
  commands, Mini App tabs, map/history controls, safe zones, trips, events,
  subscriptions, trusted Wi-Fi, language/theme settings and the Developer
  Field Lab
- Added visual command/data-flow diagrams, workflow checklists, status-message
  explanations and troubleshooting guidance
- Clearly labelled staging-only behavior, shared prototype read-only controls,
  test payment pricing and hardware limitations

---

## 2026-08-10 — Team-facing project progress summary added ✅

- Added `docs/PROJECT_PROGRESS_SUMMARY.md` as a plain-language source for team
  documentation and presentation updates
- Summarized the project scope, system data flow, verified hardware, firmware,
  cloud, Mini App, power design, staging tests and remaining production gates
- Added Mermaid architecture and timeline visuals, wiring diagrams, status
  tables and a suggested nine-slide presentation structure
- Kept verified prototype results separate from planned 12 V, backup-battery,
  real-SIM, relay, authenticated BLE and production work

---

## 2026-08-10 — Crash lean false-positive and stationary speed recalibration ✅

- Audited 4,580+ staging telemetry samples and 240 historical CRASH events;
  confirmed the old `CONFIRMED` state repeatedly dispatched alerts even while
  the bike was upright and still (`Az` about 9.7–9.9 m/s², gyro near zero)
- Replaced one-position X/Y accelerometer bias subtraction with scalar 1g
  normalization plus a learned mounting-independent upright gravity vector, so
  rotating/leaning the motorcycle no longer manufactures impact magnitude
- Crash confirmation now requires the original 2g impact and 2.1 rad/s rotation,
  at least 3 seconds settling, and 2 continuous seconds both down and still;
  ambiguous candidates expire after 8 seconds
- Removed ten-second repeat alerts, preserved trigger-time impact/rotation peaks,
  added 5-second upright recovery before detector re-arm, and added a one-minute
  backend dedupe guard for older firmware during rollout
- Measured stationary L76K noise up to about 2.9 km/h and added a two-consecutive-
  fix 3 km/h movement gate with 1 km/h stop hysteresis
- Added regression coverage for mounting-angle lean calibration and isolated GPS
  spikes; all 73 backend tests and the signed staging firmware build pass
- Deployed staging Worker version `e7f8b32a-be1b-4a0e-8d03-6fb279b1d5e6`,
  flashed the signed staging firmware to the XIAO on COM7 and verified every
  written image hash
- Fresh stationary hardware calibration normalized `25.32 → 9.81 m/s²` with
  `0.01 m/s²` noise; twelve consecutive post-flash heartbeats reported speed 0,
  stationary motion, crash stage 0 and no new CRASH events

---

## 2026-08-10 — Phone-first Developer Field Lab ✅

- Added a staging-only bilingual Developer Field Lab under Account so outdoor
  testing can be completed with only a phone, its hotspot and the Telegram Mini
  App; production builds do not expose the entry point
- Added four-second authenticated live diagnostics for controller connectivity,
  GPS fix/satellites/accuracy, uplink and signal, motion/speed, vehicle battery
  and telemetry sequence
- Added seven guided test suites covering GPS, hotspot recovery/offline buffer,
  geofence lifecycle, crash calibration, vehicle/backup power, relay safety and
  a complete phone-only trip
- Added pass/fail tracking, notes, up to 20 timestamped evidence snapshots and
  native phone report sharing, persisted locally per device without a schema or
  backend mutation
- Kept crash and immobilizer tests manual and guidance-only because the current
  firmware does not yet provide safe remote calibration interlocks
- Verified production and staging frontend builds, all 72 backend tests,
  JavaScript syntax and whitespace checks, then deployed Pages build `2340d837`
  and verified the public staging HTML, Developer chunk and API health endpoint

---

## 2026-08-10 — Stale GPS signal status corrected ✅

- Fixed Home and Account screens treating the last cached `gps_fix=1` packet
  as a current satellite lock after the ESP32 uplink had gone offline
- GPS now has three distinct UI states: fixed, searching and unavailable; an
  offline tracker always reports GPS as unavailable because the cloud cannot
  observe a later receiver disconnect
- Preserved cached coordinates as an explicitly labelled last-known location
  instead of presenting them as live or discarding useful recovery data
- Map Live mode no longer presents cached GPS accuracy as current while the
  tracker is stale/offline; historical playback retains recorded accuracy
- Added matching English and Khmer strings, corrected demo connectivity
  propagation, and verified the frontend production build plus diff checks

---

## 2026-08-10 — Authenticated ESP32 Wi-Fi OTA installed ✅

- Confirmed `COM7` is the XIAO ESP32-S3 through Espressif USB VID/PID and a
  live bootloader probe; chip revision, 8 MB PSRAM and MAC were verified before
  writing
- Added ArduinoOTA to signed trusted-Wi-Fi builds with a device-specific
  password derived by HMAC-SHA256 from the provisioned signing key; unsigned
  bootstrap firmware never exposes the updater
- Kept OTA handling inside the non-blocking main loop and pauses normal network
  work only while an authenticated update is actively transferring
- Added a PlatformIO OTA environment, local credential-derivation helper and
  operator instructions; the 8 MB partition table already provides dual OTA
  application slots
- Built and flashed `seeed_xiao_esp32s3_staging_signed` to `COM7`; esptool
  verified every written image hash and rebooted the controller successfully
- Live serial and staging D1 verification confirmed signed v2 heartbeats every
  five seconds with HTTP 200 and increasing sequence numbers
- Completed the first authenticated Wi-Fi OTA upload over the private `Hi`
  hotspot to `172.20.10.2`; PlatformIO reached 100% and the device returned
  `Result: OK` before rebooting
- Post-update checks confirmed 0% packet loss, the expected ESP32 MAC
  `1c:db:d4:75:7c:48`, and working mDNS resolution at
  `bikeboss-bb-00000001.local`

---

## 2026-08-10 — Crash visibility and satellite map controls ✅

- Added a bilingual crash-alert switch to route history so riders can show or
  hide `CRASH` locations without removing geofence or other event markers
- Added a bilingual street/satellite segmented control backed by OpenStreetMap
  and Esri World Imagery with provider-specific attribution
- Kept route geometry, direction arrows, playback position, zones and event
  overlays intact when changing the base map
- Frontend production build, Worker dry run, `git diff --check` and all 72
  backend tests pass
- Exported a 3.75 MB staging D1 backup, baselined its already-present migrations
  and applied `010_trip_tracking.sql`; Wrangler now reports no pending staging
  migrations
- Deployed staging Worker version `efbba32e-566c-404b-85a5-46908e3ad462`
  and Pages deployment `c15d47a3`; the staging alias, health endpoint, CORS and
  published map assets were verified publicly

---

## 2026-08-10 — Direction-aware route playback ✅

- Route playback now keeps the map centered on the selected GPS sample while
  the timeline slider is dragged and automatically moves to road-level zoom
- Replaced the history playback dot with a directional device marker that uses
  recorded GPS heading when available and derives bearing from adjacent route
  points otherwise
- Added visible travel-direction arrows along the purple history route while
  excluding dashed connectivity gaps so missing data never implies direction
- Split static route, event, zone and moving-device Leaflet updates so dragging
  long history ranges moves only the playback marker instead of rebuilding the
  full route on every slider step
- Frontend production build and `git diff --check` pass; automated browser
  screenshot validation was unavailable because the local browser runtime
  could not initialize

---

## 2026-08-10 — Full-detail history and automatic trip recording ✅

- Superseded the earlier long-range sampling compromise: 1-hour, 6-hour,
  24-hour and 7-day history now use the available raw GPS samples and the same
  2 m geometry simplification, preserving turns and small road-level movement
  consistently across every range
- Kept route breaks based on the same fixed 90-second connectivity threshold so
  missing telemetry is shown as a gap instead of a misleading straight line
- Added automatic trip lifecycle handling: confirmed motion or GPS speed of at
  least 3 km/h starts a trip, brief stops remain part of it, 3 minutes
  stationary closes it and telemetry gaps over 5 minutes split separate trips
- Linked each accepted telemetry point to its trip and process offline batches
  oldest first, allowing every trip to retain its own detailed route
- Added an authenticated trip-detail endpoint and an Activity detail sheet with
  the route map, status, start/end time, duration, distance, maximum and average
  speed, safety score and eco score in English and Khmer
- Firmware now reports stable moving/stopped transitions after a 5-second
  debounce instead of waiting for the normal heartbeat, so trip boundaries are
  identified sooner without reacting to momentary sensor noise
- Added migration `010_trip_tracking.sql`; backend tests pass 72/72, the
  frontend production build passes and all six firmware environments build
  successfully

---

## 2026-08-10 — Six-hour route geometry detail restored ✅

- Found that the history API reduced the 6-hour route from a 5-second cadence
  to one point every 30 seconds, causing Leaflet to connect missed turns with
  long straight purple segments
- Raised the bounded trail budget to retain up to 4,320 five-second samples for
  6-hour history, matching the geometric detail of the 1-hour view
- Kept 24-hour and 7-day history bounded at 30-second and 5-minute sampling,
  with per-range query limits derived from the actual bucket count
- Added regression coverage for the bucket interval and maximum result count of
  every history preset
- Focused trail tests pass 3/3, the complete backend suite passes 66/66 and the
  frontend production build completes successfully

---

## 2026-08-09 — Telegram profile avatar in Mini App ✅

- Read Telegram Mini App `WebAppUser.photo_url`, `last_name` and existing name/
  username fields from the launch context; secure app identity still comes from
  the server-validated Telegram `initData` session
- Added a reusable avatar component that shows the Telegram profile photo when
  available and falls back to the user's initials or a generic user icon when
  the photo is hidden, missing or fails to load
- Added the avatar to the header as a shortcut to Account and upgraded the
  Account profile card with the user's Telegram name and handle
- Frontend production build completed successfully
- Deployed staging Pages preview `https://fb84acc1.bikeboss-app.pages.dev` and
  updated `https://staging.bikeboss-app.pages.dev`; verified published asset
  `index-BMHH9hHn.js` contains the avatar and fallback logic

---

## 2026-08-09 — Bot restored after custom-domain challenge blocked Telegram ✅

- Investigated a second `@BikeBoss_bot` outage and found Telegram's webhook URL
  empty with one queued update
- Confirmed `bikeboss.creative-studio.blog/webhook/*` was serving a Cloudflare
  managed browser challenge. Telegram and the Python payment listener cannot
  execute the challenge JavaScript or store its cookies, so the custom-domain
  path is unsuitable for machine webhooks without an explicit WAF skip rule
- Restored Telegram to the challenge-free endpoint
  `https://bikeboss-api-staging.sokpanha-nov1999.workers.dev/webhook/telegram`
  and moved the local ABA payment listener to the matching `/webhook/abapayway`
  endpoint
- Removed the custom staging route and restored `routes = []` so staging cannot
  inherit or conflict with production routes on future deploys
- Restarted the payment listener as process `16860`; it connected to Telegram,
  started its QR fallback server and confirmed the new Worker webhook target
- Deployed clean staging Worker version `433d1cb1-6ef2-4b86-8b6f-ae240f8ad848`
- Final `/help` proof returned HTTP 200 and notification `185` records
  `sent = 1`; Telegram reports zero pending updates and no delivery error

---

## 2026-08-09 — Faster controller-offline UX + history without GPS ✅

**Controller disconnect detection:**
- Reduced only the staging `HEARTBEAT_TIMEOUT_MS` from 10 minutes to 30 seconds;
  production remains at 10 minutes because its adaptive firmware may report as
  slowly as every five minutes while disarmed and stationary
- Home, Account and Map continue polling every 4–5 seconds, so unplugging the
  staging XIAO now becomes visible after roughly 30–35 seconds instead of up to
  ten minutes while still tolerating several missed five-second heartbeats
- Map location freshness now trusts the server-derived connectivity state, with
  a 45-second client fallback if connectivity metadata is unavailable

**Map history while GPS is unavailable:**
- Decoupled trail rendering from the current GPS marker; historical route
  segments and connection gaps now render even when `gps_fix = 0`
- When both the live fix and recent live trail are unavailable, Map
  automatically requests the last 24 hours, uses those points in Live mode and
  fits the viewport to the old route instead of falling back to a blank Phnom
  Penh overview
- Added bilingual EN/KM messaging that clearly says the GPS is unavailable and
  the last recorded route is being displayed

**Validation and staging release:**
- Current offline prototype proof: connectivity is `offline`, current GPS fix
  is `0`, live trail contains `0` points and the 24-hour history endpoint still
  returns **81** points across 18.858 km with two recorded connection gaps
- Backend is 66/66 passing; frontend staging build passes with EN/KM parity
  **329/329** and Worker dry-run confirms the 30-second staging timeout
- Deployed Worker version `43b5ead8-aaf2-494d-8e5a-03581ca97b9c` and Pages
  deployment `https://46cd5186.bikeboss-app.pages.dev`; the staging alias serves
  `index-CiJogZ6B.js` and `MapScreen-CBxhCPoO.js`, including the 24-hour fallback
- Production Worker, production API timeout and production frontend were not
  changed

---

## 2026-08-09 — Full system audit and payment listener recovery ✅

**Live application and cloud verification:**
- Production and staging Mini App entry points, production/staging API health,
  the custom-domain Telegram webhook and all deployed staging JS/CSS chunks
  return HTTP 200
- Generated a valid Telegram Mini App session and verified `/me`, Activity,
  live device status, six-hour trail, zones, suggestions and trusted Wi-Fi
  profiles against staging; every endpoint returned HTTP 200
- Staging CORS allows the staging Pages origin, unauthenticated v2 requests are
  rejected with HTTP 401 and D1 `PRAGMA quick_check` returns `ok`
- Telegram `/status` completed through
  `https://bikeboss.creative-studio.blog/webhook/telegram`; notification `182`
  records `sent = 1`, pending webhook updates are zero and Telegram reports no
  delivery error

**Builds, tests and repairs:**
- Backend is **66/66 passing** after aligning three stale KHQR expectations with
  the verified PayWay format: digits-only tag-30 merchant ID and no fabricated
  `PAYWAY@ABA` session prefix
- Exact staging frontend build passes and reproduces deployed assets
  `index-B_qYQsd6.js` and `MapScreen-CWREzkms.js`; EN/KM parity is **328/328**
  and frontend/backend production dependency audits report zero vulnerabilities
- Every configured XIAO ESP32-S3 firmware environment builds successfully;
  remaining output is limited to existing ArduinoJson deprecation warnings
- Repaired the partially overwritten Python payment listener, restored its
  Pyrogram watcher and localhost QR service, pointed it to the active
  custom-domain staging payment webhook and started it as process `30056`
- Live PayWay QR test for `$0.10` returned HTTP 200 with a 265-character ABA QR
  string and rendered image; the listener is connected to Telegram and watching
  the configured ABA notification group
- Cancelled obsolete pending ARM command `5` as `cancelled_stale_audit`, leaving
  zero pending/delivered commands, and ignored local Telegram session and
  PayWay investigation artifacts so credentials cannot be committed by mistake

**Remaining operational limitations:**
- The physical prototype is offline: its last heartbeat was
  `2026-08-09 09:59:02 UTC`, and no XIAO/LilyGO USB serial ports are currently
  connected. Cloud features work, but live GPS/ARM acknowledgement requires the
  hardware to be powered and online
- The complete current feature set remains on staging. The production API at
  `api.creative-studio.blog` still runs the older v1 deployment and returns 404
  for `/api/v2/me`; do not promote staging until the documented production and
  field-test gates are intentionally completed

---

## 2026-08-09 — Telegram bot webhook restored ✅

- Investigated `@BikeBoss_bot` after it stopped responding while both the
  production and staging Worker `/health` endpoints remained HTTP 200
- Confirmed the staging Worker still had its `TELEGRAM_BOT_TOKEN` secret, but
  Telegram `getWebhookInfo` reported an empty webhook URL, so no updates were
  being delivered to BikeBoss
- Initially restored the missing webhook through the staging `workers.dev`
  endpoint, then moved it to the stable project-domain route
  `https://bikeboss.creative-studio.blog/webhook/telegram`
- Routed only `bikeboss.creative-studio.blog/webhook/*` to the staging Worker,
  preserving the existing Cloudflare Pages Mini App on every other path;
  Worker version `4e7f38e9-6d8d-43c6-a723-fe5f4ddd1b28` is live
- Verified Telegram accepted the registration, the webhook route returns HTTP
  200 `OK`, pending updates are zero and Telegram reports no delivery error
- Replayed a controlled `/start` update through the live staging webhook for
  the existing staging chat; the Worker returned HTTP 200 and Telegram recorded
  the reply as successfully sent with no `PEER_ID_INVALID` error
- Repeated the `/start` proof through the custom-domain route; staging D1
  notification `178` records `sent = 1` with no Telegram error
- Added a safe `GET /webhook/telegram` status response so opening the webhook
  in a browser now returns HTTP 200 with `accepts: POST` instead of a confusing
  route-not-found response; real Telegram updates continue using POST

---

## 2026-08-09 — Staging test IDs upgraded to full prototype access ✅

- Granted `BB-TEST0001` through `BB-TEST0005` real-device capabilities in the
  staging environment while keeping shared aliases read-only in production
- ARM/DISARM from the Mini App, legacy API or test bot now queues against the
  connected `BB-00000001` prototype and preserves the requesting alias in
  command metadata and audit history
- Trusted Wi-Fi profiles for all five test IDs now read and manage the same
  encrypted profile set used by the physical prototype, including device sync
- Each test ID keeps independent safe zones; incoming prototype GPS samples now
  evaluate those zones separately so their owners receive breach/return alerts
- Focused alias tests pass (4/4), staging Worker compile passed, and Worker
  version `c76ddc6c-f840-447a-8d79-0ddcddbe2deb` is live

---

## 2026-08-09 — Telegram iPhone sheet scrolling and Khmer layout fixed ✅

**Mobile sheet architecture:**
- Moved every modal sheet into a document-level portal so app screen animation
  and Telegram WebView stacking contexts cannot clip the overlay
- Separated the animated sheet frame from its dedicated `-webkit-overflow-scrolling`
  touch surface, locked only the page behind it and added a fixed accessible
  close control that remains reachable at every scroll position
- Prevented flex children from shrinking to fit the iPhone viewport; this was
  compressing 301 px connection panels to roughly 108 px and creating the
  overlapping-card appearance in the reported screenshot
- Added Telegram dynamic viewport/safe-area handling plus Khmer-aware line
  heights and narrow-screen wrapping for connection status and Wi-Fi actions

**Verification and staging release:**
- Tested at a true 393 × 852 mobile viewport in both Khmer and English; the
  sheet exposes an 802 px viewport over 1,211–1,214 px of natural content
- Real emulated touch input scrolls the sheet to 395 px while the page behind
  remains at 0 and the fixed close control remains at the top
- Frontend production/staging builds pass, EN/KM parity is 328/328 and
  `git diff --check` reports no whitespace errors
- Deployed only to the staging Pages branch at immutable deployment
  `https://091223fc.bikeboss-app.pages.dev`; the test-bot alias
  `https://staging.bikeboss-app.pages.dev` serves the new hashed assets

---

## 2026-08-09 — Encrypted trusted Wi-Fi roaming deployed to staging ✅

**Integrated connection platform:**
- Added up to eight trusted profiles with exact SSID, friendly place label,
  priority, encrypted device-specific credential envelope and revisioned sync
- Replaced the radio-off retry bug and single-network loop with asynchronous
  scan, strongest trusted candidate selection, cooldown, two-minute dwell and
  12 dB roaming hysteresis
- Added non-blocking A7670G SIM/registration/attach/PDP fallback setup; when
  Wi-Fi and 4G both fail, existing SPIFFS replay remains the delivery safety net
- Added opaque profile IDs to signed telemetry and coarse GPS connection-area
  learning without changing the shared geofence/location source of truth

**Owner experience and security:**
- Added bilingual Account → Connection details → Trusted Wi-Fi management with
  list/add/edit/remove, write-only password, active network, sync revision,
  priority, learned area and cellular/offline fallback explanations
- Migration 009 and the new Worker were applied only to staging after a D1
  export; production remains unchanged
- Rotated only the staging device master, seeded `FARM KAFE` as encrypted
  ciphertext from the local ignored credential and provisioned an ignored
  signed-device header; no credential was printed or committed

**Verification and release:**
- New credential crypto/codec tests pass; full backend is 62/65 with only the
  three pre-existing KHQR fixture mismatches
- Signed sync test returned `WIFI_SYNC` revision 1 and decrypted the seeded
  profile successfully without exposing its password
- Staging and signed firmware builds pass; frontend build has 327/327 EN/KM key
  parity
- Deployed Worker version `9ac721ee-50b1-4aae-88a2-2ab0b8b099a7` and Pages
  deployment `https://efc253ff.bikeboss-app.pages.dev` with staging alias live
- Flashed the signed staging firmware to XIAO COM7 and verified `FARM KAFE`
  selection at about -57 to -60 dBm, encrypted profile revision 1/1 applied,
  valid L76K GPS fix and signed HTTP 200 telemetry with monotonic sequences
- Fixed the post-boot/reconnect dead period by making uplink restoration trigger
  an immediate heartbeat; the staging field build now reports every five
  seconds and successfully replays a sample buffered during profile handover
- LilyGO A7670G UART recovery passes, but the modem correctly reports no SIM
  inserted; Wi-Fi is therefore the active uplink and cellular fallback remains
  unavailable until a data SIM is installed

---

## 2026-08-09 — Connection Details diagnostics deployed to staging ✅

**Owner-facing connection UX:**
- Added a bilingual Account → Settings → Connection details sheet that keeps
  the tracker uplink, BikeBoss Cloud and the phone/Mini App connection separate
- Tracker diagnostics now show online/offline freshness, Wi-Fi versus mobile
  internet, cellular generation, friendly network profile, signal dBm/quality,
  last heartbeat and the independent L76K GPS-fix state
- Phone diagnostics use the browser Network Information API when Telegram's
  WebView provides it, otherwise state honestly that the network name/carrier
  is not shared instead of guessing Wi-Fi or cellular
- Added a route diagram and offline explanation: GPS samples continue to queue
  on the tracker and replay after internet connectivity returns

**Privacy-safe integration contract:**
- Added optional `uplink_label` through firmware compact/verbose telemetry,
  codec validation, D1 persistence and client connectivity responses
- The label is a short profile token such as `phone_hotspot`, localized by the
  Mini App; raw SSIDs, passwords, IP addresses, SIM IDs and account data remain
  excluded from telemetry
- Added migration 008 and applied only that migration to staging after a D1
  export; production schema and Worker were not changed

**Verification and staging release:**
- Feature-specific backend tests pass 15/15; full backend remains 58/61 with
  only the three pre-existing KHQR fixture mismatches
- Frontend build and ESP32 staging build pass; COM7 was flashed successfully
- Live staging ingestion on unused `BB-TEST0005` persisted Wi-Fi, `-58 dBm` and
  the localized profile token through Worker → D1
- Deployed staging Worker version `519b3304-0321-4420-99be-0b951a831eab`
- Deployed staging Pages build `https://244b96bd.bikeboss-app.pages.dev`; the
  alias `https://staging.bikeboss-app.pages.dev` serves HTTP 200 and contains
  the Connection Details UI with the staging API origin
- Post-flash serial verification shows the L76K has a valid GPS fix, while the
  ESP32 is currently buffering because its configured phone hotspot is not
  reachable; Wi-Fi credentials were deliberately not changed in this task

---

## 2026-08-09 — Reliable Tracking Everywhere foundation deployed to staging ✅

**Cross-feature architecture:**
- Added `docs/TRACKING_PLATFORM_ROADMAP.md` so geofence, trips, crash,
  anti-theft, owner presence and future AI share one signed telemetry/event
  stream instead of growing separate location implementations
- Defined the next runtime connectivity state machine: trusted Wi-Fi preference,
  stable cellular fallback, local ordered queue and signed replay, with network
  identity kept private
- Kept GPS collection and server-side geofence lifecycle independent from the
  selected internet uplink

**History and connectivity foundation:**
- Added privacy-safe telemetry fields for uplink type, signal dBm and cellular
  generation across firmware, telemetry codec, D1 and client status responses;
  SSID, hotspot name, password and local IP are never persisted
- Added the authenticated `/api/v2/devices/:id/trail` route with bounded 1h,
  6h, 24h and 7d windows, server-side time buckets and event overlays
- Historical paths use captured time where available, mark delivery outages as
  data gaps and exclude dashed gaps from calculated route distance
- Live route payloads now preserve connection, arm, motion and crash context so
  other security features can share the same map evidence

**Map UX:**
- Added Live/History modes, timeline scrubbing, responsive range presets,
  route/event rendering, route distance/sample/gap summaries and bilingual
  explanations
- Dragging Live mode pauses camera following and exposes a Return to Live action
- Long History windows stay bounded for Telegram WebView performance; route
  gaps render separately rather than inventing movement through missing data
- Live status now identifies Wi-Fi/4G when reported while retaining separate
  controller freshness, GPS quality and vehicle battery semantics

**Verification and staging release:**
- Backed up staging D1, applied only migration 007, and verified all three
  uplink columns plus the GPS-history index
- Deployed staging Worker version `43e2c96d-759e-4b26-97eb-ff310584ffd1`
- Deployed staging Pages build `https://ea240f47.bikeboss-app.pages.dev` and
  verified alias `https://staging.bikeboss-app.pages.dev` serves HTTP 200 with
  the staging API bundle; History correctly requires an authenticated session
- Verified the actual historical sampling SQL against staging telemetry (31
  sampled points across the current test window)
- Frontend production build and ESP32 staging build pass; backend is 58/61 with
  only the same three unrelated KHQR fixture mismatches
- Flashed COM7 with the new staging firmware and enabled automatic replay for
  both legacy staging and signed production queues. The phone hotspot was off
  during final serial verification, so the new firmware correctly buffered
  five-second samples; uplink-field cloud proof awaits the next hotspot-on pass

---

## 2026-08-09 — Live map and geofence latency reduced ✅

**Measured cause:**
- Staging D1 showed the field-test firmware posting almost exactly every
  29–31 seconds
- Exit and re-entry correctly require two samples to reject GPS drift, so each
  confirmation added another 30-second sample interval
- The Mini App shell polled every 15 seconds, Map every 10 seconds, and Activity
  loaded only once; these waits accumulated and manual Refresh appeared faster

**Responsive staging behavior:**
- Added a staging-only 5-second firmware heartbeat override while preserving the
  normal production and signed adaptive cadences
- Kept two-sample geofence confirmation, reducing expected breach/re-entry
  confirmation from roughly 30–60 seconds to roughly 5–10 seconds without
  weakening the anti-false-alarm rule
- Home now refreshes every 5 seconds, Map every 4 seconds, and Activity every 8
  seconds while visible
- Foreground/focus changes trigger an immediate refresh, and request locks plus
  completion-based Map scheduling prevent overlapping API calls

**Verification and release:**
- Frontend production build passes; firmware staging build passes and its
  PlatformIO build metadata confirms `HEARTBEAT_INTERVAL_MS=5000UL`
- Flashed the responsive staging firmware to XIAO COM7 with the existing
  gitignored phone-hotspot credentials
- With the phone hotspot unavailable, a passive serial timing check still
  observed five consecutive telemetry attempts at `5.00, 5.04, 4.97, 5.00`
  second gaps, proving the new edge cadence; failed samples buffered locally
- Deployed the staging Mini App to immutable Pages deployment
  `https://79f2f1a0.bikeboss-app.pages.dev` and alias
  `https://staging.bikeboss-app.pages.dev`
- Verified the deployed asset hashes, staging API origin, 5-second shell timer
  and 4-second Map timer; the phone hotspot was off during the final cloud-gap
  measurement, so the next powered field pass should confirm the same cadence
  in D1
- Backend remains 54/57 tests with only the same three unrelated KHQR fixture
  mismatches; no Worker or D1 mutation was required

---

## 2026-08-09 — Prototype telemetry restored and power status corrected ✅

**Root causes found:**
- The XIAO firmware was posting live bench telemetry to production while the
  Telegram test Mini App and `BB-TEST0001`–`BB-TEST0005` aliases read staging,
  so the bot/API and Mini App appeared out of sync
- Wi-Fi bench firmware fabricated a nominal `12.6 V` when the D0 vehicle
  voltage-divider sensor was not installed, making an unpowered motorcycle
  battery look healthy
- “Online” described the USB/Wi-Fi-powered XIAO controller, not motorcycle
  main power; the interface did not explain that distinction

**Hardware recovery and live proof:**
- Detected the XIAO on COM7; MPU6050 calibration passed at approximately
  `9.79 m/s²`, Wi-Fi connected and heartbeat POSTs returned HTTP 200
- Confirmed the power-bank-fed LilyGO L76K is streaming NMEA over GPIO22 → D2;
  it currently has no satellite fix indoors
- The current D6/D7 modem wiring is reversed relative to the recommended map;
  firmware switched to its alternate UART orientation after three retries and
  recovered the A7670G handshake with `AT` → `OK`
- Added and flashed `seeed_xiao_esp32s3_staging` on COM7, routing the prototype
  to the isolated staging Worker without changing the normal production build
- Four old queued staging commands were delivered on the first reconnect; the
  controller was explicitly returned to DISARMED and a clean heartbeat verified
  `arm_state = 0`

**Truthful status behavior:**
- Bench firmware now omits battery voltage when D0 sensing is disabled instead
  of inventing 12.6 V; compact telemetry also accepts a missing measurement
- Added server-derived online/offline state based on heartbeat age and a
  bilingual bot report that distinguishes “controller online” from “vehicle
  battery not measured (sensor not connected)”
- Shared prototype bot commands now read the source device's status/location/
  trips while ARM/DISARM remains safely locked for multi-user testing
- Mini App Home uses server connectivity and shows “Sensor not connected” for
  the absent vehicle-battery divider

**Phone + power-bank field mode:**
- Firmware now makes the first telemetry heartbeat due immediately after boot,
  so field tests do not depend on the serial `w` command or a connected PC
- Stabilized external L76K fix handling with a 10-second freshness window so a
  single void RMC/GGA sentence cannot erase a valid position before telemetry
- Documented the standalone topology: phone 2.4 GHz hotspot, both XIAO and
  LilyGO powered from a dual-output power bank, common ground retained, and
  L76K antenna tested outdoors
- Built and flashed the updated staging image to COM7. A passive reboot test
  sent no serial command and received HTTP 200 automatically; the staging API
  then confirmed controller online, `gps_fix = 1`, live coordinates, no false
  vehicle-battery reading, and final `arm_state = 0`
- Reflashed COM7 with the tester's phone hotspot credentials stored only in the
  gitignored `firmware/include/secrets.h`; verified the target hotspot is
  connected and an automatic staging heartbeat returns HTTP 200
- One stale queued ARM command was delivered on reboot; the bench controller
  was explicitly returned to DISARMED and a fresh heartbeat confirmed the safe
  final state

**Verification and staging release:**
- Live staging D1 rows show current heartbeats, `vbat = NULL`, `gps_fix = 0`,
  calibrated IMU data and final `arm_state = 0`; all five test aliases still
  point to `BB-00000001`
- 14/14 focused status/alias/telemetry tests pass; full backend suite is 54/57
  with only the same three unrelated KHQR fixture mismatches
- Firmware staging build and COM7 upload pass; frontend build and 226/226 EN/KH
  parity pass
- Deployed Worker staging version `f8b7fb49-ef71-4fdd-9684-22fde99f0d9b` and
  Pages deployment `https://b0eee372.bikeboss-app.pages.dev`; verified health,
  CORS and exact deployed asset hashes at
  `https://staging.bikeboss-app.pages.dev`

---

## 2026-08-09 — Staging registration IDs connected to shared prototype ✅

**Shared connection model:**
- Added a staging-only telemetry alias so `BB-TEST0001` through
  `BB-TEST0005` retain separate claim ownership while reading the live GPS,
  battery, security state, trail, trips and activity of prototype
  `BB-00000001`
- Kept each test account's safe zones independent; shared-mode breach alerts
  are disabled because the physical prototype heartbeat evaluates only its own
  zones
- Blocked ARM/DISARM at both v1 and secure v2 command routes for shared aliases,
  preventing one tester from controlling the same physical bike for everyone
- Added explicit client capabilities and removed the physical source device ID
  from Mini App responses

**Mini App experience:**
- Added bilingual EN/KH shared-prototype notices on Home and Map
- Displays mirrored live data normally while replacing ARM/DISARM with a clear
  locked shared-test control state
- Explains that test-account zones persist independently and do not issue real
  breach alerts in shared mode

**Validation and staging release:**
- Added 3/3 passing alias behavior tests; frontend build and 223/223 EN/KH key
  parity pass; Worker staging dry-run succeeds
- Full backend suite remains 50/53 with only the three pre-existing KHQR fixture
  mismatches; this change introduced no new failure
- Captured D1 time-travel bookmark and SQL export before applying staging-only
  migration `006_staging_shared_prototype_aliases.sql`
- Verified all five aliases resolve to the prototype's recorded GPS fix, 12.6 V
  battery value and arm state; `BB-TEST0001` remained linked to its tester and
  the other four remain claimable
- Deployed Worker staging version `5edde156-c686-46d4-970f-111442e71f0f` and
  Pages deployment `https://7b8776c6.bikeboss-app.pages.dev`; staging alias is
  `https://staging.bikeboss-app.pages.dev`
- Confirmed deployed asset hashes, Worker health and staging-origin CORS; no
  production Worker, D1 database or Pages branch was changed

---

## 2026-08-08 — Five staging registration devices seeded ✅

- Added the idempotent, staging-only seed
  `backend/migrations/005_seed_staging_test_devices.sql`
- Created five active, unclaimed test units for new-user registration:
  `BB-TEST0001` through `BB-TEST0005`
- Added a pending v1 credential record for each unit so the secure v2 claim
  endpoint recognizes it as provisioned, while signed hardware telemetry stays
  disabled until a real credential is activated
- Verified all five records have `owner_id = NULL`, `is_active = 1`, and are
  claimable; each ID becomes unavailable after its first successful claim
- Applied only to `bikeboss-db-staging`; production D1 was not changed

---

## 2026-08-08 — Telegram Desktop scrolling and map loading fixed ✅

**Root cause and correction:**
- Reproduced the failure in desktop Chromium: the MapLibre implementation
  required WebGL, which is not reliable in every Telegram Desktop embedded
  browser, and its default wheel zoom consumed mouse-wheel events over the
  510 px map workspace
- Replaced MapLibre/OpenFreeMap with lazy-loaded Leaflet raster rendering. It
  has no WebGL dependency, preserves bike/accuracy/trail/zone overlays and the
  full map-centered zone editor, and reduced the map JavaScript chunk from
  approximately 951 KB to 165 KB
- Disabled map wheel zoom so a desktop wheel event over the map scrolls the
  Mini App; zoom remains available through +/− controls, double-click and pinch
- Corrected the root/body overflow contract for Telegram WebViews and added an
  SVG favicon so the deployed app has no failed browser requests
- Made the raster provider configurable through `VITE_MAP_TILE_URL`; staging
  currently uses correctly attributed OpenStreetMap standard tiles

**Google Maps decision:**
- Did not add Google Maps JavaScript because it requires an API key and billing
  and would add a billable dynamic-map dependency
- The no-charge Google Maps Embed product is iframe-based and cannot replace
  BikeBoss's custom live trail, accuracy circles, multiple zone layers or
  map-centered editor

**Verification and release:**
- A real 430×800 Chrome run loaded 4–6 Leaflet tiles with no map error or failed
  network request; while the pointer was over the map, one wheel event moved
  the page from scroll position 0 to 274 px
- Frontend build, 219/219 EN/KH parity, dependency audit and diff checks pass;
  the map chunk is 48.34 KB gzip
- Deployed only to `https://staging.bikeboss-app.pages.dev` via immutable Pages
  deployment `https://fa8e8085.bikeboss-app.pages.dev`; production asset hashes
  remain unchanged

---

## 2026-08-08 — Enterprise geofence Mini App deployed to staging ✅

**Mini App and user experience:**
- Rebuilt the product around four purposeful tabs: Home, Map, Activity and
  Account, with bilingual EN/KH copy, light/dark themes, skeleton loading,
  offline retention, haptics, toasts, bottom sheets and mobile-safe navigation
- Added a live MapLibre/OpenFreeMap workspace with GPS freshness and accuracy,
  a six-hour route trail, per-zone lifecycle overlays, bike/zone focus controls
  and an in-place map recovery flow
- Added complete safe-zone management: map-centered create/edit, 50–1000 m
  radius, Home/Work/School/Parking presets, pause/reactivate, version-safe
  updates, details and confirmed archive
- ARM/DISARM now shows queued → delivered → applied/failed command progress
  instead of pretending an asynchronous device command succeeded immediately
- Activity now includes geofence lifecycle evidence, map links and user
  acknowledgement; subscription invoices now use owner-derived v2 routes

**Backend, intelligence and theft-alert safety:**
- Added authenticated v2 command status, event acknowledgement, invoice and
  smart-place suggestion endpoints with device ownership enforcement
- Added deterministic parking clustering over accurate stationary samples;
  after at least 12 samples across 3 days it proposes a center, radius and
  confidence, and users can accept or dismiss each suggestion
- Added a fail-closed owner-presence contract to compact/verbose telemetry.
  Theft alerts are suppressed only for a fresh, authenticated, connected,
  high-confidence owner observation; an ordinary BLE connection never counts
- Extended D1 with owner-presence evidence, alert-suppression audit fields and
  persisted place suggestions through migration 004

**Validation and staging release:**
- Created and verified a 29,636-byte staging D1 backup before migration 004
- 24/24 focused auth, geofence, telemetry and owner-presence tests pass; the
  complete backend suite is 47/50 with only the same three existing KHQR
  fixture mismatches failing
- EN/KH key parity is 219/219; Worker syntax, Wrangler dry-run, frontend build,
  normal firmware build and signed firmware build pass
- Deployed staging Worker version
  `070b8301-3631-44fa-9a90-a6d3906dff48` and the Mini App at
  `https://staging.bikeboss-app.pages.dev`; health, auth rejection, strict CORS,
  staging API pinning and map-module delivery were verified
- Production Worker, production D1 and `bikeboss.creative-studio.blog` were not
  changed; production asset hashes were verified unchanged after deployment

**Remaining real-world gates:**
- Implement the native BLE credential challenge before firmware may report
  `owner_presence_authenticated=true`; current firmware deliberately reports
  ordinary BLE as unauthenticated, so alert suppression remains fail-closed
- Run the outdoor 100 m exit/re-entry, boundary-jitter, overlapping-zone,
  Telegram alert and physical ARM/DISARM acknowledgement field matrix
- Collect normal parking history to validate suggestion quality before calling
  the deterministic clustering stage a trained ML model or promoting it

---

## 2026-08-08 — Isolated Cloudflare staging deployed for bot testing ✅

**Staging infrastructure:**
- Deployed Worker `bikeboss-api-staging` at
  `https://bikeboss-api-staging.sokpanha-nov1999.workers.dev`
- Created APAC D1 database `bikeboss-db-staging` and applied the complete
  current schema, including telemetry v2, device credentials, versioned zones,
  geofence lifecycle state/events and audit logging
- Added an explicit `env.staging` Wrangler environment with its own D1 binding,
  no production custom route and no cron triggers
- Configured staging-only session/device signing secrets without printing or
  committing secret values

**End-to-end verification:**
- `/health` returns HTTP 200
- A signed **130-byte** compact GPS sample for `BB-00000001` returned
  `{"ok":1,"q":1,"c":[]}` and persisted the expected coordinates and 3.5 m
  accuracy in staging D1
- Replaying sequence 1 was rejected with HTTP 409 and the credential remained
  at `last_sequence=1`
- Deployed the Mini App staging build at
  `https://staging.bikeboss-app.pages.dev`, compiled against the staging API;
  Pages HTTP 200 and the CORS preflight both pass
- Telegram `@BikeBoss_bot` webhook now routes to the staging Worker and its
  menu button opens **BikeBoss Staging**

**Known unrelated validation issue:**
- 45/48 backend tests pass; the three failures are existing KHQR field-format
  expectations. Payment testing is excluded from this geofencing staging run.
- Production Worker, production D1 and the production frontend deployment were
  not changed.

---

## 2026-08-08 — Signed compact telemetry proven over real XIAO Wi-Fi ✅

**Safe test architecture:**
- Confirmed the deployed production Worker still returns 404 for the v2 device
  route, so production and its D1 database were not modified
- Added an isolated LAN receiver using the real compact decoder and exact
  HMAC-SHA256 canonical request rules with a public test-only fixture key
- Added configurable `CLOUD_SCHEME`/`CLOUD_HOST` and the
  `seeed_xiao_esp32s3_signed_wifi_local` test environment

**Real hardware proof:**
- Temporarily flashed signed Wi-Fi firmware to XIAO COM7
- XIAO sent two live compact packets of **133 bytes** with sequences **1** and
  **2**; both received HTTP 200 with `{"ok":1,"q":...,"c":[]}`
- Receiver verified the combined `X-BikeBoss-Auth` HMAC header byte-for-byte
- Both packets carried a real L76K fix at `11.6412248, 104.9197952` with
  estimated accuracy **3.5 m**
- IMU calibration, GPS, UTC synchronization, Wi-Fi transport, compact response
  parsing and modem UART recovery remained operational
- Automatically restored the v1 compatibility firmware after the test; a
  forced production heartbeat returned HTTP 200

**Upgrade finding and correction:**
- The first signed boot found old verbose v1 records in SPIFFS and removed them
  as incompatible. Those already-removed buffered test records are not
  recoverable from SPIFFS.
- Updated signed queue migration so future verbose v1 telemetry is forwarded to
  the still-active `/api/v1/telemetry` endpoint before removal instead of being
  discarded. The isolated receiver's legacy route test returns HTTP 200.

**Remaining transport gate:** Real signed A7670G delivery still requires an
activated SIM, network attachment, a provisioned device credential and a
staging/production v2 Worker deployment.

---

## 2026-08-08 — Offline safety queue fixed + compatibility firmware flashed ✅

**Firmware hardening:**
- Split SPIFFS into a raw compact telemetry queue and a path-preserving safety
  event queue for crash and power-cut retries
- Safety events flush before routine history and retain their original endpoint
  and body; corrupt envelopes are rejected instead of sent to arbitrary paths
- Added temporary-file recovery and migration of crash/power-cut records written
  into the old mixed telemetry log
- Added `seeed_xiao_esp32s3_signed_cellular`, allowing signed A7670G builds
  without editing the normal Wi-Fi compatibility configuration
- Normal, signed Wi-Fi and signed cellular firmware environments all build

**Live device verification:**
- XIAO detected on COM7 and LilyGO helper on COM12
- Flashed the updated v1-compatible build to COM7; signed cellular mode was not
  flashed
- Post-flash IMU calibration passed at approximately 9.81 m/s²
- L76K acquired a live fix and synchronized UTC from RMC
- Wi-Fi reconnected and a forced v1 heartbeat returned HTTP 200
- A7670G UART recovered automatically using the alternate orientation on the
  current bench wiring; direct `AT` returned `OK`
- Identified modem as A7670G-LLSE revision `A7670M7_V1.11.1`; `HTTPINIT` and
  `HTTPPARA` capability queries are supported

**Cellular test blocker discovered:**
- `AT+CPIN?` returned `SIM not inserted`; signal was `99,99`, registration was
  absent and packet attachment was `0`
- Runtime `HTTPINIT`/`USERDATA` cannot be validated until an activated SIM is
  installed and attached
- No device signing key is present in `firmware/include/secrets.h`, and the local
  backend device master/session secrets are not configured

**Next safe step:** Power both boards down, insert the activated data SIM, power
the LilyGO and XIAO again, then repeat SIM/registration/HTTP capability checks.
Provision and flash signed cellular firmware only after the backend credential
and compatible v2 endpoint are ready.

---

## 2026-08-08 — Compact adaptive signed telemetry v2 implemented locally ✅

**Backend:**
- Added compact scaled-integer telemetry normalization at the Worker boundary
- Added signed `POST /api/v2/device/telemetry` and bounded
  `POST /api/v2/device/telemetry/batch` support while preserving v1
- Enforced 512-byte routine and 4 KiB batch body ceilings; batches contain at
  most 8 strictly ordered samples
- Added the single `X-BikeBoss-Auth` header while retaining compatibility with
  the original four signing headers
- Moved geofence/trip/notification side effects to `ctx.waitUntil()` so the
  device receives its acceptance response before non-critical derived work
- Made outage replay idempotent: an already-committed SPIFFS prefix is skipped
  and only newer sequence numbers are inserted

**Firmware:**
- Signed builds now send compact `v,id,q,t,a,g,m,b,c,k` packets with no raw
  six-axis IMU values in routine telemetry
- Added adaptive reporting at 10 s armed/moving, 30 s armed/stationary, 60 s
  disarmed/moving, 5 min disarmed/stationary and 2 s for confirmed incidents
- Arm changes send immediately; GPS fix changes are confirmed stable for 5 s
  before sending to suppress jitter traffic
- Added GPS RMC UTC fallback, compact command parsing, one-header Wi-Fi/A7670G
  signing, and ordered SPIFFS batch resend with up to 8 samples per request
- Added `seeed_xiao_esp32s3_signed`; the normal v1 build remains the safe default

**Measured and verified locally:**
- Typical live-fix body: **138 bytes**; empty response: **22 bytes**
- Eight-sample offline batch: **951 bytes**
- **38/38** focused auth/geofence/telemetry/IMU tests pass
- JavaScript syntax checks, Worker dry-run (**29.04 KiB gzip**), normal firmware
  build and signed firmware build pass
- Local D1 accepted sequence 41→42, rejected a replayed 42, and the automated
  overlap test proves `[41,42]` resumes at 42 when 41 is already durable

**Still gated before production:**
1. ✅ Separate offline crash/power-cut records from compact telemetry and migrate
   legacy mixed-log records safely.
2. Bench-test the A7670G `USERDATA` signing header and measure real SIM bytes,
   request latency and reconnect behavior.
3. Back up remote D1, set production secrets, apply migration 003, provision the
   device credential, flash the signed build and run staged signed telemetry.
4. Complete real 100 m exit/re-entry, boundary-jitter, overlapping-zone and
   signed ARM/DISARM acknowledgement tests before disabling v1.

Protocol details: `docs/TELEMETRY_V2_COMPACT_PROTOCOL.md`.

---

## 2026-08-08 — Production Geofence Foundation implemented locally + command execution proven ✅

**Architecture and backend:**
- Added the enterprise implementation plan in `docs/GEOFENCING_ENTERPRISE_PLAN.md`
- Added D1 migration `003_geofence_foundation.sql` for telemetry quality/idempotency,
  versioned circle zones, per-zone lifecycle state, geofence evidence, device
  credentials, command acknowledgements, and audit history
- Replaced one-sample/speed-only breach behavior with an accuracy-aware state
  machine: `UNKNOWN → INSIDE → EXIT_CANDIDATE → OUTSIDE → ENTRY_CANDIDATE → INSIDE`
- Added GPS uncertainty, entry/exit hysteresis, confirmation samples, per-zone
  lifecycle deduplication, independent overlapping-zone evaluation, re-entry
  resolution, and correct sub-meter formatting
- Corrected false van-lift evaluation: calibrated total acceleration is compared
  with 1 g instead of treating gravity itself as movement
- Added `/api/v2` Telegram `initData` validation, short-lived signed sessions,
  owner authorization, secure device claiming, command API, activity/live APIs,
  versioned circle CRUD, optimistic concurrency, and audit records
- Added signed device telemetry verification, clock-skew checks, replay sequence
  protection, and atomic D1 sequence guard
- Restricted CORS to configured BikeBoss/local origins and bounded JSON requests

**Frontend:**
- Added a lazy-loaded MapLibre map using the free OpenFreeMap Liberty style
- Added live bike marker, GPS-quality display, zone overlays and lifecycle colors
- Added tap-to-position circle creation, 50 m production minimum, radius editor,
  pause/reactivate/archive actions, and English/Khmer strings
- Replaced trusted client `telegram_id` for geofence/location/command/device-link
  flows with the v2 authenticated session
- Upgraded Vite to 8.2.1; frontend and backend dependency audits report zero
  known vulnerabilities

**Firmware and live bench proof:**
- Supplied T-A7670G R2 image confirms GPIO22 is exposed on the right-side header
  as `22 / Wire_SCL`; hardware pinout and ADR updated
- Added L76K HDOP, estimated horizontal accuracy, satellites, heading, altitude,
  GPS source and explicit speed fields
- Added persistent telemetry sequence/message IDs, UTC timestamping, per-device
  HMAC request signing support, and command acknowledgements
- Flashed the compatibility build to XIAO COM7; v1 telemetry remains enabled
- ✅ Live Wi-Fi heartbeats continue returning HTTP 200
- ✅ Connected LilyGO R2 `GPIO22 / L76K TX` → XIAO `D2 / RX2` with common
  ground and proved autonomous NMEA delivery without a PC coordinate relay:
  177,729 characters processed, latest sentence 29 ms old, `gps_fix=1` at
  `11.641223, 104.919762`
- ✅ The XIAO immediately submitted the live-fix heartbeat (481 bytes) and the
  production v1 endpoint returned HTTP 200
- ✅ A read-back from the production API confirmed the persisted D1 sample:
  `gps_fix=1`, `11.64122, 104.9198`, speed `0`, battery `12.6 V`, arm state `0`
- ℹ️ Accuracy/HDOP/satellite columns are not present in production yet because
  migration 003 and the v2 Worker rollout remain intentionally gated
- ✅ Safe remote DISARM command ID 16 was received, executed, and logged by the
  firmware as `status=applied arm=0` (previously commands were only printed)
- ✅ IMU remains calibrated at approximately 9.83 m/s² at rest

**Verification:**
- 28 geofence/auth/IMU unit tests pass
- Accuracy-aware local replay confirmed exactly one breach after two outside
  samples at 150.1 m
- D1 migration validated from the old schema, including the sequence trigger
- Authenticated local v2 API create/update/list/archive flow passed
- Worker deployment dry-run, normal firmware build, signed firmware build, and
  frontend production build pass
- Three unrelated pre-existing KHQR tests remain failing and were not modified

**Still required before production deployment:**
1. Prove the implemented ADR-009 path through the real A7670G, separate offline
   event records from routine batches, and measure real SIM bytes and latency.
2. Back up remote D1, set `APP_SESSION_SECRET` and `DEVICE_KEY_MASTER`, apply
   migration 003, provision the per-device key, enable signed telemetry, and
   deploy backend/frontend in the correct order.
3. Run real 100 m exit, stationary jitter, re-entry, overlapping-zone and signed
   ARM/DISARM ACK tests before disabling the legacy v1 API.

---

## 2026-08-08 — 0.1 m live cloud geofence bench test passed ✅

**Test:**
- Captured a real L76K fix at `11.6412413, 104.9197433`
- Temporarily disabled existing zones 1 and 8 so they could not intercept the test
- Created `Bench_0_1m_20260808_1200` with radius **0.1 m**
- Submitted a controlled second point **0.4994 m** away at **1.0 km/h**

**Verified:**
- ✅ Both telemetry heartbeats returned HTTP 200
- ✅ D1 recorded `GEOFENCE_BREACH` event ID **101** with the exact 0.4994 m distance
- ✅ Telegram notification log ID **140** has `sent=1`, no error
- ✅ Temporary zone deactivated and original zones 1/8 restored after the test

**Follow-up findings:**
- Alert text rounding for sub-meter distances was corrected after this test
- The later GPIO22→D2 bench proof established autonomous LilyGO→XIAO GPS delivery
- False `MOTION_SIGNAL_LOSS` behavior was corrected by making van-lift detection
  gravity-aware

---

## 2026-08-07 — IMU calibration + real A7670G/L76K hardware discovery ✅

**Done:**
- Added 200-sample stationary IMU boot calibration with motion/noise rejection; live bench result improved rest magnitude from **25.21 → 9.79 m/s²** (noise 0.04)
- Crash decisions are disabled if calibration is rejected, preventing unsafe false alerts
- Replaced the one-shot cold-boot modem handshake with background retry and UART-orientation detection
- Proved the A7670G AT link on real hardware (`AT` → `OK`) and identified the official UART directions: **GPIO27→XIAO D6 (RX), XIAO D7 (TX)→GPIO26**
- Replaced the LilyGO dual-UART probe with a helper that powers A7670G, wakes external GPS, and releases modem UART to the XIAO
- Discovered and verified the board's separate **L76K GPS** (live NMEA at 9600 baud); A7670G has no internal GNSS and correctly rejects `AT+CGNSSPWR` / `AT+CGPS`
- Added XIAO external-L76K NMEA parsing on **D2**, including decimal-degree conversion and live GPS telemetry fields
- Moved bench Wi-Fi credentials into gitignored `firmware/include/secrets.h`
- Both PlatformIO projects build; firmware flashed to COM7 and helper flashed to COM12

**Live verification:**
- ✅ Wi-Fi connected at `172.20.10.2`; cloud heartbeat returned HTTP 200
- ✅ IMU calibrated and stable near 1g
- ✅ L76K streams NMEA sentences
- ⚠️ L76K reports `ANTENNA OPEN`; no satellite fix until antenna is attached

**Physical steps required next:**
1. Confirm the exact LilyGO board revision and whether ESP32 **IO22 is exposed**; only then wire IO22→XIAO D2, otherwise implement a GPS relay in the LilyGO helper
2. Use recommended modem wiring: LilyGO **GPIO27 → D6**, **GPIO26 → D7**, plus common GND
3. Attach the active GPS antenna to the **L76K module's connector** and clear `ANTENNA OPEN`
4. Take the rig outdoors, run `g` until `fix=1`, then execute the real 100m geofence test

---

## 2026-08-07 — First live cloud telemetry from real hardware ✅

**Done:**
- Breadboard bring-up: XIAO ESP32-S3 (COM7) + MPU6050 (I2C D4/D5) + LilyGO T-A7670G (COM12, own USB)
- Initial UART map was later corrected by live probing; see the newer entry above
- **WiFi bench uplink implemented** (`USE_WIFI_UPLINK=1`): telemetry POSTs over ESP32 WiFi via HTTPClient → no SIM needed for cloud testing
- **First end-to-end success: HTTP 200 from `api.creative-studio.blog/api/v1/heartbeat`** posted by the real device
- Firmware hardening: WiFi auto-reconnect loop (15s), `while(!Serial)` boot-wait so USB-CDC monitor sees the boot banner, boot-time WiFi scan diagnostic, crash-log rate limiting, bench battery-check disabled (floating D0), dead PWRKEY pulse removed, serial cmd help (`w`/`l`/`t`/`m` AT-passthrough)

**Open bench issues:**
- ✅ IMU rest reading corrected by boot calibration
- ✅ Modem cold-boot recovery added; correct UART directions identified
- ⬜ GPS fix not yet validated (attach antenna + add GPIO22→D2 wire + outdoor sky view)
- ⬜ Real outdoor geofence test (arm with `a`, move >100m, expect Telegram alert)

**Next up:**
1. Complete the L76K GPS wire/antenna connection
2. Outdoor GPS fix
3. Live geofence breach test with Telegram alert

---

## 2026-08-07 — Workspace memory & geofencing phase kickoff

**Done:**
- Organized messy root folder into `documents/`, `assets/`, `data/`, `archives/`
- Established persistent context system: `CLAUDE.md`, `docs/GOAL.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md`
- Defined primary goal: **Geofencing + AI smart safe zones**

**Current state of geofencing (from code review):**
- ✅ Haversine distance engine (`lib/geo.js`)
- ✅ Breach detection with dedup (`lib/geofence.js`)
- ✅ `geofence_zones` table in D1 schema (multi-zone ready)
- ✅ Bot command `/geofence` sets anchor at last GPS fix
- ✅ API endpoint `POST /api/v1/geofence/here`
- ✅ Bilingual breach alerts (EN/KH) with Google Maps link
- ⬜ Mini App map UI with live location + zone overlay — **NEXT TASK**
- ⬜ BLE owner-presence suppression
- ⬜ AI parking-pattern learning

**Next up:**
1. Mini App: map view (Leaflet/MapLibre) showing live bike location + geofence circle
2. Mini App: "set zone here" button + zone list management
3. BLE presence check to suppress false breach alerts

---

## 2026-08-06 — KHQR payment system live

- Real EMV QR + ABA PayWay merchant account verified
- Dynamic pricing + auto-verification webhook
- Payment-listener configured with group ID

## 2026-08-06 — Mini App deployed

- Live on Cloudflare Pages: `bikeboss.creative-studio.blog`
- Bot menu button attached
- `/start` language gate (EN/KH) + rich welcome

## 2026-08-05 — Track A: foundation complete

- Monorepo scaffold (firmware / backend / frontend)
- Modular backend (routes + lib), device simulator, unit tests
- Firmware config system, Mini App skeleton
