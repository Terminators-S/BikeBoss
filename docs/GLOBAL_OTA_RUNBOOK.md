# BikeBoss Global OTA Runbook

> Status: staging is live and verified on `BB-00000001`. Production is not
> enabled. This runbook covers internet Wi-Fi OTA; cellular OTA is not yet
> implemented.

## What "global" means

The operator and motorcycle do not need to be on the same LAN. The controller
makes outbound HTTPS requests to the BikeBoss Cloudflare Worker, and the Worker
streams an authorized firmware object from a private R2 bucket. No inbound
port, public device IP, VPN, or local discovery is involved.

The motorcycle still needs an internet connection. The current global updater
uses trusted Wi-Fi only. A SIM is not required for OTA, and the current firmware
does not download firmware over the A7670G cellular fallback.

## Update flow

1. An operator builds a firmware image with a unique monotonic build number.
2. The release tool hashes the image, signs its manifest with the offline
   ECDSA P-256 release key, and uploads the binary to private remote R2.
3. D1 records the release, an explicit device rollout, and a signed-telemetry
   `OTA` command.
4. The device receives the offer on its next signed heartbeat and verifies the
   board, build number, size, SHA-256 digest, release signature, and HTTPS
   certificate chain.
5. Installation waits until trusted Wi-Fi is connected and the motorcycle is
   disarmed and stationary.
6. The firmware streams into the inactive ESP32 OTA slot, verifies the complete
   binary, activates it, and reboots.
7. The new firmware runs for 15 seconds before it confirms health and
   acknowledges the cloud command. D1 then marks the rollout `installed`.

This resembles iOS and Android OTA at the architectural level: a trusted
server offers a signed release, the device verifies it, installs into an
alternate slot, reboots, and reports the result. The staging implementation is
not yet smartphone-grade: it has no rider-facing update UI, scheduled install,
percentage rollout service, cellular download, or fully proven automatic
boot-failure rollback. Those remain production gates.

## Required inputs

For each device:

- A unique `DEVICE_ID` registered in D1.
- A provisioned per-device signed-telemetry key and active credential.
- A one-time USB flash of OTA-capable signed firmware.
- At least one trusted 2.4 GHz Wi-Fi profile with working internet access.
- Enough stable power to finish the download, flash write, and reboot.

For each release:

- A release version such as `0.1.3`.
- A never-before-used build number greater than every build that may receive it.
- An explicit target device or reviewed rollout cohort.
- A tested source revision and concise release notes.
- Access to the release private key. By default the tool reads
  `%USERPROFILE%\.bikeboss-ota\release-key.pem`; it must never enter Git or
  firmware.

Not required:

- A SIM card for Wi-Fi OTA.
- The operator's computer or phone on the motorcycle's LAN.
- Port forwarding, mDNS, a public IP, or physical USB after bootstrap.
- Public R2 access. The firmware bucket must remain private.

## One-time staging setup

The current staging environment is already configured with:

- Worker: `bikeboss-api-staging`
- D1: `bikeboss-db-staging`
- Private R2: `bikeboss-firmware-staging`
- Schema: `backend/migrations/011_global_firmware_ota.sql`
- Mini App command deduplication: `backend/migrations/012_firmware_user_install.sql`

For a clean staging environment, create a private R2 bucket, bind it as
`FIRMWARE`, apply migrations 011 and 012 to remote D1, provision the existing
Worker and device-signing secrets, and deploy with the staging Wrangler
environment. Keep production resources and routes separate.

The release public key in `firmware/include/ota_release_public_key.h` must match
the protected private signing key. Changing that trust root requires a firmware
transition release and careful key-rotation plan.

## Publish a canary

From the repository:

```powershell
Set-Location backend
npm run firmware:release -- <version> <new-build-number> BB-00000001 staging
```

Example for the next build after the verified canary:

```powershell
npm run firmware:release -- 0.1.3 2026081205 BB-00000001 staging
```

The tool is intentionally locked to staging. It rejects a reused D1 build
number before building or writing R2, builds the release firmware, uploads with
Wrangler's `--remote` flag, and creates one device rollout. Treat every
published build number and R2 object key as immutable, including revoked and
failed releases.

## Install from the Mini App

After an operator publishes and activates a signed release, an owner can open:

```text
Mini App → Account → Settings → Firmware Update
```

The screen compares the installed and latest builds, explains the release,
shows tracker/connection/parking readiness and offers one **Install update** action.
Before requesting the install, the rider selects one download policy:

- **Wi-Fi only (recommended):** waits for an approved trusted Wi-Fi profile and
  never spends SIM data.
