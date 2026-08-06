#!/usr/bin/env node
/**
 * =============================================================================
 * BikeBoss — Mock Device Simulator
 * =============================================================================
 *
 * Simulates an on-bike BikeBoss unit hitting the backend API — no hardware
 * needed. Use it to validate ingestion, alerts, geofencing, and the
 * Telegram notification path end-to-end.
 *
 * Usage:
 *   node scripts/simulate-device.mjs --url http://127.0.0.1:8787 --device BB-00000001 --heartbeat
 *   node scripts/simulate-device.mjs --url http://127.0.0.1:8787 --device BB-00000001 --crash
 *   node scripts/simulate-device.mjs --url http://127.0.0.1:8787 --device BB-00000001 --powercut
 *   node scripts/simulate-device.mjs --url http://127.0.0.1:8787 --device BB-00000001 --ride --points 20
 *   node scripts/simulate-device.mjs --url http://127.0.0.1:8787 --device BB-00000001 --vanlift
 *   node scripts/simulate-device.mjs --url http://127.0.0.1:8787 --device BB-00000001 --geofence-breach
 *
 * Options:
 *   --url        Base URL of the worker (default http://127.0.0.1:8787)
 *   --device     Device ID (default BB-00000001)
 *   --lat/--lon  Starting position (default: Phnom Penh center)
 *   --points     Number of telemetry points for --ride (default 10)
 */

const args = parseArgs(process.argv.slice(2));

const BASE_URL = (args.url || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DEVICE_ID = args.device || 'BB-00000001';
const START_LAT = parseFloat(args.lat ?? '11.5564');   // Phnom Penh
const START_LON = parseFloat(args.lon ?? '104.9282');

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function baseTelemetry(overrides = {}) {
  return {
    device_id: DEVICE_ID,
    timestamp: Date.now(),
    arm_state: 1,
    gps: { lat: START_LAT, lon: START_LON, speed: 0, fix: true },
    imu: { ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0, atotal: 9.81, gtotal: 0 },
    vbat: 13.6,
    crash_stage: 0,
    crash_confirmed: false,
    geofence_active: false,
    ...overrides,
  };
}

function crashPayload() {
  return {
    device_id: DEVICE_ID,
    timestamp: Date.now(),
    event: 'CRASH_CONFIRMED',
    gps: { lat: START_LAT, lon: START_LON, fix: true },
    imu: { atotal: 24.3, gtotal: 3.1, az: 1.2 },
  };
}

function powerCutPayload() {
  return {
    device_id: DEVICE_ID,
    event: 'POWER_CUT',
    vbat: 9.4,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function post(path, payload) {
  const url = `${BASE_URL}${path}`;
  console.log(`\n→ POST ${url}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  console.log(`← ${resp.status} ${text}`);
  return resp;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function sendHeartbeat() {
  await post('/api/v1/heartbeat', baseTelemetry());
}

async function sendCrash() {
  await post('/api/v1/crash', crashPayload());
}

async function sendPowerCut() {
  await post('/api/v1/alert/powercut', powerCutPayload());
}

async function sendRide(points) {
  console.log(`\n=== Simulating a ${points}-point ride ===`);
  let lat = START_LAT;
  let lon = START_LON;
  for (let i = 0; i < points; i++) {
    // Move roughly north-east ~50-100m per point, speed varies
    lat += 0.0005 + Math.random() * 0.0004;
    lon += 0.0005 + Math.random() * 0.0004;
    const speed = 15 + Math.random() * 45;
    await post('/api/v1/telemetry', baseTelemetry({
      gps: { lat, lon, speed, fix: true },
      imu: { ax: 0.2, ay: 0.1, az: 9.9, gx: 0.01, gy: 0.02, gz: 0.01, atotal: 9.92, gtotal: 0.03 },
    }));
    await sleep(400);
  }
  console.log('=== Ride complete ===');
}

async function sendVanLift() {
  // GPS lost but strong vibration — bike inside a metal van
  await post('/api/v1/telemetry', baseTelemetry({
    gps: { lat: null, lon: null, speed: null, fix: false },
    imu: { ax: 1.2, ay: 0.8, az: 10.4, gx: 0.1, gy: 0.1, gz: 0.05, atotal: 10.6, gtotal: 0.16 },
  }));
}

async function sendGeofenceBreach() {
  // First set a geofence at start point via API, then teleport 500m away
  await post('/api/v1/geofence/set', {
    device_id: DEVICE_ID,
    label: 'Simulated Anchor',
    anchor_lat: START_LAT,
    anchor_lon: START_LON,
    radius_m: 100,
  });
  await post('/api/v1/telemetry', baseTelemetry({
    gps: { lat: START_LAT + 0.005, lon: START_LON + 0.005, speed: 25, fix: true },
  }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`BikeBoss device simulator`);
  console.log(`Target: ${BASE_URL}  Device: ${DEVICE_ID}`);

  // Health check
  try {
    const resp = await fetch(`${BASE_URL}/health`);
    console.log(`Health: ${resp.status} ${await resp.text()}`);
  } catch {
    console.error(`\n✗ Cannot reach ${BASE_URL}/health — is \`npm run dev\` running in backend/?\n`);
    process.exit(1);
  }

  if (args.crash) await sendCrash();
  else if (args.powercut) await sendPowerCut();
  else if (args.ride) await sendRide(Number(args.points ?? 10));
  else if (args.vanlift) await sendVanLift();
  else if (args['geofence-breach']) await sendGeofenceBreach();
  else await sendHeartbeat(); // default
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
