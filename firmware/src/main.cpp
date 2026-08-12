/**
 * =============================================================================
 * BikeBoss Edge Firmware — Seeed XIAO ESP32-S3
 * =============================================================================
 *
 * Non-blocking, 100 Hz IMU loop with:
 *   - 3-Stage Crash Detection Engine
 *   - AT-command SIMCom A7670G modem driver (4G LTE / HTTP)
 *   - External L76K NMEA GPS receiver
 *   - BLE 5.0 proximity beacon (EMA-filtered RSSI unlock)
 *   - Engine immobilizer relay control (GPIO D1)
 *   - Telemetry heartbeat dispatch to Cloudflare Workers
 *   - SPIFFS offline log buffer on network loss
 *   - LiPo backup power-cut detection
 *
 * Pinout:
 *   D4 (SDA) / D5 (SCL) — I2C  → MPU6050
 *   D6 (RX1) / D7 (TX1) — UART → SIMCom A7670G
 *   D2 (RX2)             — UART ← L76K GPS TX (LilyGO GPIO22)
 *   D1  — GPIO OUT → Relay signal (HIGH = immobilize / cut)
 *   D0  — ADC IN  → 12V battery voltage divider sense
 *   D3  — GPIO OUT → Piezo buzzer (local alarm)
 */

// ============================================================================
//  INCLUDES
// ============================================================================

#include <Arduino.h>
#include <Wire.h>
#include <MPU6050.h>
#include <ArduinoJson.h>
#include <TinyGsmClient.h>
#include <SPIFFS.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <BLEAdvertising.h>
#include <Preferences.h>
#include <time.h>
#include <sys/time.h>
#include <mbedtls/md.h>
#include <memory>

#include "config.h"
#include "global_ota.h"

#if ENABLE_GLOBAL_OTA
#include <Update.h>
#include <mbedtls/sha256.h>
#endif

#if USE_WIFI_UPLINK
#include <WiFi.h>
#include <HTTPClient.h>
#if ENABLE_ARDUINO_OTA
#include <ArduinoOTA.h>
#endif
#include "wifi_manager.h"
#endif

// ============================================================================
//  CONSTANTS & PIN DEFINITIONS
// ============================================================================

// --- Hardware Pins (Seeed XIAO ESP32-S3) ---
#define PIN_RELAY          D1    // Engine immobilizer relay (HIGH = cut)
#define PIN_BUZZER         D3    // Piezo buzzer
#define PIN_BATT_SENSE     D0    // ADC for 12V battery voltage divider
#define PIN_GPS_RX         D2    // L76K external GPS TX -> XIAO RX

// --- I2C ---
#define I2C_SDA             D4
#define I2C_SCL             D5

// --- UART (Modem) ---
#define SERIAL_AT           Serial1  // Hardware UART1 on D6(RX)/D7(TX)
#define SERIAL_GPS          Serial2  // External L76K NMEA receive-only UART
#define GPS_FIX_STALE_MS    10000UL  // tolerate one weak/void NMEA sentence

// --- MPU6050 ---
#define IMU_RATE_HZ         100          // 100 Hz sampling
#define IMU_INTERVAL_MS     (1000 / IMU_RATE_HZ)  // 10 ms

// --- BLE Beacon ---
#define BLE_DEVICE_NAME        "BikeBoss"
#define BLE_SERVICE_UUID       "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_UUID          "beb5483e-36e1-4688-b7f5-ea07361b26a8"

// --- ADC ---
#define ADC_REF_VOLTAGE       3.3f
#define ADC_RESOLUTION        4095.0f

// Timing/geometry/threshold constants come from include/config.h:
//   HEARTBEAT_INTERVAL_MS, PENDING_UNLOCK_TIMEOUT,
//   CRASH_* thresholds, BLE_EMA_ALPHA, BLE_UNLOCK_THRESHOLD,
//   BATT_CUTOFF_VOLTAGE, VOLTAGE_DIVIDER_RATIO, GEOFENCE_RADIUS_M,
//   SPIFFS_*_LOG_PATH, MAX_SPIFFS_LOG_SIZE, DEVICE_ID, CLOUD_*

// ============================================================================
//  ENUMS & STATE MACHINES
// ============================================================================

// --- Vehicle Arm State ---
enum class ArmState : uint8_t {
  DISARMED,       // Owner nearby — relay open, engine can start
  ARMED,          // Relay cut — engine immobilized
  PENDING_UNLOCK, // BLE-unlocked, waiting for ignition turn (10s timeout)
};

// --- Crash Detection Stage ---
enum class CrashStage : uint8_t {
  IDLE,
  IMPACT_DETECTED,   // Stage 1: force spike
  ROTATION_DETECTED, // Stage 2: tumbling
  STABILIZING,       // Stage 3: waiting 3s for flatness
  CONFIRMED,         // Crash confirmed — dispatch & hold
};

// --- Modem Network State ---
enum class NetState : uint8_t {
  OFF,
  POWERING_ON,
  INITIALIZING,
  REGISTERING,
  ONLINE,
  ERROR,
};

// --- Bench modem recovery (non-blocking UART/GNSS handshake) ---
enum class ModemRecoveryStage : uint8_t {
  WAIT_RETRY,
  WAIT_AT,
  WAIT_GNSS_PRIMARY,
  WAIT_GNSS_FALLBACK,
  READY,
};

#if USE_WIFI_UPLINK && ENABLE_CELLULAR_FALLBACK
enum class CellularFallbackStage : uint8_t {
  WAIT_RETRY,
  WAIT_SIM,
  WAIT_REGISTRATION,
  WAIT_CONTEXT,
  WAIT_ATTACH,
  WAIT_ACTIVATE,
  WAIT_ADDRESS,
  ONLINE,
};
#endif

// ============================================================================
//  GLOBAL OBJECTS
// ============================================================================

MPU6050 mpu;

// AT modem stack (TinyGSM)
TinyGsm       modem(SERIAL_AT);
TinyGsmClient client(modem);

// JSON document buffer
StaticJsonDocument<1024> telemetryDoc;

// ============================================================================
//  GLOBAL STATE VARIABLES
// ============================================================================

// --- Timing ---
uint32_t lastImuTick     = 0;
uint32_t lastHeartbeat   = 0;
uint32_t lastBleAdvert   = 0;
uint32_t lastModemRetry  = 0;
uint32_t crashStageEnter = 0;
ArmState lastReportedArmState = ArmState::DISARMED;
bool lastReportedGpsFix = false;
bool lastReportedMoving = false;

// --- IMU ---
float ax = 0.0f, ay = 0.0f, az = 0.0f;  // acceleration (m/s²)
float gx = 0.0f, gy = 0.0f, gz = 0.0f;  // gyroscope (rad/s)
float atotal = 0.0f, gtotal = 0.0f;
bool imuOk = false;
bool imuCalibrated = false;
float accelScaleCorrection = 1.0f;
float uprightGravityX = 0.0f, uprightGravityY = 0.0f, uprightGravityZ = 1.0f;
float uprightGravityProjection = 9.80665f;
float gyroBiasX = 0.0f, gyroBiasY = 0.0f, gyroBiasZ = 0.0f;

// --- Crash Engine ---
CrashStage crashStage = CrashStage::IDLE;
bool crashDispatched = false;
float crashImpactPeak = 0.0f;
float crashRotationPeak = 0.0f;
uint32_t crashStillSince = 0;
uint32_t crashUprightSince = 0;

// --- Arm State ---
ArmState armState = ArmState::DISARMED;
uint32_t pendingUnlockStart = 0;

// --- BLE ---
float rssiSmoothed = -100.0f;
bool bleClientConnected = false;
// A BLE link alone is not proof of owner identity. A future native pairing
// service may set this only after a device-bound credential challenge succeeds.
bool bleOwnerAuthenticated = false;
uint32_t blePresenceUpdatedAt = 0;

// --- Geofence ---
bool  geofenceActive = false;
float geofenceAnchorLat = 0.0f;
float geofenceAnchorLon = 0.0f;

// --- Modem ---
NetState netState = NetState::OFF;
char gpsNmea[256] = {0};
float gpsLat = 0.0f, gpsLon = 0.0f, gpsSpeed = 0.0f, gpsRawSpeed = 0.0f;
bool gpsSpeedMovingConfirmed = false;
uint8_t gpsSpeedCandidateSamples = 0;
bool  gpsFix = false;
bool  gpsSerialReady = false;
uint32_t gpsCharsProcessed = 0;
uint32_t gpsRejectedSentences = 0;
uint32_t gpsRejectedPositions = 0;
uint32_t lastGpsSentence = 0;
uint32_t lastGpsFixAt = 0;
float gpsAccuracyM = 50.0f;
float gpsHdop = 99.9f;
float gpsHeading = 0.0f;
float gpsAltitudeM = 0.0f;
uint8_t gpsSatellites = 0;
bool  modemAtReady = false;
bool  gnssEnabled = false;
bool  modemUartSwapped = false;
uint8_t modemAtTimeouts = 0;
ModemRecoveryStage modemRecoveryStage = ModemRecoveryStage::WAIT_RETRY;
uint32_t modemRecoveryDeadline = 0;
char modemRecoveryLine[96] = {0};
size_t modemRecoveryLineLength = 0;
uint8_t modemPollFailures = 0;
#if USE_WIFI_UPLINK && ENABLE_CELLULAR_FALLBACK
CellularFallbackStage cellularFallbackStage = CellularFallbackStage::WAIT_RETRY;
uint32_t cellularFallbackDeadline = 0;
uint32_t cellularFallbackRetryAt = 0;
uint32_t lastCellularHealthCheck = 0;
char cellularFallbackLine[128] = {0};
size_t cellularFallbackLineLength = 0;
bool cellularSimReady = false;
bool cellularRegistered = false;
bool cellularHasAddress = false;
#endif

// --- Battery ---
float mainBatteryVoltage = NAN;
bool  powerCutAlertSent = false;
bool  battSenseEnabled = BATTERY_SENSE_ENABLED != 0;

// --- Device Identity ---
char deviceId[32] = DEVICE_ID; // From include/config.h — provision per unit
Preferences devicePreferences;
uint64_t telemetrySequence = 0;

struct CommandAck {
  uint32_t id = 0;
  bool applied = false;
};
CommandAck pendingCommandAcks[5];
uint8_t pendingCommandAckCount = 0;

// ============================================================================
//  FORWARD DECLARATIONS
// ============================================================================

// --- IMU ---
void imuInit();
bool imuCalibrate();
void imuSample();
void crashDetectionPipeline();

// --- Modem ---
void modemInit();
void modemLoop();
void modemConfigureUart(bool swapped);
void modemRecoveryLoop();
void modemRecoverySend(const char* command, ModemRecoveryStage nextStage,
                       uint32_t timeoutMs = 1500);
void modemRecoveryHandleLine(const char* line);
void modemRecoveryRetry(const char* reason);
#if USE_WIFI_UPLINK && ENABLE_CELLULAR_FALLBACK
void cellularFallbackLoop();
void cellularFallbackRetry(const char* reason, uint32_t retryMs = 15000UL);
void cellularFallbackSend(const char* command, CellularFallbackStage nextStage,
                          uint32_t timeoutMs = 5000UL);
void cellularFallbackHandleLine(const char* line);
#endif
void modemSendAT(const char* cmd);
bool modemWaitOK(const char* cmd, uint32_t timeoutMs = 2000);
bool modemSendTelemetry(const char* path, const JsonDocument& doc,
                         bool bufferOnFailure = true);
#if ENABLE_GLOBAL_OTA && USE_WIFI_UPLINK && ENABLE_CELLULAR_FALLBACK
bool modemDownloadFirmware(const char* path, const char* authorization,
                           size_t sizeBytes, const char* sha256Hex);
#endif
void gpsInit();
void gpsLoop();
void gpsParseNmea();
void updateGpsSpeed(float rawSpeedKmh);
bool gnssPoll();
bool nmeaChecksumValid(const char* sentence);
bool nmeaCoordinateToDecimal(const char* rawField, char hemisphere,
                             bool latitude, float& decimal);
bool syncUtcFromRmc(const char* timeField, const char* dateField);

// --- WiFi uplink (bench mode) ---
#if USE_WIFI_UPLINK
void wifiInit();
bool wifiSendTelemetry(const char* path, const JsonDocument& doc,
                       bool bufferOnFailure = true);
#endif

// --- BLE ---
void bleInit();
void bleUpdateRssi();

// --- Relay ---
void relayImmobilize();
void relayRelease();
void relayPulseSolenoid();

// --- Telemetry ---
void buildTelemetryPayload(JsonDocument& doc);
bool sendTelemetry(const char* path, const JsonDocument& doc,
                   bool bufferOnFailure = true);
void sendHeartbeat();
void sendCrashAlert();
void telemetryIdentityInit();
bool utcIso8601(char* destination, size_t destinationSize);
void handleTelemetryResponse(const String& response);
void appendCommandAcks(JsonDocument& doc);
void clearCommandAcks();
bool containsCommandAcks(const JsonDocument& doc);
#if USE_SIGNED_TELEMETRY_V2
bool buildSignedRequestHeaders(const char* path, const String& payload,
                               const JsonDocument& doc, String& timestamp,
                               String& sequence, String& signature);
#if USE_WIFI_UPLINK
bool addSignedRequestHeaders(HTTPClient& http, const char* path,
                             const String& payload, const JsonDocument& doc);
#endif
#endif

// --- Persistence ---
void spiffsInit();
bool spiffsLogRequest(const char* path, const String& payload);
bool spiffsFlush();
bool spiffsHasPendingRequests();

// --- Utilities ---
float readBatteryVoltage();
bool isVehicleMoving();
uint32_t currentHeartbeatIntervalMs();
void soundBuzzer(uint32_t durationMs);
void handleBleUnlock();
void handleBleAutoRelock();
void checkPowerCut();
#if USE_WIFI_UPLINK && ENABLE_ARDUINO_OTA
void otaLoop();
bool otaInProgress = false;
#endif

// ============================================================================
//  SETUP
// ============================================================================

void setup() {
  // --- Serial Debug ---
  Serial.begin(115200);
  // XIAO ESP32-S3 uses native USB CDC — the host takes a moment to enumerate,
  // and the serial monitor often attaches AFTER setup() has already printed.
  // Wait briefly so the boot banner (and WiFi status) isn't lost.
  uint32_t usbWait = millis();
  while (!Serial && millis() - usbWait < 3000) { delay(10); }
  delay(500);
  Serial.println(F("\n\n=== BikeBoss Edge Firmware Boot ==="));

  // --- GPIO ---
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, LOW);   // Start with relay released (engine enabled)
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  // Analog read resolution
  analogReadResolution(12);       // 12-bit ADC on ESP32-S3

  // --- I2C ---
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);          // 100 kHz first (breadboard-safe)
  delay(50);

  // --- SPIFFS ---
  spiffsInit();
  telemetryIdentityInit();
#if ENABLE_GLOBAL_OTA && USE_WIFI_UPLINK && ENABLE_CELLULAR_FALLBACK
  globalOtaSetCellularDownloader(modemDownloadFirmware);
#endif
  globalOtaBegin(devicePreferences);

  // --- IMU ---
  imuInit();
  if (imuOk) {
    imuCalibrate();
  }

  // --- External GPS (L76K on the T-A7670G GPS daughterboard) ---
  gpsInit();

  // --- BLE ---
  bleInit();

  // --- Modem / WiFi uplink ---
#if USE_WIFI_UPLINK
  wifiInit();
#else
  modemInit();
