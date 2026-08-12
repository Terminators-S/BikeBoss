# BikeBoss Enterprise Geofencing Plan

> Status: Production foundation and compact signed telemetry implemented locally; deployment and field validation pending
> Date: 2026-08-08
> Scope: Firmware-to-cloud location delivery, geofence platform, real-time map,
> smart parking, familiar-place learning, and guardian journeys

## 1. Executive decision

The 0.1 m bench test is BikeBoss's first successful controlled end-to-end
geofence feature test: a real L76K anchor led to a Cloudflare event and a sent
Telegram alert. The later GPIO22→D2 bench proof established autonomous L76K
delivery to the XIAO and an HTTP 200 cloud heartbeat without a PC coordinate
relay. This still does **not** make the current prototype production-ready:
production secrets, database migration and signed-device rollout remain gated,
and a 0.1 m radius is far below real GNSS accuracy. Compact v2 telemetry now
meets its local body budgets and adaptive cadence goals, but the signed A7670G
header path and real SIM usage still require hardware proof.

Production geofencing will be a server-authoritative, accuracy-aware platform:

- The device sends authenticated, timestamped location samples with quality
  data and a monotonic sequence number.
- A per-device Cloudflare Durable Object owns live state, evaluates assigned
  zones, and fans out real-time updates.
- D1 owns users, permissions, zone configuration, current projections, events,
  and audit records.
- Queues make persistence, alert delivery, and analytics retryable and
  idempotent.
- R2 stores long-term telemetry outside the operational D1 database.
- The Telegram Mini App uses MapLibre for the live map and zone editor.
- Smart zones begin with deterministic stop detection and explainable
  clustering. ML produces suggestions; it does not silently change a safety
  boundary.

## 2. Product principles

1. **No false precision.** The UI and engine must display and use GPS accuracy.
   A 100 m default is realistic for the first field release; sub-meter zones
   remain test-only.
2. **Safety decisions are explainable.** Every transition records the sample,
   accuracy, rule version, zone version, and reason.
3. **Real-time does not mean unreliable.** Live UI delivery may be ephemeral,
   but confirmed events and notifications are persisted and retried.
4. **Permissions precede sharing.** Owners, guardians, riders, and viewers have
   explicit roles, consent, expiry, and an audit trail.
5. **Automation starts temporary.** A newly detected parking place creates an
   expiring parking guard. A learned permanent place requires owner approval.
6. **Bilingual by design.** All user-facing states, errors, alerts, and help are
   available in English and Khmer.

## 3. Current state and target gap

| Area | Current prototype | Production target |
|---|---|---|
| GPS delivery | Autonomous GPIO22→D2 L76K fix and cloud heartbeat proven; v1 compatibility transport remains active | Signed v2 delivery with field-validated quality fields, sequence numbers and offline buffering |
| Device identity | Device ID accepted from request body | Per-device credentials, signed payloads, replay prevention, key rotation |
| User identity | Client supplies `telegram_id`; several reads are public | Server validates Telegram `initData`, issues a short-lived session, enforces resource authorization |
| Zone shapes | Circle center and radius | Circle, polygon, route corridor, checkpoint, safe/restricted policies |
| Zone assignment | Active zones queried directly by device | Versioned zones assigned to devices/riders with schedules and priority |
| Evaluation | One sample, minimum speed, ten-minute dedup | Accuracy-aware state machine, hysteresis, dwell, consecutive samples, per-zone event lifecycle |
| Overlapping zones | First matching breach returns early | Every assignment evaluated independently; aggregation policy is deterministic |
| Live UI | 15-second polling and Google Maps link | WebSocket live map with polling fallback, accuracy circle, heading, trail, and staleness |
| Smart parking | Not implemented | Stop detection, temporary parking guard, existing-zone auto-assignment |
| Familiar places | Not implemented | Explainable visit clustering, confidence, suggestions, feedback, model versioning |
| Guardian journeys | Not implemented | Consent-based household roles, school schedules, arrival/departure, route deviation, no-signal and speeding alerts |
| Operations | Basic Worker logs and a few unit tests | Staging/prod isolation, migrations, SLOs, structured telemetry, replay/load/chaos/field tests |

