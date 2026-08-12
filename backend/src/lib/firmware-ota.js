import { verifyDeviceRequestSignature } from './auth.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const RELEASE_ID_PATTERN = /^[0-9a-f-]{36}$/iu;
export const FIRMWARE_BOARD = 'seeed_xiao_esp32s3';
export const FIRMWARE_DOWNLOAD_PREFERENCES = Object.freeze({
  WIFI_ONLY: 'wifi_only',
  ANY_INTERNET: 'any_internet',
});

export function normalizeFirmwareDownloadPreference(value) {
  return value === FIRMWARE_DOWNLOAD_PREFERENCES.ANY_INTERNET
    ? FIRMWARE_DOWNLOAD_PREFERENCES.ANY_INTERNET
    : FIRMWARE_DOWNLOAD_PREFERENCES.WIFI_ONLY;
}

export function summarizeFirmwareRelease(release) {
  if (!release) return null;
  return {
    id: release.release_uuid,
    version: String(release.version),
    build_number: Number(release.build_number),
    board: String(release.board),
    size_bytes: Number(release.size_bytes),
    notes: release.notes ? String(release.notes) : null,
    published_at: release.created_at ?? null,
  };
}

export function deriveFirmwareUpdateState({
  currentBuild = 0,
  release = null,
  rollout = null,
  command = null,
  credentialActive = false,
  readOnly = false,
} = {}) {
  if (!release) return 'unavailable';

  const installedBuild = Number(currentBuild ?? 0);
  const releaseBuild = Number(release.build_number ?? 0);
  if (installedBuild >= releaseBuild || rollout?.status === 'installed'
      || (command?.status === 'acked' && command?.ack_status === 'applied')) {
    return 'up_to_date';
  }
  if (readOnly) return 'read_only';
  if (installedBuild <= 0) return 'usb_required';
  if (!credentialActive) return 'service_required';
  if (rollout?.status === 'failed'
      || (command?.status === 'acked' && command?.ack_status === 'failed')) {
    return 'failed';
  }
  if (command?.status === 'delivered' || rollout?.status === 'offered') {
    return 'preparing';
  }
  if (command?.status === 'pending') return 'queued';
  return 'available';
}

export function releaseCanonicalPayload(release) {
  return [
    'bikeboss-ota-v1',
    String(release.release_uuid),
    String(release.version),
    String(release.build_number),
    String(release.board),
    String(release.size_bytes),
    String(release.sha256_hex).toLowerCase(),
  ].join('\n');
}

export function compactFirmwareManifest(release, deviceId, downloadPreference = 'wifi_only') {
  return {
    r: release.release_uuid,
    v: release.version,
    n: Number(release.build_number),
    b: release.board,
    z: Number(release.size_bytes),
    h: String(release.sha256_hex).toLowerCase(),
    s: release.signature_b64,
    p: `/api/v2/device/${encodeURIComponent(deviceId)}/firmware/${release.release_uuid}`,
    t: normalizeFirmwareDownloadPreference(downloadPreference) === 'any_internet'
      ? 'any' : 'wifi',
  };
}

export async function hydrateFirmwareCommand(command, deviceId, env) {
  let releaseId = '';
  let downloadPreference = FIRMWARE_DOWNLOAD_PREFERENCES.WIFI_ONLY;
  try {
    const queued = JSON.parse(command.payload_json ?? '{}');
    releaseId = String(queued.release_id ?? '');
    downloadPreference = normalizeFirmwareDownloadPreference(queued.download_preference);
  } catch {
    return { ...command, command: 'OTA_INVALID', payload_json: null };
  }
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    return { ...command, command: 'OTA_INVALID', payload_json: null };
  }

  const release = await env.DB.prepare(
    `SELECT r.* FROM firmware_releases r
     JOIN firmware_rollouts ro ON ro.release_uuid = r.release_uuid
     WHERE r.release_uuid = ? AND ro.device_id = ?
       AND r.status = 'active' AND ro.status IN ('pending', 'offered')`,
  ).bind(releaseId, deviceId).first();
  if (!release) return { ...command, command: 'OTA_INVALID', payload_json: null };

  await env.DB.prepare(
    `UPDATE firmware_rollouts SET
       command_id = COALESCE(command_id, ?), status = 'offered',
       offered_at = COALESCE(offered_at, datetime('now')),
       updated_at = datetime('now')
     WHERE release_uuid = ? AND device_id = ? AND status IN ('pending', 'offered')`,
  ).bind(command.id, releaseId, deviceId).run();

  return {
    ...command,
    payload_json: JSON.stringify(compactFirmwareManifest(
      release,
      deviceId,
      downloadPreference,
    )),
  };
}

export async function handleFirmwareDownloadV2(
  request,
  deviceId,
  releaseId,
  env,
) {
  if (!env.FIRMWARE) return json({ error: 'firmware_storage_unavailable' }, 503);
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    return json({ error: 'firmware_release_invalid' }, 400);
  }

  const authenticated = await verifyDeviceRequestSignature(
    request,
    '',
    deviceId,
    env,
    { enforceReplay: false },
  );
  if (!authenticated.ok) return json({ error: authenticated.error }, 401);

  const release = await env.DB.prepare(
    `SELECT r.* FROM firmware_releases r
     JOIN firmware_rollouts ro ON ro.release_uuid = r.release_uuid
     WHERE r.release_uuid = ? AND ro.device_id = ?
       AND r.status = 'active' AND ro.status IN ('pending', 'offered')`,
  ).bind(releaseId, deviceId).first();
  if (!release) return json({ error: 'firmware_release_not_offered' }, 404);

  const object = await env.FIRMWARE.get(release.object_key);
  if (!object) return json({ error: 'firmware_object_missing' }, 503);
  if (Number(object.size) !== Number(release.size_bytes)) {
    return json({ error: 'firmware_object_size_mismatch' }, 503);
  }

  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Length', String(release.size_bytes));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-BikeBoss-Release', release.release_uuid);
  headers.set('X-BikeBoss-Firmware-SHA256', release.sha256_hex);
  return new Response(object.body, { status: 200, headers });
}