#endif

  // --- Ready ---
  Serial.println(F("BikeBoss: Initialization complete."));
  Serial.println(F("  Serial cmds: w=WiFi status/retry+POST  l=list WiFi networks  s=status"));
  Serial.println(F("               t=telemetry dump  g=GPS  n=raw GNSS  m<cmd>=AT passthrough"));
  Serial.println(F("               a=arm  d=disarm  f=flush SPIFFS buffer"));
  soundBuzzer(100); // short beep = booted

  // --- Initialize timers ---
  lastImuTick   = millis();
  // Make the first telemetry heartbeat due immediately after boot. This keeps
  // phone + power-bank field tests independent from the serial console.
  lastHeartbeat = millis() - currentHeartbeatIntervalMs();
  lastReportedArmState = armState;
  lastReportedGpsFix = gpsFix;
  lastReportedMoving = isVehicleMoving();
}

// ============================================================================
//  MAIN LOOP (Non-Blocking)
// ============================================================================

void loop() {
  uint32_t now = millis();

  // ---------------------------------------------------------------
  // 1. 100 Hz IMU Sampling & Crash Detection (highest priority)
  // ---------------------------------------------------------------
  if (now - lastImuTick >= IMU_INTERVAL_MS) {
    lastImuTick = now;
    imuSample();
    crashDetectionPipeline();
  }

  // External GPS streams NMEA independently from the A7670G modem.
  gpsLoop();

  // ---------------------------------------------------------------
  // 2. Modem State Machine (asynchronous cold-boot recovery)
  // ---------------------------------------------------------------
  modemRecoveryLoop();
#if USE_WIFI_UPLINK && ENABLE_CELLULAR_FALLBACK
  cellularFallbackLoop();
#endif
#if !USE_WIFI_UPLINK
  if (modemAtReady) modemLoop();
#endif

#if USE_WIFI_UPLINK
  trustedWifi.loop();
#if ENABLE_ARDUINO_OTA
  otaLoop();
  if (otaInProgress) return;
#endif

#if ENABLE_GLOBAL_OTA
  globalOtaLoop(
    trustedWifi.connected(),
    ENABLE_CELLULAR_FALLBACK && netState == NetState::ONLINE,
    armState == ArmState::DISARMED && !isVehicleMoving() && !globalOtaInProgress(),
    telemetrySequence
  );
  if (globalOtaInProgress()) return;
#endif
#endif

  // A restored uplink should become visible to the owner immediately. Without
  // this edge trigger, a boot that scans for Wi-Fi can miss its first live POST
  // and then wait for the full stationary cadence before trying again.
  static bool uplinkWasAvailable = false;
#if USE_WIFI_UPLINK
  const bool uplinkIsAvailable = trustedWifi.connected()
                              || (ENABLE_CELLULAR_FALLBACK && netState == NetState::ONLINE);
#else
  const bool uplinkIsAvailable = netState == NetState::ONLINE;
#endif
  if (uplinkIsAvailable && !uplinkWasAvailable) {
    lastHeartbeat = now - currentHeartbeatIntervalMs();
    Serial.println(F("[TELEM] Uplink restored; heartbeat due now."));
  }
  uplinkWasAvailable = uplinkIsAvailable;

  // ---------------------------------------------------------------
  // 3. Adaptive heartbeat telemetry + immediate safety-state transitions
  // ---------------------------------------------------------------
  bool transitionDue = false;
#if USE_SIGNED_TELEMETRY_V2
  static bool candidateGpsFix = false;
  static uint32_t candidateGpsFixSince = 0;
  if (gpsFix != candidateGpsFix) {
    candidateGpsFix = gpsFix;
    candidateGpsFixSince = now;
  }
  const bool stableGpsTransition = candidateGpsFix != lastReportedGpsFix
                                && now - candidateGpsFixSince >= GPS_TRANSITION_CONFIRM_MS;
  static bool candidateMoving = false;
  static uint32_t candidateMovingSince = 0;
  const bool movingNow = isVehicleMoving();
  if (movingNow != candidateMoving) {
    candidateMoving = movingNow;
    candidateMovingSince = now;
  }
  const bool stableMovementTransition = candidateMoving != lastReportedMoving
                                     && now - candidateMovingSince
                                        >= MOVEMENT_TRANSITION_CONFIRM_MS;
  const bool reportableStateChanged = armState != lastReportedArmState
                                   || stableGpsTransition
                                   || stableMovementTransition;
  transitionDue = reportableStateChanged
               && now - lastHeartbeat >= HEARTBEAT_EVENT_MIN_GAP_MS;
#endif
  if (transitionDue || now - lastHeartbeat >= currentHeartbeatIntervalMs()) {
    lastHeartbeat = now;
    sendHeartbeat();
  }

  // ---------------------------------------------------------------
  // 4. BLE Unlock / Auto-Relock
  // ---------------------------------------------------------------
  if (armState == ArmState::PENDING_UNLOCK) {
    handleBleAutoRelock();
  }

  // ---------------------------------------------------------------
  // 5. Battery Monitoring
  // ---------------------------------------------------------------
  checkPowerCut();

  // ---------------------------------------------------------------
  // 6. Serial Debug Command Interface (development only)
  // ---------------------------------------------------------------
  if (Serial.available()) {
    char cmd = Serial.read();
    switch (cmd) {
      case 'a': // Arm
        armState = ArmState::ARMED;
        relayImmobilize();
        Serial.println(F("[CMD] Armed."));
        break;
      case 'd': // Disarm
        armState = ArmState::DISARMED;
        relayRelease();
        Serial.println(F("[CMD] Disarmed."));
        break;
      case 'g': // Get GPS (poll modem register, then show parsed values)
        if (USE_EXTERNAL_L76K_GPS) {
          Serial.printf("[CMD] L76K: serial=%d chars=%lu last_sentence=%lu ms ago\n",
                        gpsSerialReady, (unsigned long)gpsCharsProcessed,
                        lastGpsSentence ? (unsigned long)(millis() - lastGpsSentence) : 0UL);
          Serial.printf("[CMD] L76K rejected: checksum/frame=%lu position=%lu\n",
                        (unsigned long)gpsRejectedSentences,
                        (unsigned long)gpsRejectedPositions);
        } else if (modemAtReady && gnssEnabled) {
          bool ok = gnssPoll();
          Serial.printf("[CMD] GNSS poll: %s\n", ok ? "FIX" : "no fix yet");
        } else {
          Serial.println(F("[CMD] Modem/GNSS not ready yet — background recovery is active."));
        }
        Serial.printf("[CMD] GPS: lat=%.6f lon=%.6f fix=%d speed=%.1f km/h\n",
                      gpsLat, gpsLon, gpsFix, gpsSpeed);
        break;
      case 'n': // Query modem GNSS register directly (AT+CGNSSINFO)
        if (USE_EXTERNAL_L76K_GPS) {
          Serial.printf("[CMD] External L76K NMEA: chars=%lu fix=%d\n",
                        (unsigned long)gpsCharsProcessed, gpsFix);
        } else if (modemAtReady) {
          modemSendAT("AT+CGNSSINFO");
          delay(1000);
          while (SERIAL_AT.available()) {
            Serial.println(SERIAL_AT.readStringUntil('\n'));
          }
        } else {
          Serial.println(F("[CMD] Modem not ready yet — background recovery is active."));
        }
        break;
      case 'w': // WiFi status + test POST
#if USE_WIFI_UPLINK
        trustedWifi.printStatus();
        if (trustedWifi.connected()) {
          sendHeartbeat(); // force an immediate test POST
        } else {
          Serial.println(F("[CMD] Not connected — rescanning trusted profiles now..."));
          trustedWifi.reconnectNow();
        }
#else
        Serial.println(F("[CMD] WiFi uplink disabled (USE_WIFI_UPLINK=0)"));
#endif
        break;
      case 's': // Status dump
        Serial.printf("[STATUS] Arm=%d Crash=%d Net=%d VehicleBattery=",
                      (int)armState, (int)crashStage, (int)netState);
        if (battSenseEnabled && isfinite(mainBatteryVoltage)) {
          Serial.printf("%.2fV\n", mainBatteryVoltage);
        } else {
          Serial.println(F("NOT_MEASURED (D0 divider not connected)"));
        }
        Serial.printf("[STATUS] IMU: calibrated=%d atot=%.2f gtot=%.2f az=%.2f\n",
                      imuCalibrated, atotal, gtotal, az);
        Serial.printf("[STATUS] Modem: AT=%d GPS_serial=%d recovery=%d swapped=%d GPS_fix=%d\n",
                      modemAtReady, gnssEnabled, (int)modemRecoveryStage,
                      modemUartSwapped, gpsFix);
        break;
      case 'm': // Modem AT passthrough: type the rest of the line, e.g. "mAT+CGNSSINFO"
        {
          String at = Serial.readStringUntil('\n');
          at.trim();
          if (at.length() == 0) at = "AT";
          SERIAL_AT.println(at);
          Serial.printf("[AT] → %s\n", at.c_str());
          uint32_t t0 = millis();
          while (millis() - t0 < 2000) {
            if (SERIAL_AT.available()) {
              String line = SERIAL_AT.readStringUntil('\n');
              line.trim();
              if (line.length()) Serial.printf("[AT] ← %s\n", line.c_str());
            }
          }
        }
        break;
      case 'l': // Scan + list all visible WiFi networks (is "Hi" even there?)
#if USE_WIFI_UPLINK
        Serial.println(F("[CMD] Asynchronous trusted-network scan requested."));
        trustedWifi.scanNow();
#else
        Serial.println(F("[CMD] WiFi uplink disabled."));
#endif
        break;
      case 't': // One-shot telemetry dump (quiet line, easy to read)
        Serial.printf("[T] atot=%.2f gtot=%.3f | ax=%.2f ay=%.2f az=%.2f | ",
                      atotal, gtotal, ax, ay, az);
        if (battSenseEnabled && isfinite(mainBatteryVoltage)) {
          Serial.printf("vbat=%.2f\n", mainBatteryVoltage);
        } else {
          Serial.println(F("vbat=NOT_MEASURED"));
        }
        break;
      case 'f': // Flush SPIFFS log
        spiffsFlush();
        break;
      default:
        break;
    }
  }
}

// ============================================================================
//  IMU — MPU6050 Initialization & 100 Hz Sampling
// ============================================================================

void imuInit() {
  imuOk = false;
  Serial.printf("IMU: I2C on SDA=D4/GPIO%d SCL=D5/GPIO%d\n", (int)I2C_SDA, (int)I2C_SCL);

  // Scan bus so we can see if anything is connected
  Serial.print(F("IMU: I2C scan:"));
  uint8_t found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf(" 0x%02X", addr);
      found++;
    }
  }
  if (found == 0) {
    Serial.println(F(" (none)"));
  } else {
    Serial.println();
  }

  // Try common MPU6050 addresses: AD0=GND -> 0x68, AD0=VCC -> 0x69
  const uint8_t candidates[] = { 0x68, 0x69 };
  for (uint8_t i = 0; i < 2; i++) {
    uint8_t addr = candidates[i];
    Serial.printf("IMU: Trying MPU6050 @ 0x%02X... ", addr);
    mpu = MPU6050(addr);
    mpu.initialize();
    delay(20);
    if (mpu.testConnection()) {
      // Configure: ±8G accelerometer, ±1000 deg/s gyro
      mpu.setFullScaleAccelRange(MPU6050_ACCEL_FS_8);
      mpu.setFullScaleGyroRange(MPU6050_GYRO_FS_1000);
      mpu.setDLPFMode(MPU6050_DLPF_BW_42);
      Wire.setClock(400000); // raise bus speed after successful detect
      imuOk = true;
      Serial.println(F("OK."));
      return;
    }
    Serial.println(F("no response"));
  }

  Serial.println(F("IMU: FAILED — no MPU6050 found."));
  Serial.println(F("  Wire: VCC->3V3, GND->GND, SDA->D4, SCL->D5"));
  Serial.println(F("  If scan shows nothing: check power/GND/loose breadboard."));
  Serial.println(F("  If scan shows 0x69 only: AD0 is HIGH (still supported above)."));
  soundBuzzer(300);
}

bool imuCalibrate() {
  if (!imuOk) return false;

  imuCalibrated = false;
  accelScaleCorrection = 1.0f;
  uprightGravityX = 0.0f;
  uprightGravityY = 0.0f;
  uprightGravityZ = 1.0f;
  uprightGravityProjection = 9.80665f;
  gyroBiasX = gyroBiasY = gyroBiasZ = 0.0f;

  Serial.printf("IMU: Calibrating (%d samples) — keep the device still and upright... ",
                IMU_CALIBRATION_SAMPLES);
  delay(250); // setup-only settling time; the 100 Hz main loop has not started yet

  const float accelScale = (8.0f * 9.80665f) / 32768.0f;
  const float gyroScale = (1000.0f * PI) / (32768.0f * 180.0f);

  double sumAx = 0.0, sumAy = 0.0, sumAz = 0.0;
  double sumGx = 0.0, sumGy = 0.0, sumGz = 0.0;
  double sumAccelMagnitude = 0.0, sumAccelMagnitudeSquared = 0.0;

  for (uint16_t i = 0; i < IMU_CALIBRATION_SAMPLES; i++) {
    int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;
    mpu.getMotion6(&rawAx, &rawAy, &rawAz, &rawGx, &rawGy, &rawGz);

    const float sampleAx = (float)rawAx * accelScale;
    const float sampleAy = (float)rawAy * accelScale;
    const float sampleAz = (float)rawAz * accelScale;
    const float magnitude = sqrtf(sampleAx * sampleAx
                                + sampleAy * sampleAy
                                + sampleAz * sampleAz);

    sumAx += sampleAx;
    sumAy += sampleAy;
    sumAz += sampleAz;
    sumGx += (float)rawGx * gyroScale;
    sumGy += (float)rawGy * gyroScale;
    sumGz += (float)rawGz * gyroScale;
    sumAccelMagnitude += magnitude;
    sumAccelMagnitudeSquared += (double)magnitude * magnitude;
    delay(IMU_CALIBRATION_SAMPLE_MS);
  }

  const float sampleCount = (float)IMU_CALIBRATION_SAMPLES;
  const float meanAx = (float)(sumAx / sampleCount);
  const float meanAy = (float)(sumAy / sampleCount);
  const float meanAz = (float)(sumAz / sampleCount);
  const float meanMagnitude = (float)(sumAccelMagnitude / sampleCount);
  const float magnitudeVariance = fmaxf(
    0.0f,
    (float)(sumAccelMagnitudeSquared / sampleCount) - meanMagnitude * meanMagnitude
  );
  const float magnitudeStdDev = sqrtf(magnitudeVariance);
  const float normalizedStdDev = magnitudeStdDev * (9.80665f / meanMagnitude);

  // Reject calibration if the device moved or the sensor returned implausible data.
  if (normalizedStdDev > IMU_CALIBRATION_MAX_STDDEV
      || meanMagnitude < 2.0f || meanMagnitude > 50.0f) {
    Serial.printf("REJECTED (mean=%.2f m/s², noise=%.2f m/s²).\n",
                  meanMagnitude, normalizedStdDev);
    Serial.println(F("IMU: Crash detection disabled for this boot. Reboot with the device stationary."));
    return false;
  }

  // One-position calibration cannot distinguish accelerometer bias from the
  // gravity components created by the sensor's mounting angle. Subtracting
  // mean X/Y therefore makes a normal lean look like an impact. Preserve the
  // measured vector, normalize its magnitude to 1g, and learn its direction as
  // the motorcycle's upright reference instead.
  accelScaleCorrection = 9.80665f / meanMagnitude;
  uprightGravityX = meanAx / meanMagnitude;
  uprightGravityY = meanAy / meanMagnitude;
  uprightGravityZ = meanAz / meanMagnitude;
  gyroBiasX = (float)(sumGx / sampleCount);
  gyroBiasY = (float)(sumGy / sampleCount);
  gyroBiasZ = (float)(sumGz / sampleCount);
  imuCalibrated = true;

  imuSample();
  Serial.printf("OK (before=%.2f, after=%.2f m/s², noise=%.2f).\n",
                meanMagnitude, atotal, normalizedStdDev);
  Serial.printf("IMU: accel scale %.4f, upright [%.3f, %.3f, %.3f], gyro bias [%.3f, %.3f, %.3f]\n",
                accelScaleCorrection,
                uprightGravityX, uprightGravityY, uprightGravityZ,
                gyroBiasX, gyroBiasY, gyroBiasZ);
  return true;
}

