# BikeBoss Home-Lab Deployment

The home-lab stack runs the existing Worker application on Node.js without
changing its route handlers:

- Nginx serves the production Telegram Mini App.
- `/api/*`, `/webhook/*`, and `/health` are proxied to the private API service.
- A D1-compatible adapter stores relational data in SQLite with WAL enabled.
- An R2-compatible read adapter serves signed OTA binaries from local storage.
- The Worker scheduled handler runs every five minutes and at 09:00 UTC.
- SQLite creates daily online backups at 03:15 UTC and retains 14 days.

The public hostname remains `bikeboss.creative-studio.blog`. Cloudflare Tunnel
only transports HTTPS traffic to `127.0.0.1:5173`; the application, SQLite
database, firmware files, and scheduled work run on the home server.

## Runtime layout

```text
deploy/homelab/runtime/
├── data/
│   ├── bikeboss.sqlite
│   └── import.sql          # optional one-time D1 export; renamed after import
├── firmware/              # R2 object keys reproduced as relative paths
├── release-staging/        # prepared immutable release bundles
└── backups/               # automatic online SQLite backups
```

Runtime state and secrets are Git-ignored. The Compose stack reads application
secrets from `backend/.dev.vars` by default.

When the original Cloudflare `DEVICE_KEY_MASTER` is unavailable (Worker secrets
cannot be read back), the same variable may contain a JSON object of explicitly
provisioned device keys, for example `{"BB-00000001:v1":"<64 hex>"}`. Store it
only in the protected server secret file. This keeps existing signed devices
and their encrypted trusted-Wi-Fi profiles compatible during migration.

## Start or update

```bash
cd deploy/homelab
mkdir -p runtime/data runtime/firmware runtime/backups
docker compose build
docker compose up -d
docker compose ps
curl http://127.0.0.1:5173/health
```

The frontend build intentionally sets `VITE_API_BASE` to an empty value, making
the Mini App call its own hostname. Do not add a Worker URL to the home-lab
build.

## Publish a signed firmware update

Build with a globally newer number, then prepare an immutable release bundle:

```powershell
$env:BIKEBOSS_FIRMWARE_VERSION='0.1.4'
$env:BIKEBOSS_FIRMWARE_BUILD='2026081206'
Set-Location firmware
pio run -e seeed_xiao_esp32s3_staging_signed_release
Set-Location ..
node deploy/homelab/scripts/prepare-firmware-release.mjs `
  firmware/.pio/build/seeed_xiao_esp32s3_staging_signed_release/firmware.bin `
  0.1.4 2026081206 BB-00000001 "Release notes"
```

Copy the generated `runtime/release-staging/<build>` directory to the same
location on the server. From the repository on the server, publish it with:

```bash
deploy/homelab/scripts/publish-firmware-release.sh 2026081206
```

The publisher verifies the manifest, size, SHA-256 and monotonic build before
placing the binary and transactionally registering its selected-device pending
rollout. It never creates an OTA command. The owner must open **Account →
Settings → Firmware Update** and press **Install update**.

## Data migration

Before first start, place the D1 SQL export at `runtime/data/import.sql`. On a
new database, the API imports it transactionally and renames it to
`import.sql.applied`. Copy each active R2 firmware object into
`runtime/firmware/` using the exact `object_key` stored in
`firmware_releases`.

Keep the Cloudflare Worker and its D1/R2 resources intact until the server has
passed public Mini App, Telegram webhook, telemetry, OTA download, and reboot
persistence checks.

## Backups and rollback

- Database backups are stored in `runtime/backups`.
- The Cloudflare Worker remains the rollback origin during migration.
- To roll back the Mini App immediately, restore the previous Cloudflare Tunnel
  origin or Pages custom-domain route and restore the previous Telegram webhook.
- Never delete D1 or R2 until the home-lab deployment has operated correctly for
  the agreed retention window.
