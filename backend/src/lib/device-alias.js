/**
 * Shared-prototype device aliases are staging fixtures that retain independent
 * ownership while reading live telemetry from one physical bench device.
 */

export function isSharedPrototype(device) {
  return Boolean(device?.telemetry_source_device_id);
}

const FULL_ACCESS_TEST_DEVICE = /^BB-TEST000[1-5]$/u;

export function hasStagingPrototypeAccess(device, env) {
  return env?.ENVIRONMENT === 'staging'
    && isSharedPrototype(device)
    && FULL_ACCESS_TEST_DEVICE.test(String(device?.device_id ?? ''));
}

export function isSharedPrototypeReadOnly(device, env) {
  return isSharedPrototype(device) && !hasStagingPrototypeAccess(device, env);
}

export function resolveTelemetryDeviceId(device) {
  return device?.telemetry_source_device_id || device?.device_id || null;
}

export function resolveControlDeviceId(device, env) {
  return hasStagingPrototypeAccess(device, env)
    ? resolveTelemetryDeviceId(device)
    : device?.device_id || null;
}

export function serializeClientDevice(device, env) {
  if (!device) return null;

  const {
    telemetry_source_device_id: sourceDeviceId,
    firmware_ver: firmwareVersion,
    ...publicDevice
  } = device;
  const sharedPrototype = Boolean(sourceDeviceId);
  const fullAccess = hasStagingPrototypeAccess(device, env);

  return {
    ...publicDevice,
    firmware_version: firmwareVersion ?? 'unknown',
    firmware_build: Number(device.firmware_build ?? 0),
    connection_mode: sharedPrototype && !fullAccess ? 'shared_prototype' : 'dedicated',
    capabilities: {
      live_telemetry: true,
      hardware_commands: !sharedPrototype || fullAccess,
      geofence_alerts: !sharedPrototype || fullAccess,
    },
  };
}

export function serializeClientTelemetry(latest, device) {
  if (!latest) return null;
  if (!isSharedPrototype(device)) return latest;

  return {
    ...latest,
    device_id: device.device_id,
    mirrored_from_prototype: true,
  };
}
