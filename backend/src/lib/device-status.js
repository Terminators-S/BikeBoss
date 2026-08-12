export const DEFAULT_CONNECTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

export function parseDatabaseTimestamp(value) {
  if (!value) return null;
  const normalized = /Z|[+-]\d{2}:?\d{2}$/u.test(value)
    ? value
    : `${String(value).replace(' ', 'T')}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function connectivityFromTelemetry(
  latest,
  timeoutMs = DEFAULT_CONNECTIVITY_TIMEOUT_MS,
  nowMs = Date.now(),
) {
  const lastReceivedAt = latest?.last_received_at ?? latest?.received_at;
  const lastSeenMs = parseDatabaseTimestamp(lastReceivedAt);
  if (lastSeenMs == null) {
    return {
      status: 'unknown',
      online: false,
      last_seen_at: null,
      age_seconds: null,
      transport: latest?.uplink_type ?? 'unknown',
      signal_dbm: latest?.uplink_signal_dbm ?? null,
      generation: latest?.uplink_generation ?? null,
      label: latest?.uplink_label ?? null,
      profile_id: latest?.uplink_profile_id ?? null,
    };
  }

  const ageMs = Math.max(0, nowMs - lastSeenMs);
  const online = ageMs <= timeoutMs;
  return {
    status: online ? 'online' : 'offline',
    online,
    last_seen_at: lastReceivedAt,
    age_seconds: Math.floor(ageMs / 1000),
    transport: latest?.uplink_type ?? 'unknown',
    signal_dbm: latest?.uplink_signal_dbm ?? null,
    generation: latest?.uplink_generation ?? null,
    label: latest?.uplink_label ?? null,
    profile_id: latest?.uplink_profile_id ?? null,
  };
}

export function measuredVehicleBattery(latest) {
  if (latest?.vbat == null || latest.vbat === '') return null;
  const voltage = Number(latest.vbat);
  return Number.isFinite(voltage) && voltage > 0 ? voltage : null;
}