## 4. Product capabilities

### 4.1 Manual and scheduled zones

Support four policy templates over three geometry types:

| Policy | Meaning | Typical geometry | Primary transition |
|---|---|---|---|
| Safe zone | Bike is expected to remain inside | Circle or polygon | Confirmed exit |
| Restricted zone | Bike must not enter | Circle or polygon | Confirmed entry |
| Checkpoint | Arrival/departure and dwell tracking | Circle or polygon | Enter, dwell, exit |
| Route corridor | Bike is expected to remain near a route | Buffered polyline | Confirmed deviation |

Every zone has a name, geometry, behavior, schedule and IANA timezone,
recipients, severity, confirmation policy, device/rider assignments, status,
version, and audit history. Draft, active, paused, and archived are distinct
states. Editing an active zone creates a new version instead of altering the
meaning of an event already in progress.

The first production UI ships circles. Polygon editing follows once the state
machine and security foundation pass field testing. Corridors are introduced
with guardian journeys.

### 4.2 Live tracking

The map displays:

- Current bike marker, direction and speed
- GPS accuracy circle and fix-quality status
- Last-seen age and online/stale/offline state
- Recent breadcrumb trail with configurable retention
- Active zones and current inside/outside/candidate state
- Active alert banner with acknowledge and open-in-map actions
- Clear distinction between device sample time and server receive time

Adaptive sampling balances alert latency, data usage, and battery:

- Armed and moving: target 5-15 seconds
- Armed and stationary: target 15-30 seconds
- Disarmed and moving: target 30-60 seconds
- Disarmed and stationary: target 3-5 minutes
- Confirmed incident: temporary high-frequency mode

Exact intervals remain remotely configurable and must be validated on the
motorcycle battery and cellular plan.

Wire-efficiency requirements for the signed v2 rollout:

- Routine telemetry body target: **≤256 bytes**; hard ceiling: **512 bytes**
- Command response target: **≤96 bytes** when no command is pending
- Versioned compact envelope with scaled integers; normalize to descriptive
  fields at the Worker boundary
- No raw six-axis IMU stream in routine heartbeats; send aggregates and reserve
  detailed samples for crash evidence or requested diagnostics
- Omit empty/unchanged optional values without removing GPS validity, accuracy,
  sample time, sequence, safety state or required acknowledgements
- Immediately send incidents, fix/arm transitions and command acknowledgements
- Batch offline history so reconnect does not create one TLS request per sample

These are body budgets, not total SIM usage. HTTPS/TLS and radio signalling can
cost more than the JSON itself, so actual bytes per state and per day must be
measured on the production SIM before the first cohort rollout.

**Local implementation evidence (2026-08-08):** The signed v2 firmware sends
`v,id,q,t,a,g,m,b,c,k`, uses one combined authentication header, and reports at
10/30/60/300-second state-dependent intervals with a 2-second incident mode.
The Worker enforces 512-byte routine and 4 KiB batch ceilings, accepts at most 8
ordered offline samples, skips an already-committed replay prefix, and returns a
minimal `{ok,q,c}` response. Measured bodies are 138 bytes for a typical live
fix, 22 bytes for an empty response and 951 bytes for eight offline samples.
Routine telemetry and crash/power-cut retries now use separate SPIFFS queues,
including migration of records written by older mixed-log firmware. The updated
v1 compatibility build was flashed and returned HTTP 200 with a live L76K fix.
The A7670G exposes the expected HTTP command family, but the current board has
no SIM inserted, so signed cellular delivery remains a physical test gate.
Signed Wi-Fi delivery is now proven on the real XIAO: two 133-byte packets with
live L76K coordinates passed compact decoding and HMAC verification and received
minimal HTTP 200 responses. The device was then restored to v1 and its production
heartbeat passed, leaving the current service path unchanged.
The complete contract and rollout gates are in
`docs/TELEMETRY_V2_COMPACT_PROTOCOL.md`.

