/**
 * =============================================================================
 * BikeBoss Firmware — Per-Device / Per-Build Configuration
 * =============================================================================
 *
 * Edit these values per deployment. Defaults target a dev bench unit.
 * For production units, flash with the unit's unique DEVICE_ID provisioned.
 */

#ifndef BIKEBOSS_CONFIG_H
#define BIKEBOSS_CONFIG_H

// ---------------------------------------------------------------------------
// Device identity (provision per unit at factory)
// ---------------------------------------------------------------------------
#define DEVICE_ID            "BB-00000001"

// ---------------------------------------------------------------------------
// Cloud backend
// ---------------------------------------------------------------------------
#define CLOUD_HOST           "bikeboss-api.workers.dev"
#define CLOUD_PORT           443
#define TELEMETRY_PATH       "/api/v1/telemetry"
#define HEARTBEAT_PATH       "/api/v1/heartbeat"
#define CRASH_PATH           "/api/v1/crash"
#define POWERCUT_PATH        "/api/v1/alert/powercut"

// ---------------------------------------------------------------------------
// Cellular — APN for the data SIM (Cellcard Cambodia default shown)
// ---------------------------------------------------------------------------
#define MODEM_APN            "cellcard"
#define MODEM_BAUD           115200

// ---------------------------------------------------------------------------
// Install mode: 0 = Universal (ignition cut), 1 = Scooter solenoid override
// ---------------------------------------------------------------------------
#define INSTALL_MODE         0

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
#define HEARTBEAT_INTERVAL_MS   30000    // 30 s between cloud heartbeats
#define PENDING_UNLOCK_TIMEOUT  10000    // 10 s ignition window after BLE unlock

// ---------------------------------------------------------------------------
// Crash detection thresholds (see PROJECT_CONTEXT.md §5C)
// ---------------------------------------------------------------------------
#define CRASH_IMPACT_THRESHOLD     19.6f   // m/s² (~2.0G)
#define CRASH_ROTATION_THRESHOLD   2.1f    // rad/s
#define CRASH_FLAT_Z_THRESHOLD     3.0f    // m/s²
#define CRASH_STABILIZATION_MS     3000    // settle window before flatness check

// ---------------------------------------------------------------------------
// BLE proximity unlock (see PROJECT_CONTEXT.md §5A)
// ---------------------------------------------------------------------------
#define BLE_EMA_ALPHA          0.2f
#define BLE_UNLOCK_THRESHOLD   -55       // dBm

// ---------------------------------------------------------------------------
// Battery monitor
// ---------------------------------------------------------------------------
#define BATT_CUTOFF_VOLTAGE      11.0f   // below → main battery snipped
#define VOLTAGE_DIVIDER_RATIO    5.0f    // 10k/4.7k divider on 12V rail

// ---------------------------------------------------------------------------
// Geofence
// ---------------------------------------------------------------------------
#define GEOFENCE_RADIUS_M        100.0f

// ---------------------------------------------------------------------------
// SPIFFS offline buffer
// ---------------------------------------------------------------------------
#define SPIFFS_LOG_PATH          "/offline_log.jsonl"
#define MAX_SPIFFS_LOG_SIZE      65536   // 64 KB

#endif // BIKEBOSS_CONFIG_H
