#!/usr/bin/env bash
set -euo pipefail

BUILD_NUMBER=${1:-}
if [[ ! "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "Usage: $0 <build-number>" >&2
  exit 2
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STAGE="$ROOT/runtime/release-staging/$BUILD_NUMBER"
MANIFEST="$STAGE/release.json"
SOURCE="$STAGE/firmware/seeed_xiao_esp32s3/$BUILD_NUMBER/firmware.bin"
TARGET="$ROOT/runtime/firmware/seeed_xiao_esp32s3/$BUILD_NUMBER/firmware.bin"

node - "$MANIFEST" "$SOURCE" "$BUILD_NUMBER" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const [manifestPath, binaryPath, rawBuild] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const binary = readFileSync(binaryPath);
const expectedObjectKey = `seeed_xiao_esp32s3/${rawBuild}/firmware.bin`;
const actualHash = createHash('sha256').update(binary).digest('hex');
if (manifest.build_number !== Number(rawBuild)
    || manifest.object_key !== expectedObjectKey
    || manifest.binary_path !== `firmware/${expectedObjectKey}`
    || manifest.size_bytes !== statSync(binaryPath).size
    || manifest.sha256_hex !== actualHash) {
  throw new Error('Release manifest does not match the staged firmware binary.');
}
NODE

cd "$ROOT"
LATEST=$(docker compose exec -T api node -e \
  "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/bikeboss.sqlite',{readOnly:true});console.log(d.prepare('SELECT COALESCE(MAX(build_number),0) AS n FROM firmware_releases').get().n)")
if (( BUILD_NUMBER <= LATEST )); then
  echo "Refusing non-monotonic release: latest=$LATEST requested=$BUILD_NUMBER" >&2
  exit 1
fi
if [[ -e "$TARGET" ]]; then
  echo "Refusing to overwrite existing firmware: $TARGET" >&2
  exit 1
fi

install -D -m 0644 "$SOURCE" "$TARGET"
docker compose exec -T api node -e \
  "const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/bikeboss.sqlite');d.exec(fs.readFileSync(0,'utf8'));" \
  < "$STAGE/register.sql"

docker compose exec -T api node -e \
  "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/bikeboss.sqlite',{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT release_uuid,version,build_number,object_key,size_bytes,sha256_hex,status FROM firmware_releases WHERE build_number=?').get(Number(process.argv[1]))))" \
  "$BUILD_NUMBER"