### 4.3 Smart parking guard

When the bike stops, the system should first select an existing familiar/manual
zone if the location confidently belongs to one. Otherwise it creates an
expiring `AUTO_PARKING` circle.

Initial stop detection is deterministic:

1. Valid fixes with acceptable accuracy
2. Speed below the stop threshold
3. IMU stable for a configurable dwell period
4. Ignition off when an ignition signal becomes available
5. Median center from the stable sample window, not the last point
6. Radius derived from observed spread and accuracy, clamped to safe limits

The auto-zone is visible, editable, and expires at the next authorized journey
or after a configured duration. The user can save it as a permanent place.
The system never creates a permanent learned zone without an explicit action.

### 4.4 Familiar-place learning

The first learning model is deliberately explainable:

- Extract parking sessions from trips and stable stops.
- Cluster centers with haversine DBSCAN or an equivalent geohash-neighbor
  algorithm.
- Compute visit count, distinct days, median dwell, time-of-day/day-of-week
  patterns, position spread, and GPS-quality distribution.
- Produce `home`, `work`, `school`, or custom-place suggestions only after
  minimum evidence and confidence thresholds.
- Let the user accept, rename, edit, or dismiss each suggestion.
- Record feedback and the algorithm/model version for later evaluation.

Route learning uses simplified historical polylines and spatial similarity to
suggest a normal route corridor. A statistical anomaly score may prioritize an
alert, but deterministic boundary and schedule rules remain authoritative.
LLMs are not required for location clustering or safety decisions.

### 4.5 Guardian and school journeys

Guardian mode is a consent-based product, not simply a shared password. A
household can contain owners, guardians, riders, and time-limited viewers.

A school journey policy contains:

- Rider, bike, school zone, home zone, local timezone, and school-day calendar
- Expected departure, arrival, pickup, and return windows
- Optional approved route corridor and maximum speed rule
- Notification recipients and escalation timing
- Location-sharing window and retention policy

Journey state is explicit:

`NOT_STARTED -> EN_ROUTE -> ARRIVED -> DEPARTED -> RETURNING -> COMPLETED`

Side states include `LATE`, `OFF_ROUTE`, `SPEEDING`, `NO_SIGNAL`, `SOS`, and
`CANCELLED`. Guardians see whether the child departed, is safely en route,
arrived, or lost connectivity; they do not receive a misleading "safe" result
when telemetry is stale.

Before a public launch involving minors, BikeBoss needs a Cambodia-focused
privacy/legal review, clear consent and revocation, limited retention, and an
abuse-response process.

### 4.6 Alerts and response

Alerts are lifecycle records, not one-off messages:

- Possible movement (optional early warning)
- Confirmed zone exit/entry/deviation
- Escalated because unacknowledged
- Acknowledged by a named user
- Resolved by re-entry or an authorized journey

Telegram is the first delivery channel. The model must support additional
channels without changing geofence evaluation. Delivery attempts have stable
idempotency keys, retry state, provider response, error, and timestamps.

## 5. Target Cloudflare architecture

```text
L76K GNSS -> LilyGO/XIAO firmware -> signed HTTPS telemetry
                                      |
                                      v
                            Cloudflare Worker API
                       auth, schema, rate/idempotency
                                      |
                     Durable Object: one per device
                 latest state, zone engine, WebSocket fan-out
                         |                         |
                         v                         v
                Queue(s): durable work       Mini App live map
                 |       |        |
                 v       v        v
                D1    Telegram    R2 history
          config/events  alerts   + analytics data
                 |
                 v
        Scheduled jobs / Workflows
       stops, familiar places, journeys
```

### Component responsibilities

- **Worker API:** validates device signatures or user sessions, parses a
  versioned schema, applies rate limits, authorizes the resource, and routes by
  deterministic device ID.
