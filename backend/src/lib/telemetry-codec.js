/**
 * Compact telemetry v2 wire codec.
 *
 * Routine packets use scaled integers to reduce cellular bytes. This module is
 * the only place where the abbreviated wire contract is expanded into the
 * descriptive object consumed by persistence, geofencing and trip logic.
 *
 * Compact point schema:
 *   v: protocol version (2)
 *   id: device ID
 *   q: monotonic sequence
 *   t: captured Unix time in seconds
 *   a: arm state (0..2)
 *   g: [fix, latE7, lonE7, speedCmS, accuracyDm, hdopX10,
 *       satellites, headingX10, altitudeDm] or [0] without a fix
 *   m: [imuCalibrated, moving, accelMagnitudeX100, gyroMagnitudeX1000]
 *   b: battery millivolts
 *   c: crash stage (0..4)
 *   k: optional command ACKs: [[commandId, appliedFlag], ...]
 *   o: optional owner presence [authenticated, connected, ageSeconds, confidencePermille]
 *   u: optional uplink [typeCode, signalDbm, profileLabel, profileId], where
 *      1=Wi-Fi and 2=cellular. profileId is opaque; neither field is a raw SSID.
 *   f: optional firmware [buildNumber, version]
 */

const PROTOCOL_VERSION = 2;
const MIN_CAPTURED_AT_SECONDS = 1_704_067_200; // 2024-01-01T00:00:00Z
const MAX_CAPTURED_AT_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

function failed(error) {
  return { ok: false, error };
}

function isIntegerBetween(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function parseCommandAcks(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5) return null;

  const acknowledgements = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [id, applied] = item;
    if (!isIntegerBetween(id, 1, Number.MAX_SAFE_INTEGER)
        || !isIntegerBetween(applied, 0, 1)) {
      return null;
    }
    acknowledgements.push({ id, status: applied ? 'applied' : 'failed' });
  }
  return acknowledgements;
}

function normalizeOwnerPresence(value) {
  if (value == null) {
    return { authenticated: false, connected: false, age_seconds: null, confidence: 0 };
  }
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [authenticated, connected, ageSeconds, confidencePermille] = value;
  if (!isIntegerBetween(authenticated, 0, 1)
      || !isIntegerBetween(connected, 0, 1)
      || !isIntegerBetween(ageSeconds, 0, 86_400)
      || !isIntegerBetween(confidencePermille, 0, 1_000)
      || (authenticated && !connected)) {
    return null;
  }
  return {
    authenticated: Boolean(authenticated),
    connected: Boolean(connected),
    age_seconds: ageSeconds,
    confidence: confidencePermille / 1_000,
  };
}

function normalizeCompactUplink(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return undefined;
  const [typeCode, rawSignal, rawLabel, rawProfileId] = value;
  if (!isIntegerBetween(typeCode, 1, 2)) return undefined;
  if (rawSignal != null && !isIntegerBetween(rawSignal, -140, 0)) return undefined;
  const label = normalizeUplinkLabel(rawLabel);
  if (label === undefined) return undefined;
  const profileId = normalizeUplinkProfileId(rawProfileId);
  if (profileId === undefined || (typeCode !== 1 && profileId != null)) return undefined;
  const normalized = {
    type: typeCode === 1 ? 'wifi' : 'cellular',
    signal_dbm: rawSignal ?? null,
    generation: typeCode === 2 ? '4g' : null,
    label,
  };
  if (profileId != null) normalized.profile_id = profileId;
  return normalized;
}

function normalizeUplinkProfileId(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const profileId = value.trim();
  if (!/^[A-Za-z0-9-]{8,64}$/u.test(profileId)) return undefined;
  return profileId;
}

function normalizeUplinkLabel(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  if (!label || label.length > 32 || /[\u0000-\u001f\u007f]/u.test(label)) return undefined;
  return label;
}

function normalizeVerboseUplink(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const type = String(value.type ?? '').toLowerCase();
  if (!['wifi', 'cellular'].includes(type)) return undefined;
  const signal = value.signal_dbm == null ? null : Number(value.signal_dbm);
  if (signal != null && !isIntegerBetween(signal, -140, 0)) return undefined;
  const generation = value.generation == null ? null : String(value.generation).toLowerCase();
  if (generation != null && !['2g', '3g', '4g', '5g'].includes(generation)) return undefined;
  const label = normalizeUplinkLabel(value.label);
  if (label === undefined) return undefined;
  const profileId = normalizeUplinkProfileId(value.profile_id);
  if (profileId === undefined || (type !== 'wifi' && profileId != null)) return undefined;
  const normalized = { type, signal_dbm: signal, generation, label };
  if (profileId != null) normalized.profile_id = profileId;
  return normalized;
}