void imuSample() {
  if (!imuOk) return;
  // Read raw sensor data
  int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;
  mpu.getMotion6(&rawAx, &rawAy, &rawAz, &rawGx, &rawGy, &rawGz);

  // Convert to physical units
  // ±8G range: 4096 LSB/g, 1g = 9.81 m/s²
  const float accelScale = (8.0f * 9.80665f) / 32768.0f;
  ax = (float)rawAx * accelScale * accelScaleCorrection;
  ay = (float)rawAy * accelScale * accelScaleCorrection;
  az = (float)rawAz * accelScale * accelScaleCorrection;

  // ±1000 deg/s range: 32.8 LSB/(deg/s) → rad/s = deg/s * π/180
  const float gyroScale  = (1000.0f * PI) / (32768.0f * 180.0f);
  gx = (float)rawGx * gyroScale - gyroBiasX;
  gy = (float)rawGy * gyroScale - gyroBiasY;
  gz = (float)rawGz * gyroScale - gyroBiasZ;

  // Compute magnitude vectors
  atotal = sqrtf(ax * ax + ay * ay + az * az);
  gtotal = sqrtf(gx * gx + gy * gy + gz * gz);
  uprightGravityProjection = ax * uprightGravityX
                           + ay * uprightGravityY
                           + az * uprightGravityZ;
}

// ============================================================================
//  3-STAGE CRASH DETECTION ENGINE
// ============================================================================

void crashDetectionPipeline() {
  // Never make a safety decision from uncalibrated or invalid IMU data.
  if (!imuOk || !imuCalibrated) return;

  uint32_t now = millis();
  static uint32_t lastStage1Log = 0;   // rate-limit bench false-alarm spam

  switch (crashStage) {

    // --- IDLE: waiting for impact ---
    case CrashStage::IDLE:
      if (atotal > CRASH_IMPACT_THRESHOLD) {
        crashStage = CrashStage::IMPACT_DETECTED;
        crashStageEnter = now;
        crashImpactPeak = atotal;
        crashRotationPeak = gtotal;
        crashStillSince = 0;
        crashUprightSince = 0;
        if (now - lastStage1Log >= 5000) {
          lastStage1Log = now;
          Serial.printf("[CRASH] Stage 1: Impact! Atotal=%.2f m/s² (ax=%.2f ay=%.2f az=%.2f)\n",
                        atotal, ax, ay, az);
        }
      }
      break;

    // --- STAGE 1: Impact detected → check rotation ---
    case CrashStage::IMPACT_DETECTED:
      crashImpactPeak = fmaxf(crashImpactPeak, atotal);
      crashRotationPeak = fmaxf(crashRotationPeak, gtotal);
      if (gtotal > CRASH_ROTATION_THRESHOLD) {
        crashStage = CrashStage::ROTATION_DETECTED;
        crashStageEnter = now;
        Serial.printf("[CRASH] Stage 2: Rotation! Gtotal=%.2f rad/s\n", gtotal);
      }
      // Timeout: if no rotation within 500ms, false alarm (pothole)
      else if (now - crashStageEnter > 500) {
        crashStage = CrashStage::IDLE;
        // (log suppressed — bench IMU noise otherwise floods the console)
      }
      break;

    // --- STAGE 2: Rotation detected → wait for stabilization ---
    case CrashStage::ROTATION_DETECTED:
      crashStage = CrashStage::STABILIZING;
      crashStageEnter = now;
      crashStillSince = 0;
      Serial.println(F("[CRASH] Stage 3: Waiting for stabilization..."));
      break;

    // --- STAGE 3: require a sustained down-and-still posture ---
    case CrashStage::STABILIZING:
      crashImpactPeak = fmaxf(crashImpactPeak, atotal);
      crashRotationPeak = fmaxf(crashRotationPeak, gtotal);
      {
        const bool down = fabsf(uprightGravityProjection) < CRASH_FLAT_Z_THRESHOLD;
        const bool still = fabsf(atotal - 9.80665f) <= CRASH_STILL_ACCEL_TOLERANCE
                        && gtotal <= CRASH_STILL_GYRO_THRESHOLD;
        if (down && still) {
          if (crashStillSince == 0) crashStillSince = now;
        } else {
          crashStillSince = 0;
        }

        const bool minimumSettleElapsed = now - crashStageEnter >= CRASH_STABILIZATION_MS;
        const bool continuouslyStill = crashStillSince != 0
                                    && now - crashStillSince >= CRASH_STILLNESS_MS;
        if (minimumSettleElapsed && continuouslyStill) {
          crashStage = CrashStage::CONFIRMED;
          crashStageEnter = now;
          crashUprightSince = 0;
          Serial.printf("[CRASH] CONFIRMED! impact=%.2f rotation=%.2f uprightProjection=%.2f m/s².\n",
                        crashImpactPeak, crashRotationPeak, uprightGravityProjection);
          sendCrashAlert();
          soundBuzzer(5000); // 5-second local alarm
          crashDispatched = true;
        } else if (now - crashStageEnter >= CRASH_CANDIDATE_TIMEOUT_MS) {
          crashStage = CrashStage::IDLE;
          crashStillSince = 0;
          Serial.printf("[CRASH] Candidate expired — down=%d still=%d projection=%.2f.\n",
                        down, still, uprightGravityProjection);
        }
      }
      break;

    // --- CONFIRMED: alert once, then re-arm only after sustained recovery ---
    case CrashStage::CONFIRMED:
      {
        const bool upright = uprightGravityProjection > CRASH_FLAT_Z_THRESHOLD;
        const bool still = fabsf(atotal - 9.80665f) <= CRASH_STILL_ACCEL_TOLERANCE
                        && gtotal <= CRASH_STILL_GYRO_THRESHOLD;
        if (upright && still) {
          if (crashUprightSince == 0) crashUprightSince = now;
          if (now - crashUprightSince >= CRASH_RECOVERY_MS) {
            crashStage = CrashStage::IDLE;
            crashDispatched = false;
            crashImpactPeak = 0.0f;
            crashRotationPeak = 0.0f;
            crashStillSince = 0;
            crashUprightSince = 0;
            Serial.println(F("[CRASH] Upright recovery confirmed — detector re-armed."));
          }
        } else {
          crashUprightSince = 0;
        }
      }
      break;
  }
}

// ============================================================================
//  BLE — Beacon Advertisement & Proximity Unlock
// ============================================================================

// BLE Server callbacks
class BikeBossBLECallback : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) override {
    std::string value = pCharacteristic->getValue();
    if (!value.empty()) {
      blePresenceUpdatedAt = millis();
      Serial.printf("[BLE] Write received: %s\n", value.c_str());
      // Parse RSSI update from Telegram Mini App
      int rssi = atoi(value.c_str());
      if (rssi < 0 && rssi > -100) {
        // EMA filter
        rssiSmoothed = (BLE_EMA_ALPHA * (float)rssi)
                     + ((1.0f - BLE_EMA_ALPHA) * rssiSmoothed);
        Serial.printf("[BLE] RSSI: raw=%d smoothed=%.1f dBm\n", rssi, rssiSmoothed);
        handleBleUnlock();
      }
    }
  }
};

class BikeBossServerCallback : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    bleClientConnected = true;
    bleOwnerAuthenticated = false;
    blePresenceUpdatedAt = millis();
    Serial.println(F("[BLE] Client connected."));
  }
  void onDisconnect(BLEServer* pServer) override {
    bleClientConnected = false;
    bleOwnerAuthenticated = false;
    blePresenceUpdatedAt = millis();
    Serial.println(F("[BLE] Client disconnected."));
    // Re-start advertising
    BLEDevice::startAdvertising();
  }
};

