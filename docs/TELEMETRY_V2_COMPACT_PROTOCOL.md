# BikeBoss Compact Telemetry v2 Protocol

> Status: Implemented and verified locally; production rollout is gated
> Version: 2
> Date: 2026-08-08

## Purpose

This protocol keeps geofence and safety telemetry fast while reducing cellular
usage. The device sends compact scaled integers; the Worker validates and
normalizes them into descriptive fields before persistence and geofence logic.
The existing v1 routes remain available during the controlled migration.

## Endpoints and limits

| Request | Purpose | Limit |
|---|---|---:|
| `POST /api/v2/device/telemetry` | One live sample | 512 bytes |
| `POST /api/v2/device/telemetry/batch` | Ordered outage replay | 4096 bytes, 8 samples |

Requests use `Content-Type: application/json`. The routine engineering target
is at most 256 body bytes, leaving margin below the enforced 512-byte ceiling.

## Authentication

Each device receives a unique versioned signing key. The Worker master key is
never stored in firmware.

The preferred header is:

```text
X-BikeBoss-Auth: <unix-seconds>.<sequence>.<key-version>.<base64url-signature>
```

The signature is HMAC-SHA256 over this exact UTF-8 canonical value:

```text
POST
<request-path>
<device-id>
<unix-seconds>
<sequence>
<lowercase-sha256-hex-of-exact-body>
```

The Worker also accepts the older four separate BikeBoss signing headers during
migration. It rejects inactive credentials, timestamps outside the configured
clock-skew window, invalid signatures and sequences that do not advance the
stored device sequence.

## Routine packet

Example:

```json
{"v":2,"id":"BB-00000001","q":42,"t":1800000042,"a":0,"g":[1,116412230,1049197620,0,150,12,8,900,120],"m":[1,0,979,0],"b":12600,"c":0}
```

| Key | Meaning | Encoding |
|---|---|---|
| `v` | Protocol version | Integer `2` |
| `id` | Device ID | 1-64 safe identifier characters |
| `q` | Monotonic sequence | Non-negative safe integer |
| `t` | GPS/NTP synchronized capture time | Unix seconds |
| `a` | Arm state | `0` disarmed, `1` armed, `2` pending unlock |
| `g` | GPS sample | Compact array described below |
| `m` | Motion/IMU aggregate | Compact array described below |
| `b` | Main battery | Millivolts |
| `c` | Crash state | `0` idle through `4` confirmed |
| `k` | Optional command acknowledgements | `[[commandId,appliedFlag], ...]`, maximum 5 |

GPS with a fix:

```text
g = [1, latitudeE7, longitudeE7, speedCmS, accuracyDm, hdopX10,
     satellites, headingX10, altitudeDm]
```

GPS without a fix is exactly `g:[0]`; coordinates are not invented or repeated
as if current. The scaling preserves more precision than the field sensors need:

- Latitude/longitude: decimal degrees × 10,000,000
- Speed: centimetres per second
- Accuracy and altitude: decimetres
- HDOP and heading: value × 10

Motion aggregate:

```text
m = [imuCalibrated, moving, accelerationMagnitudeX100,
     gyroMagnitudeX1000]
```

Raw accelerometer and gyroscope axes are excluded from routine telemetry. They
belong in incident evidence or an explicitly requested diagnostic flow.

## Batch replay

The batch wrapper carries identity/version once:

```json
{"v":2,"id":"BB-00000001","q":42,"p":[{"q":41,"t":1800000041,"a":0,"g":[0],"m":[1,0,979,0],"b":12600,"c":0},{"q":42,"t":1800000042,"a":0,"g":[0],"m":[1,0,979,0],"b":12600,"c":0}]}
```

Points are oldest-to-newest, contain strictly increasing sequences, and the
last point sequence equals wrapper `q`. The Worker inserts the new suffix in one
D1 batch. If a response was lost after q41 committed, replaying `[41,42]` skips
q41 and inserts q42. If the entire request sequence is already durable, the
Worker returns replay status and firmware treats that as acknowledgement before
removing the duplicate local record.

## Response and commands

The normal response is intentionally small:

```json
{"ok":1,"q":42,"c":[]}
```

`q` confirms the accepted request sequence. Up to five commands can be returned
as `[id,"COMMAND"]` or `[id,"COMMAND",payload]`. Firmware reports execution in
the optional `k` field on a later accepted packet.

## Adaptive cadence

| Device state | Current interval |
|---|---:|
| Armed and moving | 10 seconds |
| Armed and stationary | 30 seconds |
| Disarmed and moving | 60 seconds |
| Disarmed and stationary | 5 minutes |
| Confirmed incident | 2 seconds |

Arm transitions are sent immediately with a one-second minimum event gap. GPS
fix/loss transitions must remain stable for five seconds before an immediate
packet is sent, preventing fix jitter from generating unnecessary requests.
Live incident and state-change packets are never delayed to fill a batch.

## Offline safety events

Routine telemetry and safety alerts use separate SPIFFS queues. Telemetry lines
remain raw compact samples so they can be combined into signed batches. Crash
and power-cut records are stored as path-preserving envelopes containing the
original endpoint and JSON body, then retried individually before routine
telemetry. Temporary queue rewrites are recovered after reboot, and records
created by older firmware in the mixed telemetry log are migrated instead of
being discarded. Verbose v1 telemetry encountered during a signed upgrade is
forwarded individually to the still-active v1 telemetry endpoint before the
local record is removed.

## Acceptance and side effects

The synchronous device path verifies the request, normalizes it, advances the
sequence and persists telemetry. Geofence evaluation, trip reconstruction and
notifications continue through Worker background work so the response is not
held open by derived processing.

## Local verification evidence

- Typical live-fix body: 138 bytes
- Empty command response: 22 bytes
- Eight-sample batch: 951 bytes
- Focused backend tests: 38 passing
- Worker dry-run: 133.06 KiB upload, 29.04 KiB gzip
- Normal and signed XIAO ESP32-S3 firmware builds: passing
- Local D1 sequence acceptance, replay rejection and partial-prefix resume:
  passing
- Real XIAO signed Wi-Fi test: two 133-byte live-fix packets accepted with valid
  HMAC, sequences 1/2, 3.5 m reported accuracy and compact HTTP 200 responses
- Post-test v1 compatibility rollback and production heartbeat: passing

These are HTTP body measurements, not total SIM usage. TLS setup, headers,
carrier accounting, retransmission and radio signalling must be measured on the
real SIM.

## Production rollout gates

1. ✅ Separate offline crash and power-cut records from compact telemetry and
   migrate records written by older firmware.
2. Prove `X-BikeBoss-Auth` through the A7670G `AT+HTTPPARA="USERDATA"` path on
   real cellular hardware.
3. Back up remote D1, apply migration 003, configure Worker secrets and provision
   a per-device active credential without exposing the master key.
4. Flash the signed build to an internal device and measure real SIM bytes,
   response latency, outage replay and reconnect behavior.
5. Pass real exit/re-entry, boundary-jitter, overlapping-zone and signed command
   acknowledgement tests before retiring v1.

Hardware check on 2026-08-08 identified an A7670G-LLSE running
`A7670M7_V1.11.1`. `HTTPINIT` and `HTTPPARA` capability queries are supported,
but the modem reported `SIM not inserted`, `CGATT: 0` and no registration. The
runtime `USERDATA` test therefore remains pending until an activated SIM is
installed. The XIAO currently has no provisioned signing key, so signed cellular
firmware was built but deliberately not flashed.