- **Any internet:** still prefers trusted Wi-Fi, then permits A7670G 4G when
  Wi-Fi is unavailable. Carrier charges may apply.

The authenticated API verifies device ownership, selects the newest active
release for the XIAO ESP32-S3 board and queues at most one active OTA command
for that device and release. Shared read-only prototype accounts cannot start
an update.

The Mini App request does not immediately force a flash. The tracker receives
the signed offer on a heartbeat and still waits for the selected permitted
connection, disarmed state and no vehicle movement. Both policies retain signed
manifest, board, monotonic build, exact length, SHA-256 and post-boot health
verification. The user may close the Mini App after requesting the update; the
screen polls cloud state when open and later shows the installed acknowledgement.

## Verify the rollout

The expected device log is:

```text
[GLOBAL-OTA] Release ... accepted; waiting for safe install.
[GLOBAL-OTA] Verified image installed; rebooting into trial slot.
[GLOBAL-OTA] Trial image running; 15-second health confirmation pending.
[GLOBAL-OTA] Trial image marked valid; cloud acknowledgement queued.
```

Query the remote staging state:

```powershell
node node_modules/wrangler/bin/wrangler.js d1 execute bikeboss-db-staging `
  --env staging --remote `
  --command "SELECT r.release_uuid,r.version,r.build_number,ro.device_id,ro.status,ro.offered_at,ro.installed_at,ro.failure_reason FROM firmware_rollouts ro JOIN firmware_releases r ON r.release_uuid=ro.release_uuid ORDER BY ro.created_at DESC LIMIT 20"
```

Do not expand the cohort until the canary reports all of the following:

- Rollout `status = 'installed'`.
- Its device command is `status = 'acked'` and `ack_status = 'applied'`.
- `devices.firmware_ver` and `devices.firmware_build` match the release.
- Signed telemetry sequences continue increasing after reboot.

To offer the same verified release to another explicitly reviewed device, add a
rollout and command using the existing release UUID:

```sql
INSERT INTO firmware_rollouts (release_uuid, device_id)
VALUES ('<release-uuid>', '<device-id>');
INSERT INTO device_commands (device_id, command, payload_json)
VALUES ('<device-id>', 'OTA', '{"release_id":"<release-uuid>"}');
```

Expand in small cohorts and monitor each cohort before adding the next one.
"Global" describes internet reachability; it does not remove Cloudflare plan,
bandwidth, concurrency, cost, or operational rollout limits.

## Revoke or cancel

Revoke first so the Worker stops offering and downloading the release, expire
its queued commands, then cancel incomplete rollout rows:

```sql
UPDATE firmware_releases
SET status = 'revoked'
WHERE release_uuid = '<release-uuid>';

UPDATE device_commands
SET status = 'expired'
WHERE command = 'OTA'
  AND status IN ('pending', 'delivered')
  AND json_extract(payload_json, '$.release_id') = '<release-uuid>';

UPDATE firmware_rollouts
SET status = 'cancelled',
    failed_at = datetime('now'),
    failure_reason = '<operator-reason>',
    updated_at = datetime('now')
WHERE release_uuid = '<release-uuid>'
  AND status IN ('pending', 'offered');
```

Cancellation is best effort. A device that already downloaded and activated
the image may still finish booting and report `installed`. Do not delete or
replace the R2 object and do not reuse its build number. Fix the defect, assign
a higher build number, and publish a new signed release.

## SIM and cellular checklist

Inserting a SIM is separate from Wi-Fi OTA. For cellular tracking, the SIM must
be activated, data-enabled, unlocked or have the configured PIN, supported by
the A7670G bands, and used with the carrier's correct APN. The LTE antenna,
coverage, common ground, and a power supply that tolerates modem current peaks
are also required.

After inserting a powered-down device's SIM, verify `AT+CPIN?`, network
registration, packet attachment, APN/PDP activation, and a signed HTTPS
telemetry POST. The current bench has verified modem AT communication but has
not completed this test with a real SIM. A SIM is useful for tracking outside
trusted Wi-Fi; it is not a prerequisite for the verified Wi-Fi OTA path.

## Production gates

- Complete the real-SIM cellular telemetry field test.
- Enable and verify ESP32 secure boot and flash encryption.
- Prove automatic rollback from an image that fails during early boot.
- Add operator authorization, audit controls, release notes, cohort selection,
  rollout pause/resume, and fleet metrics instead of direct SQL operations.
- Back up and migrate production D1, create a separate private production R2
  bucket, configure production bindings, and run an internal production canary.
- Keep the release private key offline or move signing into an audited release
  system with restricted access.