void bleInit() {
  Serial.print(F("BLE: Initializing... "));
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEServer* pServer = BLEDevice::createServer();
  pServer->setCallbacks(new BikeBossServerCallback());

  BLEService* pService = pServer->createService(BLE_SERVICE_UUID);
  BLECharacteristic* pCharacteristic = pService->createCharacteristic(
    BLE_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ |
    BLECharacteristic::PROPERTY_WRITE |
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pCharacteristic->setCallbacks(new BikeBossBLECallback());
  pCharacteristic->setValue("0"); // initial RSSI placeholder
  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(BLE_SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06); // aggressive advertising
  pAdvertising->setMinInterval(0x20);  // 32 * 0.625ms = 20ms
  pAdvertising->setMaxInterval(0x40);  // 64 * 0.625ms = 40ms
  BLEDevice::startAdvertising();

  Serial.println(F("OK. Advertising as 'BikeBoss'."));
}

void handleBleUnlock() {
  // Unlock if RSSI is strong enough AND bike is armed
  if (rssiSmoothed >= BLE_UNLOCK_THRESHOLD && armState == ArmState::ARMED) {
    armState = ArmState::PENDING_UNLOCK;
    pendingUnlockStart = millis();
    relayRelease(); // Allow engine start
    Serial.printf("[BLE] Proximity unlock! RSSI=%.1f dBm\n", rssiSmoothed);
    soundBuzzer(50); // short chirp
  }
}

void handleBleAutoRelock() {
  // If ignition not turned within the timeout, re-lock
  if (millis() - pendingUnlockStart >= PENDING_UNLOCK_TIMEOUT) {
    armState = ArmState::ARMED;
    relayImmobilize();
    Serial.println(F("[BLE] Auto-relock: ignition timeout."));
    soundBuzzer(200);
  }
}

// ============================================================================
//  RELAY CONTROL — Engine Immobilizer
// ============================================================================

void relayImmobilize() {
  digitalWrite(PIN_RELAY, HIGH); // HIGH = relay energized = circuit CUT
  Serial.println(F("[RELAY] Immobilized (circuit open)."));
}

void relayRelease() {
  digitalWrite(PIN_RELAY, LOW);  // LOW = relay de-energized = circuit CLOSED
  Serial.println(F("[RELAY] Released (circuit closed)."));
}

void relayPulseSolenoid() {
  // Pulse for keyless scooter solenoid override (Modern Scooter Mode)
  // 12V injected for 500ms to allow rotary dial turn
  digitalWrite(PIN_RELAY, HIGH);
  delay(500);
  digitalWrite(PIN_RELAY, LOW);
  Serial.println(F("[RELAY] Solenoid pulse 500ms."));
}

// ============================================================================
//  MODEM — SIMCom A7670G AT Driver (TinyGSM + Custom AT)
// ============================================================================

void modemConfigureUart(bool swapped) {
  SERIAL_AT.end();
  modemUartSwapped = swapped;
  if (swapped) {
    // Same physical wires, opposite logical roles for board revisions whose
    // GPIO26/GPIO27 modem nets are labelled from the other endpoint's view.
    SERIAL_AT.begin(MODEM_BAUD, SERIAL_8N1, D7, D6);
  } else {
    SERIAL_AT.begin(MODEM_BAUD, SERIAL_8N1, D6, D7);
  }
  SERIAL_AT.setTimeout(100);
  Serial.printf("Modem: UART orientation %s (RX=%s, TX=%s).\n",
                swapped ? "SWAPPED" : "NORMAL",
                swapped ? "D7/GPIO44" : "D6/GPIO43",
                swapped ? "D6/GPIO43" : "D7/GPIO44");
}

void modemInit() {
  Serial.print(F("Modem: Powering on SIMCom A7670G... "));
  netState = NetState::POWERING_ON;

  // LilyGO T-A7670G auto-powers the modem when its own USB is connected;
  // PWRKEY is internal to the board (GPIO4) — nothing to pulse from the XIAO.
  // The bench path can open UART immediately and recover in the background.
  // Production keeps a short startup wait before TinyGSM initialization.
#if USE_WIFI_UPLINK
  delay(100);
#else
  delay(3000);
#endif

  // Initialize serial
  // LilyGO labels are from its onboard ESP32's view:
  //   GPIO27 = controller RX / A7670G TX → XIAO D6 (RX1)
  //   GPIO26 = controller TX / A7670G RX ← XIAO D7 (TX1)
  // begin(baud, config, RX_pin, TX_pin) — RX first, TX second.
  modemConfigureUart(false);
  Serial.println();
  Serial.printf("Modem: UART1 up. Recommended wiring RX=D6(GPIO%d)<-LilyGO GPIO27, TX=D7(GPIO%d)->LilyGO GPIO26\n",
                (int)D6, (int)D7);

#if USE_WIFI_UPLINK
  // The LilyGO often finishes booting after the XIAO. Do not stall setup or
  // permanently give up: the main loop performs a non-blocking AT/GNSS retry.
  modemAtReady = false;
  gnssEnabled = false;
  netState = NetState::INITIALIZING;
  modemRecoveryStage = ModemRecoveryStage::WAIT_RETRY;
  lastModemRetry = 0;
  modemRecoveryLineLength = 0;
  Serial.println(F("Modem: Background AT/GNSS recovery armed (retry every 5s)."));
  return;
#else

  // Wait for modem AT response.
  // The A7670G takes 5-10s after USB power before its UART comes alive —
  // modemInit runs right after WiFi setup, so the modem may still be booting.
  netState = NetState::INITIALIZING;
  Serial.print(F("Modem: AT handshake (waiting for modem boot)... "));
  bool atOk = false;
  for (int i = 0; i < 40; i++) {  // up to ~60s — modem boot is slow
    if (modemWaitOK("AT", 1000)) { atOk = true; break; }
    delay(500);
    if (i % 8 == 7) Serial.print(F("\n  still waiting... "));
  }
  if (!atOk) {
    Serial.println(F("FAILED. No AT response from LilyGO A7670G."));
    Serial.println(F("  Wiring: LilyGO GPIO27(modem TX) -> XIAO D6(RX), GPIO26(modem RX) -> XIAO D7(TX), GND-GND"));
    Serial.println(F("  Power: LilyGO needs its OWN USB plugged in (board auto-powers)."));
    Serial.println(F("  Tip: swap TX/RX once — silkscreen labels can be from the modem's view."));
    netState = NetState::ERROR;
    modemAtReady = false;
    modemRecoveryStage = ModemRecoveryStage::WAIT_RETRY;
    return;
  }
  modemAtReady = true;
  Serial.println(F("OK."));

#if USE_WIFI_UPLINK
  // WiFi carries cloud traffic — skip TinyGSM GPRS (no SIM on bench).
  // GNSS is still enabled below and polled over UART.
  Serial.println(F("Modem: WiFi uplink mode — skipping GPRS init."));
#else
  // Initialize TinyGSM
  Serial.print(F("Modem: Initializing TinyGSM... "));
  if (!modem.init()) {
    Serial.println(F("FAILED. Check modem power & wiring."));
    netState = NetState::ERROR;
    return;
  }
  Serial.println(F("OK."));
#endif

  // Wait for network registration (non-fatal: GNSS works without a SIM)
  if (!USE_WIFI_UPLINK) {
    netState = NetState::REGISTERING;
    Serial.print(F("Modem: Registering on network... "));
    if (!modem.waitForNetwork(15000L)) {
      Serial.println(F("FAILED. No network/SIM — GPS-only mode."));
      netState = NetState::ERROR;   // telemetry will buffer to SPIFFS
    } else {
      Serial.println(F("OK. Online."));
      netState = NetState::ONLINE;
    }
  }

  // A7670G has no internal GNSS. GPS-equipped T-A7670G boards use a
  // separate L76K UART handled by gpsLoop().
#if USE_EXTERNAL_L76K_GPS
  gnssEnabled = gpsSerialReady;
  Serial.println(F("Modem: Internal GNSS skipped; using external L76K."));
#else
  Serial.print(F("Modem: Enabling GNSS... "));
  if (modemWaitOK("AT+CGNSSPWR=1", 5000)) {
    gnssEnabled = true;
    Serial.println(F("OK."));
  } else {
    // A7670 variant fallback command set
    gnssEnabled = modemWaitOK("AT+CGPS=1", 5000);
    Serial.println(gnssEnabled ? F("OK (fallback cmd).") : F("FAILED."));
  }
#endif

  if (netState != NetState::ERROR) {
    netState = NetState::ONLINE;
  }
  modemRecoveryStage = ModemRecoveryStage::READY;
  Serial.println(F("Modem: Ready."));
#endif
}

void modemRecoverySend(const char* command, ModemRecoveryStage nextStage,
                       uint32_t timeoutMs) {
  modemRecoveryLineLength = 0;
  modemRecoveryLine[0] = '\0';
  SERIAL_AT.print(command);
  SERIAL_AT.print("\r\n");
  Serial.printf("[MODEM-RECOVERY] → %s\n", command);
  modemRecoveryStage = nextStage;
  modemRecoveryDeadline = millis() + timeoutMs;
}

void modemRecoveryRetry(const char* reason) {
  Serial.printf("[MODEM-RECOVERY] %s; retrying in %lu ms.\n",
                reason, (unsigned long)MODEM_RECOVERY_INTERVAL_MS);
  modemAtReady = false;
#if USE_EXTERNAL_L76K_GPS
  gnssEnabled = gpsSerialReady;
#else
  gnssEnabled = false;
  gpsFix = false;
#endif
  netState = NetState::ERROR;
  modemRecoveryStage = ModemRecoveryStage::WAIT_RETRY;
  modemRecoveryLineLength = 0;
  modemRecoveryLine[0] = '\0';
  lastModemRetry = millis();
}

void modemRecoveryHandleLine(const char* line) {
  if (line[0] == '\0') return;
  Serial.printf("[MODEM-RECOVERY] ← %s\n", line);

  const bool ok = strcmp(line, "OK") == 0;
  const bool error = strncmp(line, "ERROR", 5) == 0
                  || strncmp(line, "+CME ERROR", 10) == 0;

  if (modemRecoveryStage == ModemRecoveryStage::WAIT_AT) {
    if (ok) {
      modemAtTimeouts = 0;
      modemAtReady = true;
      Serial.println(F("[MODEM-RECOVERY] UART handshake recovered."));
#if USE_EXTERNAL_L76K_GPS
      gnssEnabled = gpsSerialReady;
      modemRecoveryStage = ModemRecoveryStage::READY;
#if USE_WIFI_UPLINK
      netState = NetState::ERROR; // AT-ready is not proof of cellular data service.
#if ENABLE_CELLULAR_FALLBACK
      cellularFallbackStage = CellularFallbackStage::WAIT_RETRY;
      cellularFallbackRetryAt = 0;
#endif
#else
      netState = NetState::ERROR; // UART is ready; cellular registration is separate
#endif
      Serial.println(F("[MODEM-RECOVERY] A7670G ready; GPS source is external L76K."));
#else
      modemRecoverySend("AT+CGNSSPWR=1",
                        ModemRecoveryStage::WAIT_GNSS_PRIMARY, 5000);
#endif
    } else if (error) {
      modemRecoveryRetry("AT command rejected");
    }
    return;
  }

  if (modemRecoveryStage == ModemRecoveryStage::WAIT_GNSS_PRIMARY) {
    if (ok) {
      gnssEnabled = true;
      modemRecoveryStage = ModemRecoveryStage::READY;
#if USE_WIFI_UPLINK
      netState = NetState::ERROR;
#else
      netState = NetState::ERROR; // GNSS is ready; cellular registration is separate
#endif
      Serial.println(F("[MODEM-RECOVERY] GNSS enabled. Modem ready."));
    } else if (error) {
      modemRecoverySend("AT+CGPS=1",
                        ModemRecoveryStage::WAIT_GNSS_FALLBACK, 5000);
    }
    return;
  }

  if (modemRecoveryStage == ModemRecoveryStage::WAIT_GNSS_FALLBACK) {
    if (ok) {
      gnssEnabled = true;
      modemRecoveryStage = ModemRecoveryStage::READY;
#if USE_WIFI_UPLINK
      netState = NetState::ERROR;
#else
      netState = NetState::ERROR;
#endif
      Serial.println(F("[MODEM-RECOVERY] GNSS enabled with fallback command. Modem ready."));
    } else if (error) {
      modemRecoveryRetry("GNSS enable rejected");
    }
  }
}

void modemRecoveryLoop() {
  if (BENCH_SKIP_MODEM || modemRecoveryStage == ModemRecoveryStage::READY) return;

  const uint32_t now = millis();
  if (modemRecoveryStage == ModemRecoveryStage::WAIT_RETRY) {
    if (now - lastModemRetry < MODEM_RECOVERY_INTERVAL_MS) return;

    // Discard stale boot chatter before beginning a framed AT exchange.
    while (SERIAL_AT.available()) SERIAL_AT.read();
    modemRecoverySend("AT", ModemRecoveryStage::WAIT_AT, 1500);
    lastModemRetry = now;
    return;
  }

  // Consume complete CR/LF-delimited response lines without waiting for UART.
  while (SERIAL_AT.available()) {
    const char c = (char)SERIAL_AT.read();
    if (c == '\r' || c == '\n') {
      if (modemRecoveryLineLength > 0) {
        modemRecoveryLine[modemRecoveryLineLength] = '\0';
        modemRecoveryHandleLine(modemRecoveryLine);
        modemRecoveryLineLength = 0;
        modemRecoveryLine[0] = '\0';
      }
    } else if (modemRecoveryLineLength < sizeof(modemRecoveryLine) - 1) {
      modemRecoveryLine[modemRecoveryLineLength++] = c;
    }
  }

  if ((int32_t)(now - modemRecoveryDeadline) < 0) return;

  if (modemRecoveryStage == ModemRecoveryStage::WAIT_GNSS_PRIMARY) {
    Serial.println(F("[MODEM-RECOVERY] Primary GNSS command timed out; trying fallback."));
    modemRecoverySend("AT+CGPS=1", ModemRecoveryStage::WAIT_GNSS_FALLBACK, 5000);
  } else if (modemRecoveryStage == ModemRecoveryStage::WAIT_GNSS_FALLBACK) {
    modemRecoveryRetry("GNSS enable timed out");
  } else if (modemRecoveryStage == ModemRecoveryStage::WAIT_AT) {
    modemAtTimeouts++;
    if (modemAtTimeouts >= 3) {
      modemAtTimeouts = 0;
      modemConfigureUart(!modemUartSwapped);
      modemRecoveryRetry("No AT response; UART orientation switched");
    } else {
      modemRecoveryRetry("No AT response");
    }
  }
}

void modemLoop() {
#if !USE_EXTERNAL_L76K_GPS
  // GNSS NMEA arrives whenever GNSS is powered — no SIM/registration needed.
  if (netState == NetState::ONLINE || netState == NetState::ERROR) {
    // Parse any incoming GNSS NMEA sentences
    while (SERIAL_AT.available()) {
      String line = SERIAL_AT.readStringUntil('\n');
      if (line.startsWith("$GNRMC") || line.startsWith("$GPRMC") || line.startsWith("$GNGGA")) {
        line.toCharArray(gpsNmea, sizeof(gpsNmea));
        gpsParseNmea();
      }
    }
  }
#endif
}

#if USE_WIFI_UPLINK && ENABLE_CELLULAR_FALLBACK
void cellularFallbackSend(const char* command, CellularFallbackStage nextStage,
                          uint32_t timeoutMs) {
  cellularFallbackLineLength = 0;
  cellularFallbackLine[0] = '\0';
  cellularSimReady = false;
  cellularRegistered = false;
  cellularHasAddress = false;
  SERIAL_AT.print(command);
  SERIAL_AT.print("\r\n");
  Serial.printf("[CELLULAR] -> %s\n", command);
  cellularFallbackStage = nextStage;
  cellularFallbackDeadline = millis() + timeoutMs;
}

void cellularFallbackRetry(const char* reason, uint32_t retryMs) {
  Serial.printf("[CELLULAR] %s; retrying in %lu ms.\n",
                reason, static_cast<unsigned long>(retryMs));
  netState = NetState::ERROR;
  cellularFallbackStage = CellularFallbackStage::WAIT_RETRY;
  cellularFallbackRetryAt = millis() + retryMs;
  cellularFallbackLineLength = 0;
}

void cellularFallbackHandleLine(const char* line) {
  if (!line || line[0] == '\0') return;
  Serial.printf("[CELLULAR] <- %s\n", line);
  if (strstr(line, "+CPIN:") && strstr(line, "READY")) cellularSimReady = true;
  if (strncmp(line, "+CEREG:", 7) == 0) {
    int first = -1;
    int second = -1;
    const int parsed = sscanf(line + 7, " %d,%d", &first, &second);
    const int status = parsed == 2 ? second : first;
    cellularRegistered = status == 1 || status == 5;
  }
  if (strncmp(line, "+CGPADDR:", 9) == 0) {
    const char* comma = strchr(line, ',');
    cellularHasAddress = comma && strlen(comma + 1) >= 7
                      && strcmp(comma + 1, "0.0.0.0") != 0;
  }
  if (strncmp(line, "ERROR", 5) == 0 || strncmp(line, "+CME ERROR", 10) == 0) {
    cellularFallbackRetry("modem rejected data setup");
    return;
  }
  if (strcmp(line, "OK") != 0) return;

  switch (cellularFallbackStage) {
    case CellularFallbackStage::WAIT_SIM:
      if (cellularSimReady) {
        cellularFallbackSend("AT+CEREG?", CellularFallbackStage::WAIT_REGISTRATION);
      } else {
        cellularFallbackRetry("SIM is absent or locked", 30000UL);
      }
      break;
    case CellularFallbackStage::WAIT_REGISTRATION:
      if (cellularRegistered) {
        const String command = String("AT+CGDCONT=1,\"IP\",\"") + MODEM_APN + "\"";
        cellularFallbackSend(command.c_str(), CellularFallbackStage::WAIT_CONTEXT);
      } else {
        cellularFallbackRetry("not registered on a mobile network");
      }
      break;
    case CellularFallbackStage::WAIT_CONTEXT:
      cellularFallbackSend("AT+CGATT=1", CellularFallbackStage::WAIT_ATTACH, 10000UL);
      break;
    case CellularFallbackStage::WAIT_ATTACH:
      cellularFallbackSend("AT+CGACT=1,1", CellularFallbackStage::WAIT_ACTIVATE, 15000UL);
      break;
    case CellularFallbackStage::WAIT_ACTIVATE:
      cellularFallbackSend("AT+CGPADDR=1", CellularFallbackStage::WAIT_ADDRESS);
      break;
    case CellularFallbackStage::WAIT_ADDRESS:
      if (cellularHasAddress) {
        cellularFallbackStage = CellularFallbackStage::ONLINE;
        netState = NetState::ONLINE;
        lastCellularHealthCheck = millis();
        Serial.println(F("[CELLULAR] A7670G 4G fallback is online."));
      } else {
        cellularFallbackRetry("PDP context has no IP address");
      }
      break;
    default:
      break;
  }
}

void cellularFallbackLoop() {
  if (!modemAtReady || modemRecoveryStage != ModemRecoveryStage::READY) return;
  const uint32_t now = millis();
  if (cellularFallbackStage == CellularFallbackStage::WAIT_RETRY) {
    if (static_cast<int32_t>(now - cellularFallbackRetryAt) < 0) return;
    while (SERIAL_AT.available()) SERIAL_AT.read();
    cellularFallbackSend("AT+CPIN?", CellularFallbackStage::WAIT_SIM);
    return;
  }
  if (cellularFallbackStage == CellularFallbackStage::ONLINE) {
    if (now - lastCellularHealthCheck >= 300000UL) {
      cellularFallbackSend("AT+CEREG?", CellularFallbackStage::WAIT_REGISTRATION);
      lastCellularHealthCheck = now;
    }
    return;
  }
  while (SERIAL_AT.available()) {
    const char character = static_cast<char>(SERIAL_AT.read());
    if (character == '\r' || character == '\n') {
      if (cellularFallbackLineLength > 0) {
        cellularFallbackLine[cellularFallbackLineLength] = '\0';
        cellularFallbackHandleLine(cellularFallbackLine);
        cellularFallbackLineLength = 0;
      }
    } else if (cellularFallbackLineLength < sizeof(cellularFallbackLine) - 1) {
      cellularFallbackLine[cellularFallbackLineLength++] = character;
    }
  }
  if (cellularFallbackStage != CellularFallbackStage::WAIT_RETRY
      && cellularFallbackStage != CellularFallbackStage::ONLINE
      && static_cast<int32_t>(now - cellularFallbackDeadline) >= 0) {
    cellularFallbackRetry("data setup timed out");
  }
}
#endif

void modemSendAT(const char* cmd) {
  SERIAL_AT.println(cmd);
  Serial.printf("[AT] → %s\n", cmd);
}

bool modemWaitOK(const char* cmd, uint32_t timeoutMs) {
  modemSendAT(cmd);
  uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    if (SERIAL_AT.available()) {
      String line = SERIAL_AT.readStringUntil('\n');
      line.trim();
      if (line.length() > 0) {
        Serial.printf("[AT] ← %s\n", line.c_str());
      }
      if (line == "OK") return true;
      if (line.startsWith("ERROR")) return false;
    }
    delay(10);
  }
  return false;
}

void gpsInit() {
#if USE_EXTERNAL_L76K_GPS
  Serial.printf("GPS: External L76K NMEA on RX=D2/GPIO%d at %d baud... ",
                (int)PIN_GPS_RX, GPS_BAUD);
  SERIAL_GPS.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, -1);
  SERIAL_GPS.setTimeout(20);
  gpsSerialReady = true;
  gnssEnabled = true;
  Serial.println(F("READY (wire LilyGO GPIO22 -> XIAO D2)."));
#else
  gpsSerialReady = false;
#endif
}

void gpsLoop() {
#if USE_EXTERNAL_L76K_GPS
  static size_t sentenceLength = 0;

  while (SERIAL_GPS.available()) {
    const char c = (char)SERIAL_GPS.read();
    gpsCharsProcessed++;

    if (c == '\r') continue;
    if (c == '\n') {
      if (sentenceLength > 0) {
        gpsNmea[sentenceLength] = '\0';
        if (strncmp(gpsNmea, "$GNRMC", 6) == 0
            || strncmp(gpsNmea, "$GPRMC", 6) == 0
            || strncmp(gpsNmea, "$GNGGA", 6) == 0
            || strncmp(gpsNmea, "$GPGGA", 6) == 0) {
          gpsParseNmea();
        }
      }
      sentenceLength = 0;
      continue;
    }

    if (sentenceLength < sizeof(gpsNmea) - 1) {
      gpsNmea[sentenceLength++] = c;
    } else {
      sentenceLength = 0; // discard an overlong/corrupt sentence
    }
  }

  // RMC and GGA are independent measurements. A receiver can emit one void
  // sentence between valid fixes, especially during a cold start. Keep the
  // last valid fix briefly and declare it lost only when valid position data
  // has actually gone stale.
  if (gpsFix && lastGpsFixAt != 0 && millis() - lastGpsFixAt > GPS_FIX_STALE_MS) {
    gpsFix = false;
    gpsRawSpeed = 0.0f;
    gpsSpeed = 0.0f;
    gpsSpeedMovingConfirmed = false;
    gpsSpeedCandidateSamples = 0;
    Serial.println(F("[GPS] Fix lost (valid position stale)."));
  }
#endif
}

