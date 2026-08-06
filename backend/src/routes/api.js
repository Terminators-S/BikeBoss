/**
 * JSON API handlers for the Mini App / dashboards.
 */

import { getDevice, latestTelemetry } from '../lib/db.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });

export async function handleGetDeviceStatus(deviceId, env) {
  const device = await getDevice(deviceId, env);
  if (!device) return json({ error: 'device not found' }, 404);

  const latest = await latestTelemetry(deviceId, env);

  const recentEvents = await env.DB.prepare(
    `SELECT * FROM events WHERE device_id = ? ORDER BY created_at DESC LIMIT 10`
  ).bind(deviceId).all();

  const geofences = await env.DB.prepare(
    `SELECT * FROM geofence_zones WHERE device_id = ? AND is_active = 1`
  ).bind(deviceId).all();

  return json({
    device,
    latest_telemetry: latest,
    recent_events: recentEvents.results || [],
    geofences: geofences.results || [],
  });
}

export async function handleGetTrips(deviceId, env) {
  const trips = await env.DB.prepare(
    `SELECT * FROM trips WHERE device_id = ? ORDER BY start_time DESC LIMIT 20`
  ).bind(deviceId).all();
  return json(trips.results || []);
}

export async function handleSetGeofence(body, env) {
  const { device_id, label, anchor_lat, anchor_lon, radius_m } = body;
  if (!device_id || anchor_lat == null || anchor_lon == null) {
    return json({ error: 'device_id, anchor_lat, anchor_lon required' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO geofence_zones (device_id, label, anchor_lat, anchor_lon, radius_m)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    device_id,
    label || 'Custom',
    anchor_lat,
    anchor_lon,
    radius_m ?? Number(env.GEOFENCE_DEFAULT_RADIUS_M ?? 100)
  ).run();

  return json({ status: 'ok' });
}
