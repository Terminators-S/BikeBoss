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
#ifndef CLOUD_SCHEME
#define CLOUD_SCHEME         "https"
#endif
#ifndef CLOUD_HOST
#define CLOUD_HOST           "bikeboss.creative-studio.blog"
#endif
#define CLOUD_PORT           443
#ifndef USE_SIGNED_TELEMETRY_V2
#define USE_SIGNED_TELEMETRY_V2 0  // enable only after device credential provisioning
#endif
#if USE_SIGNED_TELEMETRY_V2
#define TELEMETRY_PATH       "/api/v2/device/telemetry"
#define HEARTBEAT_PATH       "/api/v2/device/telemetry"
#define TELEMETRY_BATCH_PATH "/api/v2/device/telemetry/batch"
#else
#define TELEMETRY_PATH       "/api/v1/telemetry"
#define HEARTBEAT_PATH       "/api/v1/heartbeat"
#define TELEMETRY_BATCH_PATH "/api/v1/telemetry"
#endif
#define LEGACY_TELEMETRY_PATH "/api/v1/telemetry"
#define CRASH_PATH           "/api/v1/crash"
#define POWERCUT_PATH        "/api/v1/alert/powercut"

// ---------------------------------------------------------------------------
// Cellular — APN for the data SIM (Cellcard Cambodia default shown)
// ---------------------------------------------------------------------------
#define MODEM_APN            "cellcard"
#define MODEM_BAUD           115200

// T-A7670G uses a separate L76K GPS module; A7670G has no internal GNSS.
// If the board revision exposes ESP32 IO22, wire IO22 (L76K TX) -> XIAO D2.
// Otherwise the LilyGO helper must relay GPS instead. The helper wakes GPS.
#define USE_EXTERNAL_L76K_GPS  1
#define GPS_BAUD               9600

// ---------------------------------------------------------------------------
// Install mode: 0 = Universal (ignition cut), 1 = Scooter solenoid override
// ---------------------------------------------------------------------------
#define INSTALL_MODE         0

// Bench bring-up: skip cellular modem init (set 0 when A7670E is connected)
#define BENCH_SKIP_MODEM     0

// ---------------------------------------------------------------------------
// WiFi Uplink (bench testing — XIAO's own WiFi instead of modem 4G)
// 1 = telemetry goes over WiFi (needs no SIM). 0 = modem 4G (production).
// GPS still comes from the A7670G over UART in both modes.
// ---------------------------------------------------------------------------
#ifndef USE_WIFI_UPLINK
#define USE_WIFI_UPLINK      1
#endif
#ifndef ENABLE_CELLULAR_FALLBACK
#define ENABLE_CELLULAR_FALLBACK 1
#endif
#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID            ""
#define WIFI_PASSWORD        ""
#define DEVICE_SIGNING_KEY_HEX ""
#endif
#if __has_include("device_signing_key.generated.h")
#include "device_signing_key.generated.h"
#endif
#ifndef DEVICE_SIGNING_KEY_HEX
#define DEVICE_SIGNING_KEY_HEX ""
#endif
#ifndef WIFI_NETWORK_LABEL
#define WIFI_NETWORK_LABEL    ""
#endif
#ifndef CELLULAR_NETWORK_LABEL
#define CELLULAR_NETWORK_LABEL ""
#endif
#ifndef ENABLE_ARDUINO_OTA
// OTA is authenticated from the provisioned device key and is never exposed
// on unsigned/bootstrap firmware.
#define ENABLE_ARDUINO_OTA (USE_WIFI_UPLINK && USE_SIGNED_TELEMETRY_V2)
#endif