void updateGpsSpeed(float rawSpeedKmh) {
  gpsRawSpeed = isfinite(rawSpeedKmh) ? fmaxf(0.0f, rawSpeedKmh) : 0.0f;

  if (!gpsSpeedMovingConfirmed) {
    if (gpsRawSpeed >= GPS_SPEED_START_KMH) {
      gpsSpeedCandidateSamples = min(
        (int)gpsSpeedCandidateSamples + 1,
        (int)GPS_SPEED_CONFIRM_SAMPLES
      );
      if (gpsSpeedCandidateSamples >= GPS_SPEED_CONFIRM_SAMPLES) {
        gpsSpeedMovingConfirmed = true;
        gpsSpeed = gpsRawSpeed;
        gpsSpeedCandidateSamples = 0;
      } else {
        // A single non-zero RMC value is common while the L76K is stationary.
        gpsSpeed = 0.0f;
      }
    } else {
      gpsSpeedCandidateSamples = 0;
      gpsSpeed = 0.0f;
    }
    return;
  }

  if (gpsRawSpeed <= GPS_SPEED_STOP_KMH) {
    gpsSpeedCandidateSamples = min(
      (int)gpsSpeedCandidateSamples + 1,
      (int)GPS_SPEED_CONFIRM_SAMPLES
    );
    gpsSpeed = 0.0f;
    if (gpsSpeedCandidateSamples >= GPS_SPEED_CONFIRM_SAMPLES) {
      gpsSpeedMovingConfirmed = false;
    }
  } else {
    gpsSpeedCandidateSamples = 0;
    gpsSpeed = gpsRawSpeed;
  }
}

void gpsParseNmea() {
  // RMC supplies position/speed/heading. GGA supplies satellites, HDOP and
  // altitude. Never trust a coordinate from a damaged UART frame: field data
  // showed single corrupt sentences producing continent-scale jumps.
  if (!nmeaChecksumValid(gpsNmea)) {
    gpsRejectedSentences++;
    if ((gpsRejectedSentences & 0x1fU) == 1U) {
      Serial.printf("[GPS] Rejected NMEA checksum/frame (%lu total).\n",
                    (unsigned long)gpsRejectedSentences);
    }
    return;
  }

  // Split in place while preserving empty fields (strtok would collapse them).
  char* fields[18] = {nullptr};
  uint8_t fieldCount = 1;
  fields[0] = gpsNmea;
  for (char* p = gpsNmea; *p != '\0' && fieldCount < 18; p++) {
    if (*p == ',') {
      *p = '\0';
      fields[fieldCount++] = p + 1;
    }
  }
  if (fieldCount < 2) return;

  const bool isRmc = strcmp(fields[0], "$GNRMC") == 0
                  || strcmp(fields[0], "$GPRMC") == 0;
  const bool isGga = strcmp(fields[0], "$GNGGA") == 0
                  || strcmp(fields[0], "$GPGGA") == 0;
  if (!isRmc && !isGga) return;

  const bool previousFix = gpsFix;
  bool sentenceHasFix = false;
  lastGpsSentence = millis();

  if (isRmc) {
    if (fieldCount < 10) return;
    const bool statusActive = fields[2] && fields[2][0] == 'A';
    if (statusActive && fields[3] && fields[4] && fields[5] && fields[6]) {
      float candidateLat = 0.0f;
      float candidateLon = 0.0f;
      if (nmeaCoordinateToDecimal(fields[3], fields[4][0], true, candidateLat)
          && nmeaCoordinateToDecimal(fields[5], fields[6][0], false, candidateLon)) {
        gpsLat = candidateLat;
        gpsLon = candidateLon;
        updateGpsSpeed(atof(fields[7]) * 1.852f);
        gpsHeading = atof(fields[8]);
        syncUtcFromRmc(fields[1], fields[9]);
        sentenceHasFix = true;
      } else {
        gpsRejectedPositions++;
      }
    }
  } else {
    if (fieldCount < 10) return;
    const int fixQuality = atoi(fields[6]);
    gpsSatellites = (uint8_t)constrain(atoi(fields[7]), 0, 99);
    gpsHdop = atof(fields[8]);
    gpsAltitudeM = atof(fields[9]);
    if (gpsHdop > 0.0f) {
      gpsAccuracyM = constrain(gpsHdop * 5.0f, 3.0f, 100.0f);
    }
    if (fixQuality > 0) {
      float candidateLat = 0.0f;
      float candidateLon = 0.0f;
      if (nmeaCoordinateToDecimal(fields[2], fields[3][0], true, candidateLat)
          && nmeaCoordinateToDecimal(fields[4], fields[5][0], false, candidateLon)) {
        gpsLat = candidateLat;
        gpsLon = candidateLon;
        sentenceHasFix = true;
      } else {
        gpsRejectedPositions++;
      }
    }
  }

  if (sentenceHasFix) {
    lastGpsFixAt = millis();
    gpsFix = true;
  }

  if (sentenceHasFix && !previousFix) {
    Serial.printf("[GPS] FIX acquired: %.6f, %.6f speed=%.1f km/h\n",
                  gpsLat, gpsLon, gpsSpeed);
  }
}

bool nmeaChecksumValid(const char* sentence) {
  if (!sentence || sentence[0] != '$') return false;
  const char* checksumMarker = strchr(sentence, '*');
  if (!checksumMarker || checksumMarker[1] == '\0' || checksumMarker[2] == '\0'
      || checksumMarker[3] != '\0') return false;

  uint8_t calculated = 0;
  for (const char* cursor = sentence + 1; cursor < checksumMarker; cursor++) {
    calculated ^= (uint8_t)*cursor;
  }
  char checksumText[3] = {checksumMarker[1], checksumMarker[2], '\0'};
  char* end = nullptr;
  const unsigned long reported = strtoul(checksumText, &end, 16);
  return end && *end == '\0' && reported <= 0xffUL
      && calculated == (uint8_t)reported;
}

bool nmeaCoordinateToDecimal(const char* rawField, char hemisphere,
                             bool latitude, float& decimal) {
  if (!rawField || rawField[0] == '\0') return false;
  if (latitude && hemisphere != 'N' && hemisphere != 'S') return false;
  if (!latitude && hemisphere != 'E' && hemisphere != 'W') return false;

  char* end = nullptr;
  const double raw = strtod(rawField, &end);
  if (!end || *end != '\0' || !isfinite(raw) || raw <= 0.0) return false;
  const int degrees = (int)(raw / 100.0);
  const double minutes = raw - degrees * 100.0;
  const int maximumDegrees = latitude ? 90 : 180;
  if (degrees < 0 || degrees > maximumDegrees
      || minutes < 0.0 || minutes >= 60.0
      || (degrees == maximumDegrees && minutes > 0.0)) return false;

  double value = degrees + minutes / 60.0;
  if (hemisphere == 'S' || hemisphere == 'W') value = -value;
  decimal = (float)value;
  return isfinite(decimal);
}

bool syncUtcFromRmc(const char* timeField, const char* dateField) {
  if (!timeField || !dateField || strlen(timeField) < 6 || strlen(dateField) < 6) {
    return false;
  }

  const double rawTime = atof(timeField);
  const int rawDate = atoi(dateField);
  const int hours = (int)(rawTime / 10000.0);
  const int minutes = ((int)(rawTime / 100.0)) % 100;
  const int seconds = (int)rawTime % 100;
  const int day = rawDate / 10000;
  const int month = (rawDate / 100) % 100;
  const int year = rawDate % 100;
  if (hours > 23 || minutes > 59 || seconds > 60
      || day < 1 || day > 31 || month < 1 || month > 12) {
    return false;
  }

  // Convert a civil UTC date directly to Unix days. ESP32 newlib does not
  // expose timegm(), and mktime() would depend on mutable timezone state.
  int fullYear = 2000 + year;
  fullYear -= month <= 2;
  const int era = (fullYear >= 0 ? fullYear : fullYear - 399) / 400;
  const unsigned yearOfEra = (unsigned)(fullYear - era * 400);
  const unsigned dayOfYear = (153U * (unsigned)(month + (month > 2 ? -3 : 9)) + 2U) / 5U
                           + (unsigned)day - 1U;
  const unsigned dayOfEra = yearOfEra * 365U + yearOfEra / 4U
                          - yearOfEra / 100U + dayOfYear;
  const int64_t unixDays = (int64_t)era * 146097LL + (int64_t)dayOfEra - 719468LL;
  const time_t gpsTime = (time_t)(unixDays * 86400LL
                       + hours * 3600LL + minutes * 60LL + seconds);
  if (gpsTime < 1704067200) return false;

  const time_t systemTime = time(nullptr);
  if (systemTime < 1704067200 || llabs((long long)systemTime - gpsTime) > 5) {
    struct timeval value = {gpsTime, 0};
    settimeofday(&value, nullptr);
    Serial.println(F("[GPS] UTC clock synchronized from RMC."));
  }
  return true;
}

bool gnssPoll() {
#if USE_EXTERNAL_L76K_GPS
  return gpsFix;
#else
  if (!modemAtReady || !gnssEnabled) return false;

  modemSendAT("AT+CGNSSINFO");
  uint32_t start = millis();
  String response;
  while (millis() - start < 2000) {
    if (SERIAL_AT.available()) {
      response += SERIAL_AT.readStringUntil('\n') + '\n';
    }
  }

  if (response.length() == 0) {
    modemPollFailures++;
    Serial.printf("[GNSS] No modem response (%u/3).\n", modemPollFailures);
    if (modemPollFailures >= 3) {
      modemPollFailures = 0;
      modemRecoveryRetry("UART stopped responding during GNSS poll");
    }
    return false;
  }
  modemPollFailures = 0;

  int idx = response.indexOf("+CGNSSINFO:");
  int offset = 11;
  if (idx < 0) { idx = response.indexOf("+CGPSINFO:"); offset = 10; }
  if (idx < 0) return false;

  String data = response.substring(idx + offset);
  data.trim();

  // Fields: mode,fix,lat,NS,lon,EW,date,time,alt,speed,course,...
  char buf[128];
  data.toCharArray(buf, sizeof(buf));
  char* tok = strtok(buf, ",");
  int f = 0;
  float rawLat = 0.0f, rawLon = 0.0f;
  char ns = 'N', ew = 'E';
  while (tok != NULL) {
    switch (f) {
      case 1: gpsFix = (atoi(tok) > 0); break;
      case 2: rawLat = atof(tok); break;
      case 3: ns = tok[0]; break;
      case 4: rawLon = atof(tok); break;
      case 5: ew = tok[0]; break;
      case 9: updateGpsSpeed(atof(tok) * 1.852f); break; // knots → km/h
    }
    tok = strtok(NULL, ",");
    f++;
  }

  if (gpsFix && rawLat != 0.0f && rawLon != 0.0f) {
    char rawLatText[24] = {0};
    char rawLonText[24] = {0};
    snprintf(rawLatText, sizeof(rawLatText), "%.8f", rawLat);
    snprintf(rawLonText, sizeof(rawLonText), "%.8f", rawLon);
    float candidateLat = 0.0f;
    float candidateLon = 0.0f;
    if (nmeaCoordinateToDecimal(rawLatText, ns, true, candidateLat)
        && nmeaCoordinateToDecimal(rawLonText, ew, false, candidateLon)) {
      gpsLat = candidateLat;
      gpsLon = candidateLon;
      return true;
    }
    gpsFix = false;
  }
  return false;
#endif
}

// ============================================================================
//  TELEMETRY IDENTITY, CLOCK, COMMAND ACKS, AND REQUEST SIGNING
// ============================================================================

void telemetryIdentityInit() {
  if (!devicePreferences.begin("bikeboss", false)) {
    Serial.println(F("Telemetry: Preferences unavailable; sequence starts at zero."));
    telemetrySequence = 0;
    return;
  }
  telemetrySequence = devicePreferences.getULong64("telem_seq", 0);
  Serial.printf("Telemetry: sequence restored at %llu.\n",
                (unsigned long long)telemetrySequence);
}

bool utcIso8601(char* destination, size_t destinationSize) {
  const time_t now = time(nullptr);
  if (now < 1704067200 || destinationSize < 21) return false; // before 2024-01-01
  struct tm utc = {};
  gmtime_r(&now, &utc);
  return strftime(destination, destinationSize, "%Y-%m-%dT%H:%M:%SZ", &utc) > 0;
}

void appendCommandAcks(JsonDocument& doc) {
  if (pendingCommandAckCount == 0 && !globalOtaHasAcknowledgement()) return;
  JsonArray acknowledgements = doc["k"].to<JsonArray>();
  for (uint8_t index = 0; index < pendingCommandAckCount; index++) {
    JsonArray acknowledgement = acknowledgements.add<JsonArray>();
    acknowledgement.add(pendingCommandAcks[index].id);
    acknowledgement.add(pendingCommandAcks[index].applied ? 1 : 0);
  }
  globalOtaAppendAcknowledgement(acknowledgements);
}

void clearCommandAcks() {
  pendingCommandAckCount = 0;
  for (CommandAck& acknowledgement : pendingCommandAcks) acknowledgement = CommandAck{};
  globalOtaClearAcknowledgement();
}

bool containsCommandAcks(const JsonDocument& doc) {
  if (doc["k"].is<JsonArrayConst>() && doc["k"].size() > 0) return true;
  const JsonArrayConst points = doc["p"].as<JsonArrayConst>();
  for (JsonObjectConst point : points) {
    if (point["k"].is<JsonArrayConst>() && point["k"].size() > 0) return true;
  }
  return false;
}

static void queueCommandAck(uint32_t commandId, bool applied) {
  if (pendingCommandAckCount >= 5) return;
  pendingCommandAcks[pendingCommandAckCount].id = commandId;
  pendingCommandAcks[pendingCommandAckCount].applied = applied;
  pendingCommandAckCount++;
}

void handleTelemetryResponse(const String& response) {
  JsonDocument responseDoc;
  const DeserializationError error = deserializeJson(responseDoc, response);
  if (error) {
    Serial.printf("[COMMAND] Response JSON rejected: %s\n", error.c_str());
    return;
  }

  auto applyCommand = [](uint32_t commandId, const char* action, JsonVariantConst payload) {
    bool applied = false;
    bool acknowledgementDeferred = false;

    if (strcmp(action, "ARM") == 0) {
      armState = ArmState::ARMED;
      pendingUnlockStart = 0;
      relayImmobilize();
      applied = true;
    } else if (strcmp(action, "DISARM") == 0) {
      armState = ArmState::DISARMED;
      pendingUnlockStart = 0;
      relayRelease();
      applied = true;
#if USE_WIFI_UPLINK
    } else if (strcmp(action, "WIFI_SYNC") == 0 && payload.is<JsonObjectConst>()) {
      applied = trustedWifi.applyEncryptedSync(
        payload.as<JsonObjectConst>(), DEVICE_SIGNING_KEY_HEX);
#endif
#if ENABLE_GLOBAL_OTA
    } else if (strcmp(action, "OTA") == 0) {
      applied = globalOtaOffer(commandId, payload, telemetrySequence)
        == GlobalOtaOfferResult::ACCEPTED;
      acknowledgementDeferred = applied;
#endif
    }

    if (commandId > 0 && !acknowledgementDeferred) queueCommandAck(commandId, applied);
    Serial.printf("[COMMAND] id=%lu action=%s status=%s arm=%u\n",
                  (unsigned long)commandId,
                  action,
                  applied ? "applied" : "failed",
                  (unsigned int)armState);
  };

  if (responseDoc["c"].is<JsonArray>()) {
    const JsonArray commands = responseDoc["c"].as<JsonArray>();
    for (JsonArray command : commands) {
      applyCommand(command[0] | 0, command[1] | "", command[2]);
    }
    return;
  }

  const JsonArray commands = responseDoc["commands"].as<JsonArray>();
  for (JsonObject command : commands) {
    applyCommand(command["id"] | 0, command["command"] | "", command["payload"]);
  }
}

