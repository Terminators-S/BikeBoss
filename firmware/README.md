# BikeBoss Firmware

Edge firmware for the Seeed XIAO ESP32-S3 on-bike unit: 100 Hz IMU crash detection, BLE proximity unlock, A7670G 4G telemetry, external L76K GPS, and engine immobilizer relay.

## Requirements

- [PlatformIO](https://platformio.org/) (VS Code extension or CLI)
- Seeed XIAO ESP32-S3 board
- MPU6050 IMU (I2C), LilyGO T-A7670G + L76K GPS, 5V relay, buzzer

## Wiring

| Peripheral | MCU Pin | Notes |
|---|---|---|
| MPU6050 SDA | D4 | I2C @ 400 kHz |
| MPU6050 SCL | D5 | |
| LilyGO GPIO27 / A7670G TX | D6 (RX1) | 115200 baud |
| LilyGO GPIO26 / A7670G RX | D7 (TX1) | |
| LilyGO GPIO22 / L76K TX | D2 (RX2) | 9600-baud GPS NMEA |
| Relay signal | D1 | HIGH = cut ignition |
| Buzzer | D3 | Local alarm |
| Battery sense | D0 | ADC, 10k/4.7k divider from 12V rail |
| Modem PWRKEY/reset | LilyGO helper | `modem-test/` controls modem power and GPS wake |

## Build & flash

```bash
pio run                                  # build all normal/default environments
pio run -e seeed_xiao_esp32s3         # safe v1 compatibility build
pio run -e seeed_xiao_esp32s3_signed  # signed compact v2 build
pio run -e seeed_xiao_esp32s3_signed_cellular # signed v2 over A7670G
pio run -e seeed_xiao_esp32s3_signed_wifi_local # isolated LAN HMAC test
pio run -e seeed_xiao_esp32s3 -t upload
pio device monitor -b 115200
```

The release and network OTA upload environments are intentionally excluded
from the default build because they require release metadata or a target host.
Invoke those environments explicitly through the signed release/OTA workflow.

Flash the LilyGO power/GPS helper separately with:

```bash
cd ../modem-test
pio run -t upload --upload-port COM12
```

## Phone-only field test

The PC is needed only for the one-time firmware flash. After that, the field
rig can run from a phone and a power bank:

1. In the Mini App open Account → Connection details → Trusted Wi-Fi and save
   the phone hotspot, home, school or café network. During initial provisioning,
   the 2.4 GHz bootstrap SSID in `include/secrets.h` remains available.
2. Use a power bank with two outputs (or a powered splitter rated for the modem
   current peaks) to power both the XIAO and the LilyGO. Powering only the
   LilyGO does not power the XIAO.
3. Keep the XIAO and LilyGO common-ground wiring connected, including LilyGO
   GPIO22 to XIAO D2 for L76K NMEA.
4. Place the GPS antenna outdoors with open sky, power both boards, and leave
   the rig stationary during IMU calibration.
5. Open the staging Telegram Mini App on the same phone. Firmware sends its
   first heartbeat automatically after boot; no serial `w` command is needed.

At boot, keep the installed sensor still while the firmware learns both its
1g scale and the motorcycle's normal upright gravity direction. Calibration
does not subtract X/Y gravity caused by mounting angle, so ordinary leaning
does not become a false impact. Crash confirmation requires impact, rotation,
a settled down orientation and continuous stillness; it alerts once and
re-arms only after sustained upright recovery.

GPS speed is filtered at the receiver boundary: movement begins only after two
consecutive fixes at or above 3 km/h, while values at or below 1 km/h return to
zero. This removes isolated L76K speed noise while the motorcycle is parked.

Every L76K RMC/GGA sentence must pass its NMEA XOR checksum and strict
degree/minute/hemisphere validation before it can update the live fix. The
cloud applies a second, capture-time-aware impossible-jump guard so a damaged
serial frame cannot move the map marker or trigger a geofence.

Allow roughly 30–90 seconds for the full controller boot, network join and
initial status. Once running, the staging phone-test build sends telemetry every
5 seconds. A cold GPS start can take 2–10 minutes. The controller can be online
before GPS changes to `Fixed`; these are separate states.

## Configure

Edit `include/config.h` before flashing:

| Setting | What to change |
|---|---|
| `DEVICE_ID` | Unique per unit, matches backend (`BB-00000001`) |
| `CLOUD_HOST` | Your deployed Worker hostname |
| `MODEM_APN` | SIM APN (Cellcard default included) |
| `INSTALL_MODE` | `0` universal ignition cut · `1` scooter solenoid pulse |
| Thresholds | Crash/BLE/battery tuning |

Copy `include/secrets.example.h` to `include/secrets.h` for the local bootstrap
Wi-Fi credential. `secrets.h` is gitignored. Signed firmware can then receive up
to eight device-encrypted profiles from the Mini App. It scans asynchronously,
uses priority plus RSSI, cools down failures, avoids rapid roaming, and falls
back to A7670G 4G before buffering offline.

### Signed telemetry provisioning

The working v1 heartbeat remains the default until the production credential is
ready. To enable `/api/v2/device/telemetry` safely:

1. Set the Worker secrets `APP_SESSION_SECRET` and `DEVICE_KEY_MASTER`.
2. Set `BIKEBOSS_DEVICE_KEY_MASTER` locally to that same device-key master and
   run `npm run device:key -- BB-00000001` from `backend/`.
3. Put only the returned per-device hex key in `secrets.h` as
   `DEVICE_SIGNING_KEY_HEX`. Never put the Worker master in firmware.
4. Mark that device/version `active` in D1 `device_credentials`.
5. Set `USE_SIGNED_TELEMETRY_V2` to `1`, build, flash, and verify signed packets
   before disabling the legacy v1 route.

Signed firmware persists a monotonic packet sequence, synchronizes UTC from NTP
or GPS RMC, reports GPS quality, applies ARM/DISARM commands, and acknowledges
their execution on the next packet. Routine payloads use compact scaled
integers and a single `X-BikeBoss-Auth` header. Typical measured size is 138
bytes with a live fix; an empty command response is 22 bytes.

Trusted Wi-Fi downlink is allowed only on this signed path. D1 stores an
AES-GCM envelope bound to device, profile, version and key version; the command
queue stores only a revision. Production units must also enable ESP32 flash
encryption and secure boot before storing provisioned passwords in NVS.

The adaptive signed-v2 cadence is:

| State | Interval |
|---|---:|
| Armed and moving | 10 s |
| Armed and stationary | 30 s |
| Disarmed and moving | 60 s |
| Disarmed and stationary | 5 min |
| Confirmed incident | 2 s |

Arm changes send immediately. GPS fix/loss changes must remain stable for 5
seconds before an immediate packet is sent. After an outage, SPIFFS history is
resent oldest-first in signed batches of up to 8 samples and 4 KiB. Crash and
power-cut requests use a separate path-preserving safety-event queue, so they
cannot be mistaken for compact telemetry; old mixed logs are migrated during
flush. See
`../docs/TELEMETRY_V2_COMPACT_PROTOCOL.md` for the complete contract.

Do not enable signed v2 in production until the A7670G `USERDATA` header has
been verified on real cellular hardware, migration 003 and credentials are
installed, and the signed firmware passes the staged field checklist.

`seeed_xiao_esp32s3_signed_wifi_local` is a development-only environment. Set
`BIKEBOSS_LOCAL_TEST_HOST` to the LAN receiver's `IP:port`; it uses HTTP and a
public fixture key that the deployed Worker never accepts. The local receiver is
`backend/scripts/wifi-telemetry-test-server.mjs`. Never point this environment
at a public or production host.

For the cellular bench environment, power the boards down before inserting an
activated SIM, then confirm `AT+CPIN?`, registration and attachment before
flashing `seeed_xiao_esp32s3_signed_cellular`. The build also requires a valid
64-hex-character `DEVICE_SIGNING_KEY_HEX` provisioned for an active backend
credential. Never copy the Worker master secret into the device.

## Serial debug commands

Open the monitor and type:

| Key | Action |
|---|---|
| `a` | Arm (relay cut) |
| `d` | Disarm (relay release) |
| `g` | Print current GPS fix |
| `s` | Full status dump |
| `f` | Flush SPIFFS offline log to cloud |

## Bench bring-up order

1. **IMU only** — comment out modem init; verify 100 Hz sampling with `s`
2. **Crash engine** — shake the unit: Stage 1 → Stage 2 → lay flat 3 s → CONFIRMED
3. **Modem** — check A7670G `AT` response; no SIM is required for this check
4. **GPS** — connect GPIO22→D2, attach the L76K antenna, then get a fix outdoors
5. **Telemetry** — first verify `/api/v1/heartbeat`, then provision and verify signed `/api/v2/device/telemetry`
6. **BLE** — phone app writes RSSI; verify EMA unlock at ≥ −55 dBm
7. **Relay/buzzer/ADC** — arm/disarm clicks, power-cut alert on <11 V

## Known TODOs

- Non-blocking AT state machine (current HTTP POST blocks up to ~10 s)
- TinyML crash-vs-pothole classifier (Edge Impulse) replacing threshold stages
- Deep-sleep power budget for parked mode

## Global internet firmware updates

The signed staging firmware supports device-initiated OTA through the public
BikeBoss HTTPS API and a private Cloudflare R2 bucket. The operator does not
need to share the device's LAN: the update offer arrives in signed telemetry,
and the device downloads the authorized image over outbound HTTPS.

This path currently requires trusted Wi-Fi internet. It does not require a SIM,
and it does not yet download firmware through the A7670G cellular fallback.
Installation waits for Wi-Fi, a disarmed controller and a stationary vehicle.
The image is checked for board, increasing build number, size, SHA-256 digest,
ECDSA P-256 release signature and TLS chain before activation in the inactive
OTA slot. The new build waits 15 seconds after boot before acknowledging health.

Publish a staging canary from `backend/`:

```powershell
npm run firmware:release -- <version> <new-build-number> BB-00000001 staging
```

Every published build number is immutable and must never be reused, even after
a failure or revocation. The release key remains outside the repository. See
`../docs/GLOBAL_OTA_RUNBOOK.md` for provisioning, monitoring, cohort expansion,
revocation, SIM requirements and production gates.

## Authenticated Wi-Fi firmware updates

The signed Wi-Fi build starts ArduinoOTA only after a trusted network connects.
Its password is derived from the device signing key and is not stored in source
control. The first OTA-capable build must be installed over USB:

```powershell
pio run -e seeed_xiao_esp32s3_staging_signed -t upload --upload-port COM7
```

Later updates can use a private 2.4 GHz LAN that permits device-to-device
traffic:

```powershell
$env:BIKEBOSS_OTA_HOST='bikeboss-bb-00000001.local'
$env:BIKEBOSS_OTA_PASSWORD=(node scripts/derive-ota-password.mjs)
pio run -e seeed_xiao_esp32s3_staging_signed_ota -t upload
Remove-Item Env:BIKEBOSS_OTA_HOST,Env:BIKEBOSS_OTA_PASSWORD
```

Campus and guest Wi-Fi commonly isolate clients even when both have internet;
use a phone hotspot or private router when the OTA host cannot be reached.