- **Per-device Durable Object:** owns the current location, last sequence,
  active zone-version cache, geofence state machines, live subscribers, and
  short disconnect/reconnect history. Persist state before emitting events.
- **D1:** source of truth for identities, roles, zones, assignments, event
  projections, alert history, journeys, suggestions, and audit logs.
- **Queues:** decouple retryable telemetry persistence, notifications, derived
  trips/stops, and archival. Consumers use event IDs for idempotency.
- **R2:** partitioned raw telemetry and completed trip traces for long-term
  history and replay. D1 retains only operational hot data.
- **Workflows or scheduled jobs:** bounded per-device/per-tenant jobs for stop
  finalization, learning, journey timeouts, and notification escalation. No
  global Durable Object coordinates the fleet.

Staging and production require different Workers, D1 databases, Durable Object
namespaces, queues, R2 buckets, Telegram bots, domains, secrets, and alerting.
Schema changes use numbered migrations with a tested forward path and rollback
or compatibility strategy.

## 6. Location contract and geofence engine

### 6.1 Required location fields

Each device packet uses canonical units and includes:

- `message_id`, `device_id`, `sequence`, `captured_at`, firmware version
- latitude/longitude, speed in m/s, heading in degrees, altitude in metres
- horizontal accuracy in metres, HDOP, satellite count, fix type and GPS source
- IMU motion state, arm state, ignition state when available, battery voltage
- owner-presence observation with age and confidence, never just a bare boolean

The server rejects or quarantines invalid coordinates, `0,0`, stale samples,
impossible future timestamps, duplicate message IDs, and sequence replays.
Out-of-order samples may be archived but do not rewind current safety state.

### 6.2 State machine

Allowed/safe-zone state:

`UNKNOWN -> INSIDE -> EXIT_CANDIDATE -> OUTSIDE -> ENTRY_CANDIDATE -> INSIDE`

No-fix and stale telemetry move the state to an observable degraded condition;
they do not prove the bike is inside. Restricted-zone behavior uses the same
engine with entry and exit meanings reversed.

For a circle with center distance `d`, radius `r`, and horizontal accuracy
`a`:

- Confidently outside when `d - a > r + exit_buffer`
- Confidently inside when `d + a < r - entry_buffer`
- Otherwise uncertain; preserve state and gather more samples

Confirmation combines consecutive valid samples, minimum duration, hysteresis,
and optional motion/ignition context. Speed must not be the sole breach gate: a
lifted or towed motorcycle may initially report zero speed. Owner presence can
authorize or reduce the severity of a transition, but its freshness and
confidence must be recorded.

Polygon evaluation uses a bounding-box prefilter, point-in-polygon, and signed
distance to the boundary. Corridor evaluation uses minimum distance to the
polyline. All authoritative geospatial calculations remain centralized in and
tested through `backend/src/lib/geo.js`.

Every assignment is evaluated independently. Event deduplication keys include
device, zone assignment, zone version, transition, and lifecycle ID; it is not
device-wide.

## 7. Operational data model

The new model should be introduced by migration while preserving the existing
circle zones until cutover.

| Table/domain | Purpose |
|---|---|
| `households`, `memberships` | Tenant boundary and owner/guardian/rider/viewer roles |
| `device_credentials` | Credential ID, encrypted/derived verification material, rotation and revocation state |
| `device_location_latest` | Query-efficient latest accepted sample and staleness state |
| `zones`, `zone_versions` | Stable identity plus immutable geometry/policy versions |
| `zone_assignments` | Version, device/rider, schedule, priority, confirmation and recipient policy |
| `device_zone_state` | D1 projection of the live Durable Object state |
| `geofence_events` | Candidate/confirmed/acknowledged/resolved lifecycle and evidence |
| `alert_rules`, `alert_deliveries` | Recipients, escalation and provider delivery attempts |
| `parking_sessions`, `auto_zones` | Stable stops and expiring parking guards |
| `familiar_places`, `place_suggestions` | Clusters, confidence, version and user feedback |
| `journey_policies`, `journey_runs`, `journey_events` | Guardian schedules and state transitions |
| `audit_log` | Actor, action, resource, before/after metadata and request ID |