function normalizeFirmware(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (value.length !== 2) return undefined;
    const [buildNumber, version] = value;
    if (!isIntegerBetween(buildNumber, 0, 2_147_483_647)
        || typeof version !== 'string' || !/^[0-9A-Za-z.+_-]{1,32}$/u.test(version)) {
      return undefined;
    }
    return { build_number: buildNumber, version };
  }
  if (typeof value !== 'object') return undefined;
  const buildNumber = Number(value.build_number);
  const version = String(value.version ?? '');
  if (!isIntegerBetween(buildNumber, 0, 2_147_483_647)
      || !/^[0-9A-Za-z.+_-]{1,32}$/u.test(version)) return undefined;
  return { build_number: buildNumber, version };
}

function normalizeCompactGps(value) {
  if (!Array.isArray(value) || ![1, 9].includes(value.length)) return null;
  const fix = value[0];
  if (!isIntegerBetween(fix, 0, 1)) return null;

  if (!fix) {
    if (value.length !== 1) return null;
    return {
      fix: false,
      lat: null,
      lon: null,
      speed: 0,
      speed_m_s: 0,
      accuracy_m: null,
      hdop: null,
      satellites: 0,
      heading: null,
      altitude_m: null,
      source: 'l76k',
    };
  }

  const [,
    latitudeE7, longitudeE7, speedCmS, accuracyDm, hdopX10,
    satellites, headingX10, altitudeDm,
  ] = value;
  if (!isIntegerBetween(latitudeE7, -900_000_000, 900_000_000)
      || !isIntegerBetween(longitudeE7, -1_800_000_000, 1_800_000_000)
      || !isIntegerBetween(speedCmS, 0, 20_000)
      || !isIntegerBetween(accuracyDm, 0, 10_000)
      || !isIntegerBetween(hdopX10, 0, 9_999)
      || !isIntegerBetween(satellites, 0, 99)
      || !isIntegerBetween(headingX10, 0, 3_600)
      || !isIntegerBetween(altitudeDm, -20_000, 200_000)) {
    return null;
  }

  return {
    fix: true,
    lat: latitudeE7 / 10_000_000,
    lon: longitudeE7 / 10_000_000,
    speed: speedCmS * 0.036, // cm/s -> km/h
    speed_m_s: speedCmS / 100,
    accuracy_m: accuracyDm / 10,
    hdop: hdopX10 / 10,
    satellites,
    heading: headingX10 / 10,
    altitude_m: altitudeDm / 10,
    source: 'l76k',
  };
}

function normalizeCompactImu(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [calibrated, moving, accelMagnitudeX100, gyroMagnitudeX1000] = value;
  if (!isIntegerBetween(calibrated, 0, 1)
      || !isIntegerBetween(moving, 0, 1)
      || !isIntegerBetween(accelMagnitudeX100, 0, 20_000)
      || !isIntegerBetween(gyroMagnitudeX1000, 0, 100_000)) {
    return null;
  }
  return {
    calibrated: Boolean(calibrated),
    moving: Boolean(moving),
    atotal: accelMagnitudeX100 / 100,
    gtotal: gyroMagnitudeX1000 / 1_000,
  };
}

export function normalizeCompactTelemetry(point, inheritedDeviceId = null) {
  if (!point || typeof point !== 'object' || Array.isArray(point)) {
    return failed('telemetry_compact_invalid');
  }
  if (point.v != null && point.v !== PROTOCOL_VERSION) {
    return failed('telemetry_version_unsupported');
  }

  const deviceId = String(point.id ?? inheritedDeviceId ?? '').trim();
  const sequence = Number(point.q);
  const capturedAtSeconds = Number(point.t);
  const armState = Number(point.a);
  const batteryMillivolts = point.b == null ? null : Number(point.b);
  const crashStage = Number(point.c);
  const gps = normalizeCompactGps(point.g);
  const imu = normalizeCompactImu(point.m);
  const commandAcks = parseCommandAcks(point.k);
  const ownerPresence = normalizeOwnerPresence(point.o);
  const uplink = normalizeCompactUplink(point.u);
  const firmware = normalizeFirmware(point.f);

  if (!DEVICE_ID_PATTERN.test(deviceId)) return failed('device_id_invalid');
  if (!isIntegerBetween(sequence, 0, Number.MAX_SAFE_INTEGER)) {
    return failed('sequence_invalid');
  }
  if (!isIntegerBetween(capturedAtSeconds, MIN_CAPTURED_AT_SECONDS, MAX_CAPTURED_AT_SECONDS)) {
    return failed('captured_at_invalid');
  }
  if (!isIntegerBetween(armState, 0, 2)) return failed('arm_state_invalid');
  if (batteryMillivolts != null && !isIntegerBetween(batteryMillivolts, 0, 60_000)) {
    return failed('vbat_invalid');
  }
  if (!isIntegerBetween(crashStage, 0, 4)) return failed('crash_stage_invalid');
  if (!gps) return failed('gps_invalid');
  if (!imu) return failed('imu_invalid');
  if (!commandAcks) return failed('command_acks_invalid');
  if (!ownerPresence) return failed('owner_presence_invalid');
  if (uplink === undefined) return failed('uplink_invalid');
  if (firmware === undefined) return failed('firmware_invalid');

  return {
    ok: true,
    format: 'compact',
    value: {
      device_id: deviceId,
      message_id: `${deviceId}-${sequence}`,
      sequence,
      captured_at: new Date(capturedAtSeconds * 1_000).toISOString(),
      arm_state: armState,
      gps,
      imu: {
        calibrated: imu.calibrated,
        atotal: imu.atotal,
        gtotal: imu.gtotal,
      },
      vbat: batteryMillivolts == null ? null : batteryMillivolts / 1_000,
      crash_stage: crashStage,
      crash_confirmed: crashStage === 4,
      motion_state: imu.moving ? 'moving' : 'stationary',
      geofence_active: false,
      command_acks: commandAcks,
      owner_presence: ownerPresence,
      uplink,
      firmware,
    },
  };
}