#ifndef ENABLE_GLOBAL_OTA
#define ENABLE_GLOBAL_OTA (USE_SIGNED_TELEMETRY_V2)
#endif
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif
#ifndef FIRMWARE_BUILD
#define FIRMWARE_BUILD 2026081201UL
#endif
#ifndef FIRMWARE_BOARD
#define FIRMWARE_BOARD "seeed_xiao_esp32s3"
#endif

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
#ifndef HEARTBEAT_INTERVAL_MS
#define HEARTBEAT_INTERVAL_MS             30000   // v1 compatibility cadence
#endif
#define HEARTBEAT_ARMED_MOVING_MS          10000
#define HEARTBEAT_ARMED_STATIONARY_MS      30000
#define HEARTBEAT_DISARMED_MOVING_MS       60000
#define HEARTBEAT_DISARMED_STATIONARY_MS  300000
#define HEARTBEAT_INCIDENT_MS               2000
#define HEARTBEAT_EVENT_MIN_GAP_MS           1000
#ifndef HEARTBEAT_MAX_INTERVAL_MS
#define HEARTBEAT_MAX_INTERVAL_MS HEARTBEAT_DISARMED_STATIONARY_MS
#endif
#define GPS_TRANSITION_CONFIRM_MS            5000
#define MOVEMENT_TRANSITION_CONFIRM_MS       5000
#define PENDING_UNLOCK_TIMEOUT  10000    // 10 s ignition window after BLE unlock
#define MODEM_RECOVERY_INTERVAL_MS 5000  // retry a late modem without blocking boot

// ---------------------------------------------------------------------------
// Crash detection thresholds (see PROJECT_CONTEXT.md §5C)
// ---------------------------------------------------------------------------
#define CRASH_IMPACT_THRESHOLD     19.6f   // m/s² (~2.0G)
#define CRASH_ROTATION_THRESHOLD   2.1f    // rad/s
#define CRASH_FLAT_Z_THRESHOLD     3.0f    // m/s²
#define CRASH_STABILIZATION_MS     3000    // settle window before flatness check
#define CRASH_STILLNESS_MS         2000    // down + still must persist before confirm
#define CRASH_CANDIDATE_TIMEOUT_MS 8000    // abandon an unstable/ambiguous candidate
#define CRASH_RECOVERY_MS          5000    // upright + still before re-arming detector
#define CRASH_STILL_GYRO_THRESHOLD 0.35f   // rad/s
#define CRASH_STILL_ACCEL_TOLERANCE 1.5f   // m/s² around 1g

// Keep the installed device still and upright during this boot-time sample.
#define IMU_CALIBRATION_SAMPLES       200  // 1 second at 5 ms/sample
#define IMU_CALIBRATION_SAMPLE_MS       5
#define IMU_CALIBRATION_MAX_STDDEV    0.75f // m/s²; reject a moving calibration

// L76K Doppler speed occasionally emits one noisy non-zero fix while parked.
// Require two consecutive moving fixes; use hysteresis when returning to zero.
#define GPS_SPEED_START_KMH          3.0f
#define GPS_SPEED_STOP_KMH           1.0f
#define GPS_SPEED_CONFIRM_SAMPLES       2

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

// Vehicle voltage is real only when the D0 divider is physically installed.
// Bench builds must report it as unavailable, never as a fabricated voltage.
#ifndef BATTERY_SENSE_ENABLED
#define BATTERY_SENSE_ENABLED    (!USE_WIFI_UPLINK)
#endif

// ---------------------------------------------------------------------------
// Geofence
// ---------------------------------------------------------------------------
#define GEOFENCE_RADIUS_M        100.0f

// ---------------------------------------------------------------------------
// SPIFFS offline buffer
// ---------------------------------------------------------------------------
#define SPIFFS_TELEMETRY_LOG_PATH "/offline_log.jsonl"
#define SPIFFS_TELEMETRY_TMP_PATH "/offline_log.tmp"
#define SPIFFS_EVENT_LOG_PATH     "/offline_events.jsonl"
#define SPIFFS_EVENT_TMP_PATH     "/offline_events.tmp"
#define MAX_SPIFFS_LOG_SIZE       65536   // 64 KB per queue
#define OFFLINE_BATCH_MAX_SAMPLES 8
#define OFFLINE_BATCH_MAX_BYTES   4096
#define OFFLINE_BATCH_MAX_REQUESTS 4
#define OFFLINE_FLUSH_RETRY_MS     5000

#endif // BIKEBOSS_CONFIG_H