Zone geometry is stored as validated GeoJSON with longitude before latitude.
Frequently queried center, radius, bounding box, status, owner and version are
also stored as typed/indexed columns where appropriate. Optimistic concurrency
uses a version or ETag so two editors cannot silently overwrite each other.

## 8. Versioned API and event contracts

The existing `/api/v1` endpoints remain available during migration. New
production contracts use `/api/v2`.

### User API

- `POST /api/v2/auth/telegram` - validate `initData`, return short-lived session
- `GET /api/v2/devices/:deviceId/live`
- `GET /api/v2/devices/:deviceId/stream` - authenticated WebSocket upgrade
- `GET|POST /api/v2/devices/:deviceId/zones`
- `GET|PATCH|DELETE /api/v2/zones/:zoneId`
- `POST /api/v2/zones/:zoneId/assignments`
- `POST /api/v2/zones/preview` - validate and simulate geometry/policy
- `GET /api/v2/devices/:deviceId/geofence-events`
- `POST /api/v2/geofence-events/:eventId/acknowledge`
- `GET|POST /api/v2/households/:id/members`
- `GET|POST /api/v2/journey-policies`
- `GET /api/v2/journeys/:id`
- `GET /api/v2/place-suggestions`
- `POST /api/v2/place-suggestions/:id/accept|dismiss`

The browser never proves identity by sending a trusted `telegram_id`. It sends
the server-issued session and the backend derives the actor and permissions.

### Device API

- `POST /api/v2/device/telemetry`
- `POST /api/v2/device/telemetry/batch`
- `GET /api/v2/device/commands` or commands returned after accepted telemetry
- `POST /api/v2/device/commands/:id/ack`

Device requests use TLS plus a per-device signature over method, path,
timestamp, nonce/sequence and body hash. Provisioning, rotation, revocation,
clock skew, replay windows, and offline batch resend are part of the protocol.

### Domain events

Stable events include:

- `location.updated`, `device.online`, `device.offline`, `gps.degraded`
- `geofence.exit_candidate`, `geofence.exited`, `geofence.entered`,
  `geofence.resolved`
- `parking.detected`, `auto_zone.created`, `auto_zone.expired`
- `familiar_place.suggested`, `familiar_place.accepted`
- `journey.started`, `journey.arrived`, `journey.late`,
  `journey.route_deviation`, `journey.no_signal`, `journey.completed`

Each event carries a globally unique ID, schema version, occurred/received time,
tenant, device, causation/correlation IDs, rule/model version, and the minimum
evidence required to explain the decision.

## 9. Frontend information architecture

The Mini App evolves from three tabs to:

1. **Home:** security, bike health, current zone and active journey/alert
2. **Map:** full live map, accuracy, trail, zones and bottom-sheet details
3. **Activity:** trips, geofence lifecycle, alerts and acknowledgements
4. **Guardian:** children/riders, school journey status and temporary sharing
5. **Account:** devices, household roles, privacy, retention and notification settings

Zone creation is a focused map flow:

1. Choose current bike, searched place, or dropped pin
2. Draw a circle; later choose polygon or route
3. Name it and choose safe/restricted/checkpoint behavior
4. Set schedule, recipients and confirmation sensitivity
5. Preview coverage and GPS-accuracy warning
6. Save, then show server-confirmed version and activation state

MapLibre GL JS is the map renderer. The initial provider is the free OpenFreeMap
Liberty style, selected by the owner on 2026-08-08 and kept configurable through
`VITE_MAP_STYLE_URL`. BikeBoss does not call the public OpenStreetMap tile
endpoint directly. Before a large commercial rollout, review OpenFreeMap's
reliability and Khmer/English Cambodia coverage, or operate a Cambodia PMTiles
dataset on R2. Attribution remains mandatory.