#if USE_SIGNED_TELEMETRY_V2
static bool hexKeyToBytes(const char* hexKey, uint8_t* destination, size_t size) {
  if (!hexKey || strlen(hexKey) != size * 2) return false;
  for (size_t index = 0; index < size; index++) {
    char pair[3] = {hexKey[index * 2], hexKey[index * 2 + 1], '\0'};
    char* end = nullptr;
    const long value = strtol(pair, &end, 16);
    if (!end || *end != '\0' || value < 0 || value > 255) return false;
    destination[index] = (uint8_t)value;
  }
  return true;
}

static bool sha256(const uint8_t* input, size_t inputLength, uint8_t output[32]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  return info && mbedtls_md(info, input, inputLength, output) == 0;
}

static bool hmacSha256(const uint8_t* key, size_t keyLength,
                       const uint8_t* input, size_t inputLength,
                       uint8_t output[32]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  return info && mbedtls_md_hmac(info, key, keyLength, input, inputLength, output) == 0;
}

static String bytesToHex(const uint8_t* bytes, size_t length) {
  static const char* digits = "0123456789abcdef";
  String result;
  result.reserve(length * 2);
  for (size_t index = 0; index < length; index++) {
    result += digits[(bytes[index] >> 4) & 0x0f];
    result += digits[bytes[index] & 0x0f];
  }
  return result;
}

#if USE_WIFI_UPLINK && ENABLE_ARDUINO_OTA
static bool deriveOtaPassword(String& password) {
  uint8_t signingKey[32] = {0};
  if (!hexKeyToBytes(DEVICE_SIGNING_KEY_HEX, signingKey, sizeof(signingKey))) return false;

  static const uint8_t purpose[] = "bikeboss-arduino-ota-v1";
  uint8_t digest[32] = {0};
  const bool derived = hmacSha256(
    signingKey, sizeof(signingKey), purpose, sizeof(purpose) - 1, digest);
  memset(signingKey, 0, sizeof(signingKey));
  if (!derived) return false;

  password = bytesToHex(digest, 12);
  memset(digest, 0, sizeof(digest));
  return true;
}

void otaLoop() {
  static bool started = false;
  static bool credentialErrorReported = false;

  if (!trustedWifi.connected()) {
    if (started) {
      ArduinoOTA.end();
      started = false;
      otaInProgress = false;
      Serial.println(F("[OTA] Paused until trusted Wi-Fi reconnects."));
    }
    return;
  }

  if (!started) {
    String password;
    if (!deriveOtaPassword(password)) {
      if (!credentialErrorReported) {
        Serial.println(F("[OTA] Disabled: device signing key is unavailable."));
        credentialErrorReported = true;
      }
      return;
    }

    String hostname = String("bikeboss-") + DEVICE_ID;
    hostname.toLowerCase();
    ArduinoOTA.setHostname(hostname.c_str());
    ArduinoOTA.setPassword(password.c_str());
    password = String();
    ArduinoOTA.onStart([]() {
      otaInProgress = true;
      Serial.println(F("[OTA] Authenticated firmware update started."));
    });
    ArduinoOTA.onEnd([]() {
      otaInProgress = false;
      Serial.println(F("[OTA] Update complete; rebooting."));
    });
    ArduinoOTA.onError([](ota_error_t error) {
      otaInProgress = false;
      Serial.printf("[OTA] Update failed with error %u.\n", static_cast<unsigned>(error));
    });
    ArduinoOTA.begin();
    started = true;
    credentialErrorReported = false;
    Serial.printf("[OTA] Ready: %s.local (%s:3232).\n",
                  hostname.c_str(), WiFi.localIP().toString().c_str());
  }

  ArduinoOTA.handle();
}
#endif

static String base64Url(const uint8_t* bytes, size_t length) {
  static const char* alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  String output;
  output.reserve(((length + 2) / 3) * 4);
  for (size_t index = 0; index < length; index += 3) {
    const uint32_t chunk = ((uint32_t)bytes[index] << 16)
                         | ((index + 1 < length ? bytes[index + 1] : 0) << 8)
                         | (index + 2 < length ? bytes[index + 2] : 0);
    output += alphabet[(chunk >> 18) & 0x3f];
    output += alphabet[(chunk >> 12) & 0x3f];
    if (index + 1 < length) output += alphabet[(chunk >> 6) & 0x3f];
    if (index + 2 < length) output += alphabet[chunk & 0x3f];
  }
  return output;
}

bool buildSignedRequestHeaders(const char* path, const String& payload,
                               const JsonDocument& doc, String& timestamp,
                               String& sequence, String& signatureValue) {
  uint8_t signingKey[32] = {0};
  if (!hexKeyToBytes(DEVICE_SIGNING_KEY_HEX, signingKey, sizeof(signingKey))) {
    Serial.println(F("[AUTH] DEVICE_SIGNING_KEY_HEX is missing or invalid."));
    return false;
  }

  const time_t requestTime = time(nullptr);
  if (requestTime < 1704067200) {
    Serial.println(F("[AUTH] UTC clock not synchronized."));
    return false;
  }

  const uint64_t requestSequence = doc["q"].is<uint64_t>()
    ? doc["q"].as<uint64_t>()
    : doc["sequence"].as<uint64_t>();
  uint8_t bodyDigest[32] = {0};
  if (!sha256((const uint8_t*)payload.c_str(), payload.length(), bodyDigest)) return false;

  String canonical = "POST\n";
  canonical += path;
  canonical += "\n";
  canonical += deviceId;
  canonical += "\n";
  timestamp = String((unsigned long)requestTime);
  canonical += timestamp;
  canonical += "\n";
  char sequenceBuffer[24] = {0};
  snprintf(sequenceBuffer, sizeof(sequenceBuffer), "%llu",
           (unsigned long long)requestSequence);
  sequence = sequenceBuffer;
  canonical += sequenceBuffer;
  canonical += "\n";
  canonical += bytesToHex(bodyDigest, sizeof(bodyDigest));

  uint8_t signature[32] = {0};
  if (!hmacSha256(
        signingKey,
        sizeof(signingKey),
        (const uint8_t*)canonical.c_str(),
        canonical.length(),
        signature)) {
    return false;
  }

  signatureValue = base64Url(signature, sizeof(signature));
  return true;
}

#if USE_WIFI_UPLINK
bool addSignedRequestHeaders(HTTPClient& http, const char* path,
                             const String& payload, const JsonDocument& doc) {
  String timestamp;
  String sequence;
  String signature;
  if (!buildSignedRequestHeaders(
        path, payload, doc, timestamp, sequence, signature)) {
    return false;
  }
  const String compactAuth = timestamp + "." + sequence + ".1." + signature;
  http.addHeader("X-BikeBoss-Auth", compactAuth);
  return true;
}
#endif
#endif

// ============================================================================
//  WiFi UPLINK — bench testing path (XIAO's own WiFi radio)
// ============================================================================

#if USE_WIFI_UPLINK

void wifiInit() {
  trustedWifi.begin(devicePreferences);
  // Still boot A7670G for cellular fallback. GPS is the separate L76K UART.
  modemInit();
}

bool wifiSendTelemetry(const char* path, const JsonDocument& doc,
                       bool bufferOnFailure) {
  if (!trustedWifi.connected()) {
    // Offline — buffer to SPIFFS
    if (bufferOnFailure) {
      String buf;
      serializeJson(doc, buf);
      spiffsLogRequest(path, buf);
      Serial.println(F("[TELEM] WiFi down — buffered to SPIFFS."));
    }
    return false;
  }

  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  String url = String(CLOUD_SCHEME) + "://" + CLOUD_HOST + String(path);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

#if USE_SIGNED_TELEMETRY_V2
  const bool signedEndpoint = strcmp(path, TELEMETRY_PATH) == 0
                           || strcmp(path, TELEMETRY_BATCH_PATH) == 0;
  if (signedEndpoint && !addSignedRequestHeaders(http, path, payload, doc)) {
    Serial.println(F("[TELEM] Signing unavailable — packet buffered."));
    if (bufferOnFailure) spiffsLogRequest(path, payload);
    http.end();
    return false;
  }
#endif

  Serial.printf("[TELEM] WiFi POST %s (%d bytes)\n", path, payload.length());
  int code = http.POST(payload);

  if (code > 0) {
    Serial.printf("[TELEM] → HTTP %d\n", code);
    if (code == 200) {
      String resp = http.getString();
      Serial.printf("[TELEM] ← %s\n", resp.c_str());
#if USE_SIGNED_TELEMETRY_V2
      if (signedEndpoint && containsCommandAcks(doc)) clearCommandAcks();
#endif
      handleTelemetryResponse(resp);
      http.end();
      return true;
    }
#if USE_SIGNED_TELEMETRY_V2
    if (signedEndpoint && code == 409) {
      // A response can be lost after D1 commits. Replay means this sequence is
      // already durable, so discard the local duplicate and continue.
      if (containsCommandAcks(doc)) clearCommandAcks();
      Serial.println(F("[TELEM] Replay acknowledged; local duplicate discarded."));
      http.end();
      return true;
    }
#endif
    if (bufferOnFailure && (code == 429 || code >= 500)) {
      spiffsLogRequest(path, payload);
    }
  } else {
    Serial.printf("[TELEM] HTTP error: %s — buffering.\n",
                  http.errorToString(code).c_str());
    if (bufferOnFailure) spiffsLogRequest(path, payload);
  }

  http.end();
  return false;
}

#endif // USE_WIFI_UPLINK

// ============================================================================
//  TELEMETRY — Cloudflare Worker Dispatch
// ============================================================================

void buildTelemetryPayload(JsonDocument& doc) {
  const uint32_t rawPresenceAgeSeconds = (millis() - blePresenceUpdatedAt) / 1000UL;
  const uint16_t presenceAgeSeconds = rawPresenceAgeSeconds > 86400UL
    ? 86400U
    : (uint16_t)rawPresenceAgeSeconds;
#if USE_SIGNED_TELEMETRY_V2
  doc["v"] = 2;
  doc["id"] = deviceId;
  doc["q"] = telemetrySequence;
  doc["t"] = (uint32_t)time(nullptr);
  doc["a"] = (uint8_t)armState;

  JsonArray gps = doc["g"].to<JsonArray>();
  gps.add(gpsFix ? 1 : 0);
  if (gpsFix) {
    gps.add((int32_t)lroundf(gpsLat * 10000000.0f));
    gps.add((int32_t)lroundf(gpsLon * 10000000.0f));
    gps.add((uint16_t)constrain((int)lroundf((gpsSpeed / 3.6f) * 100.0f), 0, 20000));
    gps.add((uint16_t)constrain((int)lroundf(gpsAccuracyM * 10.0f), 0, 10000));
    gps.add((uint16_t)constrain((int)lroundf(gpsHdop * 10.0f), 0, 9999));
    gps.add((uint8_t)min((int)gpsSatellites, 99));
    gps.add((uint16_t)constrain((int)lroundf(gpsHeading * 10.0f), 0, 3600));
    gps.add((int32_t)constrain((int)lroundf(gpsAltitudeM * 10.0f), -20000, 200000));
  }

  const bool moving = isVehicleMoving();
  JsonArray imu = doc["m"].to<JsonArray>();
  imu.add(imuCalibrated ? 1 : 0);
  imu.add(moving ? 1 : 0);
  imu.add((uint16_t)constrain((int)lroundf(atotal * 100.0f), 0, 20000));
  imu.add((uint32_t)constrain((int)lroundf(gtotal * 1000.0f), 0, 100000));

  if (battSenseEnabled && isfinite(mainBatteryVoltage)) {
    doc["b"] = (uint16_t)constrain((int)lroundf(mainBatteryVoltage * 1000.0f), 0, 60000);
  }
  doc["c"] = (uint8_t)crashStage;
  globalOtaAppendFirmware(doc);
  JsonArray ownerPresence = doc["o"].to<JsonArray>();
  ownerPresence.add(bleOwnerAuthenticated ? 1 : 0);
  ownerPresence.add(bleClientConnected ? 1 : 0);
  ownerPresence.add(presenceAgeSeconds);
  ownerPresence.add(bleOwnerAuthenticated && bleClientConnected ? 900 : 0);
  JsonArray uplink = doc["u"].to<JsonArray>();
#if USE_WIFI_UPLINK
  if (trustedWifi.connected()) {
    uplink.add(1); // Wi-Fi; never transmit the SSID or password.
    uplink.add((int)WiFi.RSSI());
    if (trustedWifi.currentLabel()[0] != '\0') uplink.add(trustedWifi.currentLabel());
    else uplink.add(nullptr);
    if (strcmp(trustedWifi.currentProfileId(), "bootstrap") != 0
        && trustedWifi.currentProfileId()[0] != '\0') {
      uplink.add(trustedWifi.currentProfileId());
    }
  } else {
    uplink.add(2);
    uplink.add(nullptr);
    if (CELLULAR_NETWORK_LABEL[0] != '\0') uplink.add(CELLULAR_NETWORK_LABEL);
  }
#else
  uplink.add(2); // A7670G cellular (LTE Cat-1).
  if (CELLULAR_NETWORK_LABEL[0] != '\0') {
    uplink.add(nullptr);
    uplink.add(CELLULAR_NETWORK_LABEL);
  }
#endif
  appendCommandAcks(doc);
#else
  doc["device_id"] = deviceId;
  doc["timestamp"] = millis();
  doc["arm_state"]  = (uint8_t)armState;
  char capturedAt[25];
  if (utcIso8601(capturedAt, sizeof(capturedAt))) doc["captured_at"] = capturedAt;

  // GPS
  JsonObject gpsObject = doc.createNestedObject("gps");
  gpsObject["lat"]   = gpsLat;
  gpsObject["lon"]   = gpsLon;
  gpsObject["speed"] = gpsSpeed;
  gpsObject["speed_m_s"] = gpsSpeed / 3.6f;
  gpsObject["fix"]   = gpsFix;
  gpsObject["accuracy_m"] = gpsAccuracyM;
  gpsObject["hdop"] = gpsHdop;
  gpsObject["satellites"] = gpsSatellites;
  gpsObject["heading"] = gpsHeading;
  gpsObject["altitude_m"] = gpsAltitudeM;
  gpsObject["source"] = "l76k";

  // IMU
  JsonObject imuObject = doc.createNestedObject("imu");
  imuObject["calibrated"] = imuCalibrated;
  imuObject["ax"] = ax;
  imuObject["ay"] = ay;
  imuObject["az"] = az;
  imuObject["gx"] = gx;
  imuObject["gy"] = gy;
  imuObject["gz"] = gz;
  imuObject["atotal"] = atotal;
  imuObject["gtotal"] = gtotal;

  // Battery
  if (battSenseEnabled && isfinite(mainBatteryVoltage)) {
    doc["vbat"] = mainBatteryVoltage;
  }

  // Crash status
  doc["crash_stage"] = (uint8_t)crashStage;
  doc["crash_confirmed"] = (crashStage == CrashStage::CONFIRMED);
  const bool moving = fabsf(atotal - 9.80665f) > 1.5f || gtotal > 0.5f;
  doc["motion_state"] = moving ? "moving" : "stationary";
  JsonObject ownerPresence = doc.createNestedObject("owner_presence");
  ownerPresence["authenticated"] = bleOwnerAuthenticated;
  ownerPresence["connected"] = bleClientConnected;
  ownerPresence["age_seconds"] = presenceAgeSeconds;
  ownerPresence["confidence"] = bleOwnerAuthenticated && bleClientConnected ? 0.9f : 0.0f;

  // Privacy-safe transport diagnostics. Network names and IP addresses never
  // leave the controller.
  JsonObject uplink = doc["uplink"].to<JsonObject>();
#if USE_WIFI_UPLINK
  if (trustedWifi.connected()) {
    uplink["type"] = "wifi";
    uplink["signal_dbm"] = WiFi.RSSI();
    if (trustedWifi.currentLabel()[0] != '\0') uplink["label"] = trustedWifi.currentLabel();
    if (strcmp(trustedWifi.currentProfileId(), "bootstrap") != 0
        && trustedWifi.currentProfileId()[0] != '\0') {
      uplink["profile_id"] = trustedWifi.currentProfileId();
    }
  } else {
    uplink["type"] = "cellular";
    uplink["generation"] = "4g";
    if (CELLULAR_NETWORK_LABEL[0] != '\0') uplink["label"] = CELLULAR_NETWORK_LABEL;
  }
#else
  uplink["type"] = "cellular";
  uplink["generation"] = "4g";
  if (CELLULAR_NETWORK_LABEL[0] != '\0') uplink["label"] = CELLULAR_NETWORK_LABEL;
#endif

  // Geofence
  doc["geofence_active"] = geofenceActive;
  if (geofenceActive) {
    doc["geofence_anchor_lat"] = geofenceAnchorLat;
    doc["geofence_anchor_lon"] = geofenceAnchorLon;
  }
#endif
}

