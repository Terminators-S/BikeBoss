# BikeBoss Reliable Tracking Everywhere

> Advanced geofencing and location platform roadmap — 2026-08-09

## Product promise

The owner should always understand three separate facts without technical knowledge:

1. Where the motorcycle was last known to be.
2. Whether that location is fresh enough to trust.
3. How the tracker is communicating: Wi-Fi, cellular, or delayed offline replay.

Tracking is a shared platform capability. Geofence, trips, crash response,
anti-theft, BLE owner presence, power-cut detection and future AI all consume the
same signed telemetry stream and event timeline. No feature gets a private copy
of location data or its own definition of "online".

## User experience model

### Live mode

- Opens on the newest durable GPS sample and follows the motorcycle.
- Polling pauses while Telegram is hidden and resumes immediately on focus.
- Dragging the map pauses camera follow; **Return to live** restores it.
- The status card separates controller connectivity, location freshness, GPS
  accuracy and uplink source.
- If the tracker is offline, the map remains useful: it shows the last known
  point and when it was captured instead of hiding it.
- Geofence exit/return confirmation remains accuracy-aware and two-sample based;
  UI responsiveness must not weaken false-alarm protection.

### History mode

- Presets: 1 hour, 6 hours, 24 hours and 7 days.
- A timeline scrubber moves the motorcycle marker through the old path.
- Long ranges are sampled on the server to keep Telegram WebViews responsive.
- Dashed connectors represent a period with no delivered samples. A dashed gap
  is never presented as travelled distance.
- Security events can appear on the same route: geofence exit/return, crash,
  power cut, arm/disarm and motion-with-signal-loss.
- Later, trip cards will deep-link to an exact route window rather than opening
  an unrelated generic map.

### Connection switching

The product should switch silently when service remains healthy and explain the
switch only when it affects confidence or delivery.

```text
Known trusted Wi-Fi available
  -> use Wi-Fi after a stable-connect window
  -> Wi-Fi fails repeatedly or leaves range
  -> activate A7670G cellular
  -> cellular unavailable
  -> append signed samples to the encrypted/rotating local queue
  -> a network returns
  -> replay oldest-to-newest in bounded batches
  -> resume live telemetry
```

Rules:

- SSIDs and passwords may enter only the authenticated profile-management API.
  D1 stores a device-specific AES-GCM envelope; passwords are write-only and
  never enter telemetry, logs, audit records or command queue payloads.
- Routine telemetry reports an opaque profile UUID and cloud-owned friendly
  label, never the raw SSID, password, local IP or phone identity.
- Use hysteresis and a minimum dwell time so weak Wi-Fi does not cause flapping.
- Safety events can request immediate cellular fallback even while Wi-Fi is
  being evaluated.
- GPS collection continues independently of internet availability.
- Replayed samples retain capture time, sequence and message identity so history
  and geofence evidence stay ordered and deduplicated.
- Ordinary network switching should not spam Telegram. Notify only for a
  meaningful outage, failed replay, jamming suspicion or restored protection.

## Shared telemetry contract

Every sample can carry:

- identity: device ID, protocol version, monotonic sequence, message ID;
- time: captured time at the controller and received time at Cloudflare;
- location: L76K fix, coordinates, accuracy, HDOP, satellites, heading, speed;
- security: arm state, crash stage, motion and ignition;
- owner proof: connected/authenticated/age/confidence;
- power: measured vehicle battery when the hardware supports it;
- uplink: `wifi`, `cellular` or unknown, signal dBm and cellular generation;
- command acknowledgements.

Uplink metadata is diagnostic evidence, never the source of truth for location.
Geofence calculations continue to use `haversineDistance()` in the cloud.

## Delivery phases

### Phase 1 — History and observability

- Add privacy-safe uplink metadata to firmware, D1 and client responses.
- Add bounded `/api/v2/devices/:id/trail` windows with server-side sampling.
- Mark route gaps and calculate distance only across continuous segments.
- Add Live/History map modes, timeline scrubbing, event pins and Return to Live.
- Deploy and verify only on the isolated staging Worker/D1/Pages environment.

### Phase 2 — Dual-uplink controller (staging implementation complete)

- Replace compile-time Wi-Fi/cellular selection with a non-blocking runtime
  uplink state machine.
- Support up to eight device-encrypted trusted Wi-Fi profiles for home, school,
  cafés and phone hotspots; passwords remain write-only after HTTPS ingress.
- Add connection hysteresis, cellular fallback and periodic Wi-Fi re-evaluation.
- Move all production devices to signed v2 telemetry and ordered batch replay.
- Expand the local queue sizing/retention policy for at least a normal overnight
  outage and expose queue depth, not queue contents, to diagnostics.

Staging now includes encrypted D1 profiles, revisioned `WIFI_SYNC`, asynchronous
scan/roam/cooldown behavior, a cellular registration/PDP fallback state machine,
coarse GPS-based profile-area learning and bilingual Mini App management. The
remaining gate is a real COM7 signed firmware flash followed by phone+powerbank
Wi-Fi loss, 4G SIM and offline replay acceptance.

### Phase 3 — Route intelligence

- Trip-to-map deep links and exact start/end windows.
- Speed/accuracy coloring, stop detection and event details.
- Route simplification that preserves turns and security-event points.
- User-controlled retention and export/deletion policy.

### Phase 4 — Advanced anti-theft fusion

- Motion with GPS loss, probable van lift and possible GNSS jamming states.
- Corridor/deviation alerts during recovery mode.
- Escalation workflow combining arm state, owner proof, IMU, power and network.
- High-priority cadence with battery-aware fallback during active theft.

### Phase 5 — Smart safe zones

- Parking cluster suggestions with owner approval.
- Time-aware zones and automatic park/leave lifecycle suggestions.
- Explainable false-positive scoring using GPS quality, stationary history,
  owner authentication and network transition context.

## Integration gates

No phase is production-ready until it passes all of these:

- Existing arm/disarm and command acknowledgement behavior is unchanged.
- Geofence breach/re-entry lifecycle remains deduplicated and evidence-backed.
- Crash and power-cut events preserve their own priority and coordinates.
- Shared prototype aliases remain read-only and never send hardware commands.
- Offline samples replay in order without duplicating events or trips.
- Controller-offline, GPS-unavailable and vehicle-battery-unmeasured remain
  separate user-visible states.
- EN/KM UI and Telegram notifications cover every new state.
- Phone + powerbank field testing works without a PC after flashing.

## Phone-only acceptance journey

1. Power the XIAO/controller and LilyGO from the bike or powerbank.
2. Turn on the provisioned phone hotspot; verify the Mini App reports Wi-Fi.
3. Walk/ride a route and watch Live mode update without manual refresh.
4. Turn the hotspot off; Live becomes stale/offline but retains last location.
5. Continue moving so the controller creates an offline backlog.
6. Restore the hotspot; verify ordered replay fills History and shows the outage
   as a gap until the replay completes.
7. Repeat with an active safe zone and confirm one exit and one return lifecycle.
8. In the cellular hardware stage, repeat while Wi-Fi disappears and verify the
   transition to 4G is silent and no path points are lost.