UX quality gates include Telegram safe-area/viewport behavior, 44 px touch
targets, keyboard/screen-reader access, color-independent states, low-bandwidth
fallback, dark/light Telegram themes, and complete English/Khmer copy.

## 10. Security, privacy, and abuse prevention

Before exposing location or control APIs:

- Validate Telegram `initData` server-side and enforce freshness.
- Replace wildcard CORS with the production Mini App and controlled development
  origins.
- Authorize every device, zone, event, journey and command by household role.
- Sign device telemetry and command acknowledgements; rate-limit by credential,
  device, actor and IP.
- Protect command creation with idempotency, recent authentication for critical
  actions, immutable audit records, and device execution acknowledgements.
- Keep coordinates, secrets and Telegram identity out of ordinary logs.
- Verify Telegram webhook secrets and all payment webhook signatures.
- Provide role invitation, acceptance, expiration and immediate revocation.
- Provide location-sharing schedules, data export and account/location deletion.
- Detect impossible jumps, stale/replayed time, sustained accuracy loss,
  jamming/spoofing indicators, power cuts and SIM/device tampering as distinct
  signals rather than silently treating them as a geofence breach.

Proposed retention defaults, subject to legal and product review:

- Latest state: while the device is active
- D1 raw/hot telemetry: 30 days
- Completed trip history: 12 months
- Guardian detailed breadcrumb trail: 90 days or less
- Security/audit events: 12-24 months
- User-configurable shorter retention and deletion where legally permitted

## 11. Reliability, observability, and quality gates

### Initial SLOs

| Signal | Initial target |
|---|---|
| Authenticated telemetry API availability | 99.9% monthly |
| Valid sample accepted and evaluated | p95 under 500 ms |
| Confirmed event durably queued after evaluation | p95 under 1 second |
| Live map update after server ingest | p95 under 3 seconds |
| Telegram first delivery attempt after confirmed event | p95 under 5 seconds |
| Armed end-to-end alert latency | Under 30 seconds for 95% of valid-fix cases, including sampling |
| Duplicate confirmed notifications | Below 0.1% |
| Field false confirmed breaches | Launch target below 1 per 1,000 armed-hours |

Dashboards and alerts cover request rate/errors/latency, auth failures, invalid
samples, sequence gaps, GPS accuracy/no-fix rate, per-device evaluation lag,
state transitions, Queue backlog/retries/dead letters, Telegram success rate,
WebSocket connections, D1 latency, Durable Object restarts and stale devices.
Every path propagates a correlation ID.

### Test strategy

- Unit tests for circle, polygon and corridor boundaries, including equality,
  uncertainty, antimeridian, polar, invalid-coordinate and rounding cases
- Property tests against a trusted geospatial reference implementation
- State-machine tests for jitter, hysteresis, overlapping zones, schedule
  changes, duplicate/out-of-order samples and restart recovery
- Recorded GPS replays for stationary drift, urban canyon, tunnel/no-fix,
  normal exit/re-entry, towing, theft and authorized rides
- Firmware/API schema contract tests and signed-request replay tests
- D1 migration and compatibility tests against a production-like copy
- Queue retry/idempotency and Telegram failure tests
- Durable Object restart, WebSocket reconnect and polling-fallback tests
- Load tests at 10x the forecast first-year fleet traffic and incident bursts
- Field pilots across open sky, dense Phnom Penh streets, covered parking and
  multiple motorcycle electrical systems

Production rollout uses internal devices, then 10, 50, and 500-device cohorts
with kill switches for auto-zones, learning, corridor alerts and notification
escalation.

## 12. Delivery roadmap

Effort ranges are sequencing estimates for a focused small team and include
field validation; they are not release-date promises.

