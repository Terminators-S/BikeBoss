import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasStagingPrototypeAccess,
  isSharedPrototype,
  isSharedPrototypeReadOnly,
  resolveControlDeviceId,
  resolveTelemetryDeviceId,
  serializeClientDevice,
  serializeClientTelemetry,
} from '../src/lib/device-alias.js';

test('dedicated devices use their own telemetry and retain hardware controls', () => {
  const device = {
    id: 1,
    device_id: 'BB-00000001',
    owner_id: 7,
    firmware_ver: '0.1.2',
    firmware_build: 2026081204,
  };

  assert.equal(isSharedPrototype(device), false);
  assert.equal(resolveTelemetryDeviceId(device), 'BB-00000001');
  assert.deepEqual(serializeClientDevice(device), {
    id: device.id,
    device_id: device.device_id,
    owner_id: device.owner_id,
    firmware_version: '0.1.2',
    firmware_build: 2026081204,
    connection_mode: 'dedicated',
    capabilities: {
      live_telemetry: true,
      hardware_commands: true,
      geofence_alerts: true,
    },
  });
});

test('shared aliases read prototype telemetry but do not expose its device ID', () => {
  const device = {
    id: 8,
    device_id: 'BB-TEST0001',
    owner_id: 11,
    telemetry_source_device_id: 'BB-00000001',
  };

  assert.equal(isSharedPrototype(device), true);
  assert.equal(resolveTelemetryDeviceId(device), 'BB-00000001');

  const serialized = serializeClientDevice(device);
  assert.equal(serialized.telemetry_source_device_id, undefined);
  assert.equal(serialized.connection_mode, 'shared_prototype');
  assert.equal(serialized.capabilities.hardware_commands, false);
  assert.equal(serialized.capabilities.geofence_alerts, false);

  assert.deepEqual(
    serializeClientTelemetry({ device_id: 'BB-00000001', gps_fix: 1 }, device),
    { device_id: 'BB-TEST0001', gps_fix: 1, mirrored_from_prototype: true },
  );
});

test('staging test aliases receive full prototype controls without exposing the source ID', () => {
  const device = {
    id: 8,
    device_id: 'BB-TEST0001',
    owner_id: 11,
    telemetry_source_device_id: 'BB-00000001',
  };
  const env = { ENVIRONMENT: 'staging' };

  assert.equal(hasStagingPrototypeAccess(device, env), true);
  assert.equal(isSharedPrototypeReadOnly(device, env), false);
  assert.equal(resolveControlDeviceId(device, env), 'BB-00000001');

  const serialized = serializeClientDevice(device, env);
  assert.equal(serialized.telemetry_source_device_id, undefined);
  assert.equal(serialized.connection_mode, 'dedicated');
  assert.equal(serialized.capabilities.hardware_commands, true);
  assert.equal(serialized.capabilities.geofence_alerts, true);
});

test('missing telemetry remains missing for an alias', () => {
  assert.equal(
    serializeClientTelemetry(null, {
      device_id: 'BB-TEST0002',
      telemetry_source_device_id: 'BB-00000001',
    }),
    null,
  );
});