function normalizeVerboseTelemetry(body) {
  const deviceId = String(body?.device_id ?? '').trim();
  const sequence = Number(body?.sequence);
  if (!DEVICE_ID_PATTERN.test(deviceId)) return failed('device_id_invalid');
  if (typeof body.message_id !== 'string'
      || !body.message_id
      || body.message_id.length > 100) {
    return failed('message_id_invalid');
  }
  if (!isIntegerBetween(sequence, 0, Number.MAX_SAFE_INTEGER)) {
    return failed('sequence_invalid');
  }
  if (!Number.isFinite(Date.parse(body.captured_at))) {
    return failed('captured_at_invalid');
  }
  const rawPresence = body.owner_presence;
  const ownerPresence = rawPresence == null ? {
    authenticated: false,
    connected: false,
    age_seconds: null,
    confidence: 0,
  } : {
    authenticated: rawPresence.authenticated === true,
    connected: rawPresence.connected === true,
    age_seconds: Number(rawPresence.age_seconds),
    confidence: Number(rawPresence.confidence),
  };
  if (rawPresence != null
      && (!Number.isInteger(ownerPresence.age_seconds) || ownerPresence.age_seconds < 0
        || ownerPresence.age_seconds > 86_400
        || !Number.isFinite(ownerPresence.confidence) || ownerPresence.confidence < 0
        || ownerPresence.confidence > 1
        || (ownerPresence.authenticated && !ownerPresence.connected))) {
    return failed('owner_presence_invalid');
  }
  const uplink = normalizeVerboseUplink(body.uplink);
  if (uplink === undefined) return failed('uplink_invalid');
  const firmware = normalizeFirmware(body.firmware);
  if (firmware === undefined) return failed('firmware_invalid');
  return {
    ok: true,
    format: 'verbose',
    value: { ...body, device_id: deviceId, sequence, owner_presence: ownerPresence, uplink, firmware },
  };
}

export function normalizeTelemetryEnvelope(body) {
  const compact = body?.id != null || body?.q != null || Array.isArray(body?.g);
  return compact ? normalizeCompactTelemetry(body) : normalizeVerboseTelemetry(body);
}

export function normalizeTelemetryBatch(body, { maxSamples = 8 } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.v !== PROTOCOL_VERSION) {
    return failed('telemetry_batch_invalid');
  }
  const deviceId = String(body.id ?? '').trim();
  const requestSequence = Number(body.q);
  if (!DEVICE_ID_PATTERN.test(deviceId)) return failed('device_id_invalid');
  if (!isIntegerBetween(requestSequence, 0, Number.MAX_SAFE_INTEGER)) {
    return failed('sequence_invalid');
  }
  if (!Array.isArray(body.p) || body.p.length < 1 || body.p.length > maxSamples) {
    return failed('telemetry_batch_size_invalid');
  }

  const samples = [];
  let previousSequence = -1;
  for (const point of body.p) {
    const normalized = normalizeCompactTelemetry(point, deviceId);
    if (!normalized.ok) return normalized;
    if (normalized.value.device_id !== deviceId) return failed('device_id_mismatch');
    if (normalized.value.sequence <= previousSequence) {
      return failed('telemetry_batch_sequence_invalid');
    }
    previousSequence = normalized.value.sequence;
    samples.push(normalized.value);
  }

  if (samples.at(-1).sequence !== requestSequence) {
    return failed('sequence_mismatch');
  }
  return { ok: true, format: 'compact_batch', deviceId, sequence: requestSequence, samples };
}

export function compactDeviceResponse(sequence, commands = []) {
  const compactCommands = commands.slice(0, 5).map((command) => {
    let payload = null;
    if (command.payload_json) {
      try {
        payload = JSON.parse(command.payload_json);
      } catch {
        payload = null;
      }
    }
    return payload == null
      ? [Number(command.id), String(command.command)]
      : [Number(command.id), String(command.command), payload];
  });
  return { ok: 1, q: Number(sequence), c: compactCommands };
}