| Phase | Scope | Indicative effort | Exit criteria |
|---|---|---:|---|
| 0. Production blockers | Autonomous GPS bridge, compact/adaptive location-quality contract, signed device API, Telegram session auth, command execution/ACK, van-lift correction, staging/prod split | 1-2 weeks | Local implementation is complete; exit requires real hardware to independently send signed live fixes within payload budgets, no `0,0`, ARM execution/ACK, and rejected unauthorized location/control requests |
| 1. Geofence Core v2 | Versioned schema, circle CRUD/assignment, accuracy-aware state machine, per-zone lifecycle, MapLibre live map/editor, bilingual UX | 2-3 weeks | User can create/edit/pause/delete a circle; replay tests and real 100 m field exit/re-entry pass without duplicate alerts |
| 2. Real-time and delivery | Per-device Durable Objects, WebSocket/fallback, Queue-backed persistence/notifications, acknowledgements, dashboards/SLOs | 2 weeks | Restart/retry/load tests pass; live and delivery latency meet initial SLOs |
| 3. Smart parking | Stop sessions, existing-zone matching, temporary auto-zones, expiry/approval, remote configuration | 2 weeks | Pilot detects at least 90% of valid parking sessions and creates no zone during recorded riding cases |
| 4. Familiar places | Clustering, confidence, suggestions, feedback, scheduled learning and route prototypes | 3-4 weeks plus data collection | Suggestions meet agreed precision on labelled pilot data; user always controls activation |
| 5. Guardian journeys | Household/consent roles, school/home checkpoints, schedule engine, route corridor, late/off-route/speed/no-signal states | 3-4 weeks | End-to-end school-day pilot passes; permissions, revocation, stale-data UX and privacy review pass |
| 6. Scale and assurance | Fleet controls, retention/export/delete, disaster recovery, cost/load tuning, larger field rollout | Ongoing | Capacity, support runbooks, recovery drill and cohort metrics pass launch review |

Polygon/restricted zones can enter after Phase 1 or alongside Phase 2. Route
corridors should wait for the same engine and guardian product context instead
of being implemented as a separate ungoverned alert.

## 13. Recommended first implementation milestone

Build **Production Geofence Foundation**, not ML, as the next milestone:

1. ✅ Verify the LilyGO R2 `GPIO22 / L76K TX` → XIAO `D2 / RX2` interconnect
   with common ground. Bench proof received a live fix without a PC relay.
2. ✅ Add accuracy, HDOP, satellites, captured time, sequence and message ID to
   the firmware/cloud contract; normalize speed units. Compact v2 is verified
   locally and v1 remains available.
3. ✅ Implement per-device request authentication and Telegram `initData`
   session exchange; close public location/control endpoints and wildcard CORS
   in the local production candidate.
4. 🟡 Make ARM/DISARM execute on firmware and report command acknowledgement.
   Compatibility command execution is bench-proven; signed ACK needs field proof.
5. ✅ Fix false `MOTION_SIGNAL_LOSS` logic so gravity and missing GPS do not
   create theft alerts.
6. ✅ Introduce the versioned circle-zone schema and accuracy-aware lifecycle
   state machine while preserving the current v1 route during migration.
7. 🟡 Deliver a MapLibre live map and circle editor. Implemented locally; staging
   rollout and device-linked acceptance remain pending.
8. 🟡 Validate with GPS replay plus a real outdoor 100 m exit and re-entry test.
   Automated replay passes; outdoor exit/re-entry remains pending.

### Milestone definition of done

- Autonomous hardware fix reaches staging and production without a PC relay.
- Owner can securely create, edit, pause and delete a named circle.
- Map shows live/stale/offline state, accuracy and the active boundary.
- A real exit becomes candidate, confirmed, notified, acknowledged and resolved.
- Replayed jitter near the boundary does not alert.
- Overlapping circles produce independent, non-duplicated lifecycle events.
- English and Khmer flows pass review.
- All migrations, unit/integration/replay tests, dashboards, rollback notes and
  field evidence are recorded before enabling the feature for customers.

Only after this milestone is reliable should BikeBoss enable automatic parking
guards, collect labelled stop data, and begin familiar-place suggestions.