// Unified uplink: WiFi (bench) or modem 4G (production).
bool sendTelemetry(const char* path, const JsonDocument& doc,
                   bool bufferOnFailure) {
#if USE_WIFI_UPLINK
  if (trustedWifi.connected()) return wifiSendTelemetry(path, doc, bufferOnFailure);
  if (ENABLE_CELLULAR_FALLBACK && netState == NetState::ONLINE) {
    return modemSendTelemetry(path, doc, bufferOnFailure);
  }
  if (bufferOnFailure) {
    String payload;
    serializeJson(doc, payload);
    spiffsLogRequest(path, payload);
    Serial.println(F("[TELEM] No usable Wi-Fi or cellular uplink — buffered."));
  }
  return false;
#else
  return modemSendTelemetry(path, doc, bufferOnFailure);
#endif
}

static bool modemWaitForOkOnly(uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    if (!SERIAL_AT.available()) {
      delay(10);
      continue;
    }
    String line = SERIAL_AT.readStringUntil('\n');
    line.trim();
    if (line.length()) Serial.printf("[AT] ← %s\n", line.c_str());
    if (line == "OK") return true;
    if (line.startsWith("ERROR") || line.startsWith("+CME ERROR")) return false;
  }
  return false;
}

static int modemWaitHttpAction(int* responseLength, uint32_t timeoutMs = 20000) {
  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    if (!SERIAL_AT.available()) {
      delay(10);
      continue;
    }
    String line = SERIAL_AT.readStringUntil('\n');
    line.trim();
    if (line.length()) Serial.printf("[HTTP] ← %s\n", line.c_str());
    int method = 0;
    int status = 0;
    int length = 0;
    if (sscanf(line.c_str(), "+HTTPACTION: %d,%d,%d", &method, &status, &length) == 3) {
      if (responseLength) *responseLength = length;
      return status;
    }
  }
  return -1;
}

static String modemReadHttpBody(int responseLength) {
  if (responseLength <= 0) return String();
  // Routine command responses are tiny. An encrypted profile revision can be
  // larger, so allow the bounded eight-profile envelope without truncation.
  const int readLength = min(responseLength, 4096);
  const String command = "AT+HTTPREAD=0," + String(readLength);
  SERIAL_AT.println(command);
  Serial.printf("[AT] → %s\n", command.c_str());

  String body;
  const uint32_t start = millis();
  while (millis() - start < 5000) {
    if (!SERIAL_AT.available()) {
      delay(10);
      continue;
    }
    String line = SERIAL_AT.readStringUntil('\n');
    line.trim();
    if (line == "OK") break;
    if (line.startsWith("+HTTPREAD:")) continue;
    if (line.length()) body += line;
  }
  return body;
}

#if ENABLE_GLOBAL_OTA && USE_WIFI_UPLINK && ENABLE_CELLULAR_FALLBACK
static int modemReadFirmwareChunk(size_t offset, uint8_t* buffer, size_t wanted) {
  while (SERIAL_AT.available()) SERIAL_AT.read();
  const String command = "AT+HTTPREAD=" + String(offset) + "," + String(wanted);
  modemSendAT(command.c_str());

  int announced = -1;
  const uint32_t headerStartedAt = millis();
  while (millis() - headerStartedAt < 5000UL) {
    if (!SERIAL_AT.available()) { delay(2); continue; }
    String line = SERIAL_AT.readStringUntil('\n');
    line.trim();
    if (!line.startsWith("+HTTPREAD:")) continue;
    const int separator = max(line.lastIndexOf(','), line.lastIndexOf(':'));
    announced = separator >= 0 ? line.substring(separator + 1).toInt() : -1;
    break;
  }
  if (announced <= 0 || announced > static_cast<int>(wanted)) return -1;

  size_t received = 0;
  uint32_t lastByteAt = millis();
  while (received < static_cast<size_t>(announced)
         && millis() - lastByteAt < 10000UL) {
    const int available = SERIAL_AT.available();
    if (available <= 0) { delay(2); continue; }
    const size_t chunk = min(
      static_cast<size_t>(available),
      static_cast<size_t>(announced) - received
    );
    received += SERIAL_AT.readBytes(buffer + received, chunk);
    lastByteAt = millis();
  }
  if (received != static_cast<size_t>(announced)) return -1;
  return modemWaitForOkOnly(5000UL) ? announced : -1;
}

static String otaDigestHex(const uint8_t* digest, size_t length) {
  static constexpr char digits[] = "0123456789abcdef";
  String value;
  value.reserve(length * 2);
  for (size_t index = 0; index < length; index++) {
    value += digits[(digest[index] >> 4) & 0x0f];
    value += digits[digest[index] & 0x0f];
  }
  return value;
}

bool modemDownloadFirmware(const char* path, const char* authorization,
                           size_t sizeBytes, const char* sha256Hex) {
  if (netState != NetState::ONLINE || !path || !authorization || !sha256Hex) {
    return false;
  }
  modemWaitOK("AT+HTTPTERM", 2000);
  if (!modemWaitOK("AT+HTTPINIT", 5000)
      || !modemWaitOK("AT+HTTPPARA=\"CID\",1", 5000)) {
    modemWaitOK("AT+HTTPTERM", 2000);
    return false;
  }
  const String url = "AT+HTTPPARA=\"URL\",\"" + String(CLOUD_SCHEME)
    + "://" + String(CLOUD_HOST) + String(path) + "\"";
  const String auth = "AT+HTTPPARA=\"USERDATA\",\"X-BikeBoss-Auth: "
    + String(authorization) + "\"";
  if (!modemWaitOK(url.c_str(), 5000) || !modemWaitOK(auth.c_str(), 5000)) {
    modemWaitOK("AT+HTTPTERM", 2000);
    return false;
  }

  modemSendAT("AT+HTTPACTION=0");
  int responseLength = 0;
  const int status = modemWaitHttpAction(&responseLength, 45000UL);
  if (status != 200 || responseLength != static_cast<int>(sizeBytes)
      || !Update.begin(sizeBytes, U_FLASH)) {
    Serial.printf("[GLOBAL-OTA] 4G download rejected: HTTP %d size=%d.\n",
                  status, responseLength);
    modemWaitOK("AT+HTTPTERM", 5000);
    return false;
  }

  std::unique_ptr<uint8_t[]> buffer(new (std::nothrow) uint8_t[1024]);
  if (!buffer) {
    Update.abort();
    modemWaitOK("AT+HTTPTERM", 5000);
    return false;
  }
  mbedtls_sha256_context hash;
  mbedtls_sha256_init(&hash);
  mbedtls_sha256_starts_ret(&hash, 0);
  size_t total = 0;
  bool ok = true;
  while (total < sizeBytes) {
    const size_t wanted = min(static_cast<size_t>(1024), sizeBytes - total);
    const int received = modemReadFirmwareChunk(total, buffer.get(), wanted);
    if (received <= 0
        || Update.write(buffer.get(), static_cast<size_t>(received))
          != static_cast<size_t>(received)) {
      ok = false;
      break;
    }
    mbedtls_sha256_update_ret(&hash, buffer.get(), static_cast<size_t>(received));
    total += static_cast<size_t>(received);
    yield();
  }
  uint8_t digest[32] = {0};
  mbedtls_sha256_finish_ret(&hash, digest);
  mbedtls_sha256_free(&hash);
  modemWaitOK("AT+HTTPTERM", 5000);
  if (!ok || total != sizeBytes || otaDigestHex(digest, sizeof(digest)) != sha256Hex) {
    Update.abort();
    Serial.println(F("[GLOBAL-OTA] 4G binary hash/length verification failed."));
    return false;
  }
  if (!Update.end(false)) {
    Serial.printf("[GLOBAL-OTA] 4G image activation failed: %s.\n", Update.errorString());
    return false;
  }
  return true;
}
#endif

bool modemSendTelemetry(const char* path, const JsonDocument& doc,
                        bool bufferOnFailure) {
  if (netState != NetState::ONLINE) {
    // Offline — buffer to SPIFFS
    if (bufferOnFailure) {
      String buf;
      serializeJson(doc, buf);
      spiffsLogRequest(path, buf);
      Serial.println(F("[TELEM] Offline — buffered to SPIFFS."));
    }
    return false;
  }

  String payload;
  serializeJson(doc, payload);

#if USE_SIGNED_TELEMETRY_V2
  const bool signedEndpoint = strcmp(path, TELEMETRY_PATH) == 0
                           || strcmp(path, TELEMETRY_BATCH_PATH) == 0;
  String authTimestamp;
  String authSequence;
  String authSignature;
  if (signedEndpoint && !buildSignedRequestHeaders(
        path, payload, doc, authTimestamp, authSequence, authSignature)) {
    if (bufferOnFailure) spiffsLogRequest(path, payload);
    return false;
  }
#endif

  Serial.printf("[TELEM] POST %s (%d bytes)\n", path, payload.length());

  // Build HTTP POST via TinyGSM
  // Note: TinyGSM client requires explicit connection calls
  // In production, use modem.sendAT() with raw AT+HTTPPARA/AT+HTTPACTION
  // for the SIMCom A7670E's built-in HTTP stack for reliability.

  // --- Fallback: AT-command-based HTTP POST ---
  modemWaitOK("AT+HTTPTERM", 2000); // clear a stale previous session if present
  if (!modemWaitOK("AT+HTTPINIT", 5000)) {
    if (bufferOnFailure) spiffsLogRequest(path, payload);
    return false;
  }

  String cidCmd = "AT+HTTPPARA=\"CID\",1";
  if (!modemWaitOK(cidCmd.c_str(), 5000)) {
    modemWaitOK("AT+HTTPTERM", 2000);
    if (bufferOnFailure) spiffsLogRequest(path, payload);
    return false;
  }

  String urlCmd = "AT+HTTPPARA=\"URL\",\"" + String(CLOUD_SCHEME)
                + "://" + String(CLOUD_HOST) + String(path) + "\"";
  if (!modemWaitOK(urlCmd.c_str(), 5000)) {
    modemWaitOK("AT+HTTPTERM", 2000);
    if (bufferOnFailure) spiffsLogRequest(path, payload);
    return false;
  }

  String contentType = "AT+HTTPPARA=\"CONTENT\",\"application/json\"";
  if (!modemWaitOK(contentType.c_str(), 5000)) {
    modemWaitOK("AT+HTTPTERM", 2000);
    if (bufferOnFailure) spiffsLogRequest(path, payload);
    return false;
  }

#if USE_SIGNED_TELEMETRY_V2
  if (signedEndpoint) {
    const String compactAuth = authTimestamp + "." + authSequence
                             + ".1." + authSignature;
    String userData = "AT+HTTPPARA=\"USERDATA\",\"X-BikeBoss-Auth: ";
    userData += compactAuth;
    userData += "\"";
    if (!modemWaitOK(userData.c_str(), 5000)) {
      modemWaitOK("AT+HTTPTERM");
      if (bufferOnFailure) spiffsLogRequest(path, payload);
      return false;
    }
  }
#endif

  String dataCmd = "AT+HTTPDATA=" + String(payload.length()) + ",10000";
  modemSendAT(dataCmd.c_str());
  delay(200);
  SERIAL_AT.print(payload);
  if (!modemWaitForOkOnly(10000)) {
    modemWaitOK("AT+HTTPTERM", 2000);
    if (bufferOnFailure) spiffsLogRequest(path, payload);
    return false;
  }

  modemSendAT("AT+HTTPACTION=1");
  int responseLength = 0;
  const int status = modemWaitHttpAction(&responseLength);
  const String response = status > 0 ? modemReadHttpBody(responseLength) : String();

  modemWaitOK("AT+HTTPTERM", 5000);

  if (status >= 200 && status < 300) {
#if USE_SIGNED_TELEMETRY_V2
    if (signedEndpoint && containsCommandAcks(doc)) clearCommandAcks();
#endif
    if (response.length()) handleTelemetryResponse(response);
    return true;
  }
#if USE_SIGNED_TELEMETRY_V2
  if (signedEndpoint && status == 409) {
    if (containsCommandAcks(doc)) clearCommandAcks();
    return true;
  }
#endif
  if (bufferOnFailure && (status < 0 || status == 429 || status >= 500)) {
    spiffsLogRequest(path, payload);
  }
  return false;
}

void sendHeartbeat() {
#if USE_SIGNED_TELEMETRY_V2
  if (time(nullptr) < 1704067200) {
    Serial.println(F("[TELEM] Waiting for UTC before signed telemetry."));
    return;
  }
#endif

  bool uplinkAvailable = false;
#if USE_WIFI_UPLINK
  uplinkAvailable = trustedWifi.connected()
                 || (ENABLE_CELLULAR_FALLBACK && netState == NetState::ONLINE);
#else
  uplinkAvailable = netState == NetState::ONLINE;
#endif
  if (uplinkAvailable && spiffsHasPendingRequests() && !spiffsFlush()) {
    Serial.println(F("[TELEM] Offline backlog remains; live sequence held."));
    const uint32_t interval = currentHeartbeatIntervalMs();
    if (interval > OFFLINE_FLUSH_RETRY_MS) {
      lastHeartbeat = millis() - (interval - OFFLINE_FLUSH_RETRY_MS);
    }
    return;
  }

  // Capture the freshest available location before freezing the packet.
#if USE_WIFI_UPLINK
  if (modemAtReady && gnssEnabled) gnssPoll();
#endif

  telemetryDoc.clear();
#if USE_SIGNED_TELEMETRY_V2
  telemetrySequence++;
  devicePreferences.putULong64("telem_seq", telemetrySequence);
#endif
  buildTelemetryPayload(telemetryDoc);
  lastReportedArmState = armState;
  lastReportedGpsFix = gpsFix;
  lastReportedMoving = isVehicleMoving();
  sendTelemetry(HEARTBEAT_PATH, telemetryDoc);
}

void sendCrashAlert() {
  StaticJsonDocument<512> crashDoc;
  crashDoc["device_id"] = deviceId;
  crashDoc["timestamp"] = millis();
  crashDoc["event"]     = "CRASH_CONFIRMED";

  JsonObject gps = crashDoc.createNestedObject("gps");
  gps["lat"] = gpsLat;
  gps["lon"] = gpsLon;
  gps["fix"] = gpsFix;

  JsonObject imu = crashDoc.createNestedObject("imu");
  imu["atotal"] = crashImpactPeak;
  imu["gtotal"] = crashRotationPeak;
  imu["az"]     = az;
  imu["impact_peak"] = crashImpactPeak;
  imu["rotation_peak"] = crashRotationPeak;
  imu["upright_projection"] = uprightGravityProjection;

  sendTelemetry(CRASH_PATH, crashDoc);
}

// ============================================================================
//  SPIFFS — Offline Log Buffer
// ============================================================================

static bool isRoutineTelemetryPath(const char* path) {
  return path && (
    strcmp(path, HEARTBEAT_PATH) == 0
    || strcmp(path, TELEMETRY_PATH) == 0
    || strcmp(path, TELEMETRY_BATCH_PATH) == 0
  );
}

static bool isSafetyEventPath(const char* path) {
  return path && (
    strcmp(path, CRASH_PATH) == 0
    || strcmp(path, POWERCUT_PATH) == 0
  );
}

