/**
 * Crash / motion detection math — mirrors firmware thresholds.
 * Kept server-side for trip scoring and alert validation.
 */

export const CRASH_IMPACT_THRESHOLD = 19.6;   // m/s² (~2.0G)
export const CRASH_ROTATION_THRESHOLD = 2.1;  // rad/s
export const CRASH_FLAT_Z_THRESHOLD = 3.0;    // m/s²
export const MOTION_THRESHOLD = 1.5;          // m/s² (van-lift motion)

export function accelMagnitude(ax, ay, az) {
  return Math.sqrt(ax * ax + ay * ay + az * az);
}

export function gyroMagnitude(gx, gy, gz) {
  return Math.sqrt(gx * gx + gy * gy + gz * gz);
}

/**
 * Exponential Moving Average — same as firmware BLE RSSI filter.
 */
export function ema(previous, sample, alpha = 0.2) {
  return alpha * sample + (1 - alpha) * previous;
}

/**
 * Heuristic trip scoring (fallback until Workers AI scoring is wired).
 * Returns { safety, eco } each 0..100.
 */
export function scoreTrip({ hardBrakes = 0, harshAccels = 0, maxSpeedKmh = 0 }) {
  let safety = 100;
  let eco = 100;

  safety -= hardBrakes * 5;
  safety -= harshAccels * 3;

  if (maxSpeedKmh > 60) {
    safety -= Math.min(20, (maxSpeedKmh - 60) * 0.5);
  }

  if (maxSpeedKmh > 80) eco -= 20;
  if (harshAccels > 3) eco -= 10;
  if (hardBrakes > 3) eco -= 10;

  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  return { safety: clamp(safety), eco: clamp(eco) };
}