static const char* safetyEventPathFor(const JsonDocument& doc) {
  const char* event = doc["event"] | "";
  if (strcmp(event, "CRASH_CONFIRMED") == 0) return CRASH_PATH;
  if (strcmp(event, "POWER_CUT") == 0) return POWERCUT_PATH;
  return nullptr;
}

#if USE_SIGNED_TELEMETRY_V2
static bool isLegacyTelemetrySample(const JsonDocument& doc) {
  return doc["device_id"].is<const char*>()
      && doc["gps"].is<JsonObject>();
}
#endif

static bool spiffsFileHasData(const char* path) {
  File file = SPIFFS.open(path, FILE_READ);
  if (!file) return false;
  const bool hasData = file.size() > 0;
  file.close();
  return hasData;
}

static void recoverOfflineQueue(const char* logPath, const char* temporaryPath) {
  if (!SPIFFS.exists(temporaryPath)) return;
  if (SPIFFS.exists(logPath)) {
    SPIFFS.remove(temporaryPath);
    return;
  }
  if (!SPIFFS.rename(temporaryPath, logPath)) {
    Serial.printf("SPIFFS: Could not recover queue %s.\n", logPath);
  }
}

void spiffsInit() {
  if (!SPIFFS.begin(true)) {
    Serial.println(F("SPIFFS: Mount failed!"));
    return;
  }
  recoverOfflineQueue(SPIFFS_TELEMETRY_LOG_PATH, SPIFFS_TELEMETRY_TMP_PATH);
  recoverOfflineQueue(SPIFFS_EVENT_LOG_PATH, SPIFFS_EVENT_TMP_PATH);
  Serial.printf("SPIFFS: Mounted. Total=%d Used=%d\n",
                SPIFFS.totalBytes(), SPIFFS.usedBytes());
}

static bool spiffsAppendLine(const char* logPath, const String& line) {
  File f = SPIFFS.open(logPath, FILE_APPEND);
  if (!f) {
    Serial.printf("SPIFFS: Failed to open queue %s.\n", logPath);
    return false;
  }
  if (f.size() + line.length() + 2 > MAX_SPIFFS_LOG_SIZE) {
    f.close();
    SPIFFS.remove(logPath);
    f = SPIFFS.open(logPath, FILE_APPEND);
    if (!f) return false;
  }
  f.println(line);
  f.close();
  return true;
}

bool spiffsLogRequest(const char* path, const String& payload) {
  if (!path || payload.isEmpty()) return false;

  if (isRoutineTelemetryPath(path)) {
    const bool queued = spiffsAppendLine(SPIFFS_TELEMETRY_LOG_PATH, payload);
    if (queued) {
      Serial.println(F("SPIFFS: Routine telemetry queued."));
    }
    return queued;
  }

  if (!isSafetyEventPath(path)) {
    Serial.printf("SPIFFS: Refusing unsupported offline path %s.\n", path);
    return false;
  }

  JsonDocument body;
  if (deserializeJson(body, payload)) {
    Serial.println(F("SPIFFS: Refusing malformed safety-event payload."));
    return false;
  }
  JsonDocument envelope;
  envelope["p"] = path;
  envelope["b"] = body.as<JsonVariantConst>();
  String line;
  serializeJson(envelope, line);
  const bool queued = spiffsAppendLine(SPIFFS_EVENT_LOG_PATH, line);
  if (queued) {
    Serial.printf("SPIFFS: Safety event queued for %s.\n", path);
  }
  return queued;
}

bool spiffsHasPendingRequests() {
  return spiffsFileHasData(SPIFFS_EVENT_LOG_PATH)
      || spiffsFileHasData(SPIFFS_TELEMETRY_LOG_PATH);
}

static bool discardOfflineLines(const char* logPath, const char* temporaryPath,
                                size_t lineCount) {
  if (lineCount == 0) return true;
  File source = SPIFFS.open(logPath, FILE_READ);
  if (!source) return false;
  SPIFFS.remove(temporaryPath);
  File destination = SPIFFS.open(temporaryPath, FILE_WRITE);
  if (!destination) {
    source.close();
    return false;
  }

  size_t currentLine = 0;
  while (source.available()) {
    String line = source.readStringUntil('\n');
    if (currentLine++ >= lineCount) destination.println(line);
  }
  source.close();
  destination.close();

  SPIFFS.remove(logPath);
  File remaining = SPIFFS.open(temporaryPath, FILE_READ);
  const bool hasRemainingData = remaining && remaining.size() > 0;
  if (remaining) remaining.close();
  if (hasRemainingData) {
    if (!SPIFFS.rename(temporaryPath, logPath)) return false;
  } else {
    SPIFFS.remove(temporaryPath);
  }
  return true;
}

static bool flushOfflineEvents(uint8_t& requestsSent) {
  while (spiffsFileHasData(SPIFFS_EVENT_LOG_PATH)
         && requestsSent < OFFLINE_BATCH_MAX_REQUESTS) {
    File file = SPIFFS.open(SPIFFS_EVENT_LOG_PATH, FILE_READ);
    if (!file) return false;
    String line = file.readStringUntil('\n');
    file.close();
    line.trim();
    if (!line.length()) {
      if (!discardOfflineLines(
            SPIFFS_EVENT_LOG_PATH, SPIFFS_EVENT_TMP_PATH, 1)) return false;
      continue;
    }

    JsonDocument envelope;
    const DeserializationError error = deserializeJson(envelope, line);
    const char* path = envelope["p"] | "";
    if (error || !isSafetyEventPath(path) || !envelope["b"].is<JsonObject>()) {
      Serial.println(F("SPIFFS: Discarding corrupt safety-event envelope."));
      if (!discardOfflineLines(
            SPIFFS_EVENT_LOG_PATH, SPIFFS_EVENT_TMP_PATH, 1)) return false;
      continue;
    }

    JsonDocument body;
    body.set(envelope["b"]);
    if (!sendTelemetry(path, body, false)) return false;
    if (!discardOfflineLines(
          SPIFFS_EVENT_LOG_PATH, SPIFFS_EVENT_TMP_PATH, 1)) return false;
    requestsSent++;
    Serial.printf("SPIFFS: Safety event accepted by %s.\n", path);
  }
  return true;
}

static bool flushOfflineTelemetry(uint8_t& requestsSent) {
  while (spiffsFileHasData(SPIFFS_TELEMETRY_LOG_PATH)
         && requestsSent < OFFLINE_BATCH_MAX_REQUESTS) {
#if USE_SIGNED_TELEMETRY_V2
    File file = SPIFFS.open(SPIFFS_TELEMETRY_LOG_PATH, FILE_READ);
    if (!file) return false;

    JsonDocument batchDoc;
    batchDoc["v"] = 2;
    batchDoc["id"] = deviceId;
    JsonArray points = batchDoc["p"].to<JsonArray>();
    size_t consumedLines = 0;
    uint64_t lastSequence = 0;
    bool migratedLeadingEvent = false;
    bool sendLeadingLegacyTelemetry = false;
    JsonDocument legacyTelemetryDoc;

    while (file.available() && points.size() < OFFLINE_BATCH_MAX_SAMPLES) {
      String line = file.readStringUntil('\n');
      consumedLines++;
      line.trim();
      if (!line.length()) continue;

      JsonDocument sample;
      const DeserializationError error = deserializeJson(sample, line);
      const char* legacyEventPath = error ? nullptr : safetyEventPathFor(sample);
      if (legacyEventPath) {
        if (points.size() > 0) {
          // Leave this line at the head after the preceding telemetry batch is
          // accepted, then migrate it without risking duplicate event records.
          consumedLines--;
          break;
        }
        if (!spiffsLogRequest(legacyEventPath, line)) {
          file.close();
          return false;
        }
        Serial.printf("SPIFFS: Migrated legacy event to %s.\n", legacyEventPath);
        migratedLeadingEvent = true;
        break;
      }
      if (!error && isLegacyTelemetrySample(sample)) {
        if (points.size() > 0) {
          consumedLines--;
          break;
        }
        legacyTelemetryDoc.set(sample);
        sendLeadingLegacyTelemetry = true;
        break;
      }
      if (error
          || sample["v"].as<int>() != 2
          || strcmp(sample["id"] | "", deviceId) != 0
          || !sample["q"].is<uint64_t>()) {
        Serial.println(F("SPIFFS: Discarding incompatible legacy/corrupt line."));
        continue;
      }

      const uint64_t sequence = sample["q"].as<uint64_t>();
      if (sequence <= lastSequence) {
        Serial.println(F("SPIFFS: Discarding out-of-order line."));
        continue;
      }

      JsonObject point = points.add<JsonObject>();
      for (JsonPair pair : sample.as<JsonObject>()) {
        const char* key = pair.key().c_str();
        if (strcmp(key, "v") != 0 && strcmp(key, "id") != 0) {
          point[key] = pair.value();
        }
      }
      lastSequence = sequence;
    }
    file.close();

    if (migratedLeadingEvent) {
      if (!discardOfflineLines(
            SPIFFS_TELEMETRY_LOG_PATH, SPIFFS_TELEMETRY_TMP_PATH,
            consumedLines)) return false;
      continue;
    }

    if (sendLeadingLegacyTelemetry) {
      if (!sendTelemetry(LEGACY_TELEMETRY_PATH, legacyTelemetryDoc, false)) {
        return false;
      }
      if (!discardOfflineLines(
            SPIFFS_TELEMETRY_LOG_PATH, SPIFFS_TELEMETRY_TMP_PATH,
            consumedLines)) return false;
      requestsSent++;
      Serial.println(F("SPIFFS: Legacy telemetry accepted by v1 endpoint."));
      continue;
    }

    if (points.size() == 0) {
      if (!discardOfflineLines(
            SPIFFS_TELEMETRY_LOG_PATH, SPIFFS_TELEMETRY_TMP_PATH,
            consumedLines)) return false;
      continue;
    }

    batchDoc["q"] = lastSequence;
    if (measureJson(batchDoc) > OFFLINE_BATCH_MAX_BYTES) {
      Serial.println(F("SPIFFS: Batch exceeded configured byte ceiling."));
      return false;
    }
    if (!sendTelemetry(TELEMETRY_BATCH_PATH, batchDoc, false)) return false;
    if (!discardOfflineLines(
          SPIFFS_TELEMETRY_LOG_PATH, SPIFFS_TELEMETRY_TMP_PATH,
          consumedLines)) return false;
    requestsSent++;
    Serial.printf("SPIFFS: Batch accepted (%u samples, q=%llu).\n",
                  (unsigned int)points.size(), (unsigned long long)lastSequence);
#else
    File file = SPIFFS.open(SPIFFS_TELEMETRY_LOG_PATH, FILE_READ);
    if (!file) return false;
    String line = file.readStringUntil('\n');
    file.close();
    line.trim();
    if (!line.length()) {
      if (!discardOfflineLines(
            SPIFFS_TELEMETRY_LOG_PATH, SPIFFS_TELEMETRY_TMP_PATH, 1)) return false;
      continue;
    }
    StaticJsonDocument<1024> doc;
    if (deserializeJson(doc, line)) {
      if (!discardOfflineLines(
            SPIFFS_TELEMETRY_LOG_PATH, SPIFFS_TELEMETRY_TMP_PATH, 1)) return false;
      continue;
    }
    const char* legacyEventPath = safetyEventPathFor(doc);
    if (legacyEventPath) {
      if (!spiffsLogRequest(legacyEventPath, line)) return false;
      if (!discardOfflineLines(
            SPIFFS_TELEMETRY_LOG_PATH, SPIFFS_TELEMETRY_TMP_PATH, 1)) return false;
      continue;
    }
    if (!sendTelemetry(TELEMETRY_PATH, doc, false)) return false;
    if (!discardOfflineLines(
          SPIFFS_TELEMETRY_LOG_PATH, SPIFFS_TELEMETRY_TMP_PATH, 1)) return false;
    requestsSent++;
#endif
  }
  return true;
}

bool spiffsFlush() {
#if USE_WIFI_UPLINK
  if (!trustedWifi.connected()
      && !(ENABLE_CELLULAR_FALLBACK && netState == NetState::ONLINE)) return false;
#else
  if (netState != NetState::ONLINE) return false;
#endif

  if (!spiffsHasPendingRequests()) {
    Serial.println(F("SPIFFS: No offline requests to flush."));
    return true;
  }

  Serial.println(F("SPIFFS: Flushing offline requests to cloud..."));
  uint8_t requestsSent = 0;
  if (!flushOfflineEvents(requestsSent)) return false;
  if (requestsSent < OFFLINE_BATCH_MAX_REQUESTS
      && !flushOfflineTelemetry(requestsSent)) return false;
  // The telemetry pass can migrate records written by older firmware.
  if (requestsSent < OFFLINE_BATCH_MAX_REQUESTS
      && !flushOfflineEvents(requestsSent)) return false;

  const bool complete = !spiffsHasPendingRequests();
  Serial.println(complete
    ? F("SPIFFS: Flush complete.")
    : F("SPIFFS: Flush paused; remaining backlog will retry soon."));
  return complete;
}

// ============================================================================
//  UTILITIES
// ============================================================================

bool isVehicleMoving() {
  const bool gpsMoving = gpsFix && gpsSpeed >= 3.0f;
  const bool imuMoving = imuCalibrated
                      && (fabsf(atotal - 9.80665f) > 1.5f || gtotal > 0.5f);
  return gpsMoving || imuMoving;
}

uint32_t currentHeartbeatIntervalMs() {
#if USE_SIGNED_TELEMETRY_V2
  uint32_t adaptiveInterval = HEARTBEAT_DISARMED_STATIONARY_MS;
  if (crashStage == CrashStage::CONFIRMED) {
    adaptiveInterval = HEARTBEAT_INCIDENT_MS;
  } else {
  const bool armed = armState != ArmState::DISARMED;
  if (armed) {
    adaptiveInterval = isVehicleMoving()
      ? HEARTBEAT_ARMED_MOVING_MS
      : HEARTBEAT_ARMED_STATIONARY_MS;
  } else {
    adaptiveInterval = isVehicleMoving()
      ? HEARTBEAT_DISARMED_MOVING_MS
      : HEARTBEAT_DISARMED_STATIONARY_MS;
  }
  }
  return min<uint32_t>(adaptiveInterval, HEARTBEAT_MAX_INTERVAL_MS);
#else
  return HEARTBEAT_INTERVAL_MS;
#endif
}

float readBatteryVoltage() {
  int raw = analogRead(PIN_BATT_SENSE);
  float voltage = ((float)raw / ADC_RESOLUTION) * ADC_REF_VOLTAGE * VOLTAGE_DIVIDER_RATIO;
  return voltage;
}

void soundBuzzer(uint32_t durationMs) {
  digitalWrite(PIN_BUZZER, HIGH);
  delay(durationMs);
  digitalWrite(PIN_BUZZER, LOW);
}

void checkPowerCut() {
  if (!battSenseEnabled) {
    // Bench mode: no 12V divider wired to D0. Keep voltage unavailable rather
    // than fabricating a healthy battery value or firing a false power-cut.
    mainBatteryVoltage = NAN;
    return;
  }

  mainBatteryVoltage = readBatteryVoltage();

  if (mainBatteryVoltage < BATT_CUTOFF_VOLTAGE && !powerCutAlertSent) {
    // Main battery likely snipped — running on LiPo backup
    powerCutAlertSent = true;

    StaticJsonDocument<256> alertDoc;
    alertDoc["device_id"] = deviceId;
    alertDoc["event"]     = "POWER_CUT";
    alertDoc["vbat"]      = mainBatteryVoltage;
    alertDoc["timestamp"] = millis();

    sendTelemetry(POWERCUT_PATH, alertDoc);
    Serial.println(F("[ALERT] Power cut detected! On backup battery."));
    soundBuzzer(3000); // 3-second alarm
  }
}
