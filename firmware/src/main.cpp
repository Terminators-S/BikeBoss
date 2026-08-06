/**
 * =============================================================================
 * BikeBoss Edge Firmware — Seeed XIAO ESP32-S3
 * =============================================================================
 *
 * Non-blocking, 100 Hz IMU loop with:
 *   - 3-Stage Crash Detection Engine
 *   - AT-Command SIMCom A7670E modem driver (4G LTE / GNSS / HTTP)
 *   - BLE 5.0 proximity beacon (EMA-filtered RSSI unlock)
 *   - Engine immobilizer relay control (GPIO D1)
 *   - Telemetry heartbeat dispatch to Cloudflare Workers
 *   - SPIFFS offline log buffer on network loss
 *   - LiPo backup power-cut detection
 *
 * Pinout:
 *   D4 (SDA) / D5 (SCL) — I2C  → MPU6050
 *   D6 (RX1) / D7 (TX1) — UART → SIMCom A7670E
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

#include "config.h"

// ============================================================================
//  CONSTANTS & PIN DEFINITIONS
// ============================================================================

// --- Hardware Pins (Seeed XIAO ESP32-S3) ---
#define PIN_RELAY          D1    // Engine immobilizer relay (HIGH = cut)
#define PIN_BUZZER         D3    // Piezo buzzer
#define PIN_BATT_SENSE     D0    // ADC for 12V battery voltage divider
#define PIN_MODEM_PWR      D2    // SIMCom A7670E power-key control

// --- I2C ---
#define I2C_SDA             D4
#define I2C_SCL             D5

// --- UART (Modem) ---
#define SERIAL_AT           Serial1  // Hardware UART1 on D6(RX)/D7(TX)

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
//   SPIFFS_LOG_PATH, MAX_SPIFFS_LOG_SIZE, DEVICE_ID, CLOUD_*

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
uint32_t crashStageEnter = 0;

// --- IMU ---
float ax = 0.0f, ay = 0.0f, az = 0.0f;  // acceleration (m/s²)
float gx = 0.0f, gy = 0.0f, gz = 0.0f;  // gyroscope (rad/s)
float atotal = 0.0f, gtotal = 0.0f;

// --- Crash Engine ---
CrashStage crashStage = CrashStage::IDLE;
bool crashDispatched = false;

// --- Arm State ---
ArmState armState = ArmState::DISARMED;
uint32_t pendingUnlockStart = 0;

// --- BLE ---
float rssiSmoothed = -100.0f;
bool bleClientConnected = false;

// --- Geofence ---
bool  geofenceActive = false;
float geofenceAnchorLat = 0.0f;
float geofenceAnchorLon = 0.0f;

// --- Modem ---
NetState netState = NetState::OFF;
char gpsNmea[256] = {0};
float gpsLat = 0.0f, gpsLon = 0.0f, gpsSpeed = 0.0f;
bool  gpsFix = false;

// --- Battery ---
float mainBatteryVoltage = 13.8f;
bool  powerCutAlertSent = false;

// --- Device Identity ---
char deviceId[32] = DEVICE_ID; // From include/config.h — provision per unit

// ============================================================================
//  FORWARD DECLARATIONS
// ============================================================================

// --- IMU ---
void imuInit();
void imuSample();
void crashDetectionPipeline();

// --- Modem ---
void modemInit();
void modemLoop();
void modemSendAT(const char* cmd);
bool modemWaitOK(const char* cmd, uint32_t timeoutMs = 2000);
void modemSendTelemetry(const char* path, const JsonDocument& doc);
void modemParseGNSS();

// --- BLE ---
void bleInit();
void bleUpdateRssi();

// --- Relay ---
void relayImmobilize();
void relayRelease();
void relayPulseSolenoid();

// --- Telemetry ---
void buildTelemetryPayload(JsonDocument& doc);
void sendHeartbeat();
void sendCrashAlert();

// --- Persistence ---
void spiffsInit();
void spiffsLog(const char* line);
void spiffsFlush();

// --- Utilities ---
float readBatteryVoltage();
void soundBuzzer(uint32_t durationMs);
void handleBleUnlock();
void handleBleAutoRelock();
void checkPowerCut();

// ============================================================================
//  SETUP
// ============================================================================

void setup() {
  // --- Serial Debug ---
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n\n=== BikeBoss Edge Firmware Boot ==="));

  // --- GPIO ---
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, LOW);   // Start with relay released (engine enabled)
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_MODEM_PWR, OUTPUT);
  digitalWrite(PIN_MODEM_PWR, LOW);

  // Analog read resolution
  analogReadResolution(12);       // 12-bit ADC on ESP32-S3

  // --- I2C ---
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);          // 400 kHz Fast I2C

  // --- SPIFFS ---
  spiffsInit();

  // --- IMU ---
  imuInit();

  // --- BLE ---
  bleInit();

  // --- Modem ---
  modemInit();

  // --- Ready ---
  Serial.println(F("BikeBoss: Initialization complete."));
  soundBuzzer(100); // short beep = booted

  // --- Initialize timers ---
  lastImuTick   = millis();
  lastHeartbeat = millis();
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

  // ---------------------------------------------------------------
  // 2. Modem State Machine (asynchronous AT command processing)
  // ---------------------------------------------------------------
  modemLoop();

  // ---------------------------------------------------------------
  // 3. Heartbeat Telemetry (every 30s)
  // ---------------------------------------------------------------
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
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
      case 'g': // Get GPS
        modemParseGNSS();
        Serial.printf("[CMD] GPS: lat=%.6f lon=%.6f fix=%d\n", gpsLat, gpsLon, gpsFix);
        break;
      case 's': // Status dump
        Serial.printf("[STATUS] Arm=%d Crash=%d Net=%d Vbat=%.2fV\n",
                      (int)armState, (int)crashStage, (int)netState, mainBatteryVoltage);
        Serial.printf("[STATUS] IMU: atot=%.2f gtot=%.2f az=%.2f\n", atotal, gtotal, az);
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
  Serial.print(F("IMU: Initializing MPU6050... "));
  mpu.initialize();
  if (!mpu.testConnection()) {
    Serial.println(F("FAILED! Check I2C wiring."));
    // Blink pattern to indicate IMU failure
    while (1) {
      soundBuzzer(200);
      delay(1000);
    }
  }
  // Configure: ±8G accelerometer, ±1000 deg/s gyro
  mpu.setFullScaleAccelRange(MPU6050_ACCEL_FS_8);
  mpu.setFullScaleGyroRange(MPU6050_GYRO_FS_1000);
  // Digital low-pass filter: 44 Hz cutoff (good for crash detection)
  mpu.setDLPFMode(MPU6050_DLPF_BW_44);
  Serial.println(F("OK."));
}

void imuSample() {
  // Read raw sensor data
  int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;
  mpu.getMotion6(&rawAx, &rawAy, &rawAz, &rawGx, &rawGy, &rawGz);

  // Convert to physical units
  // ±8G range: 4096 LSB/g, 1g = 9.81 m/s²
  const float accelScale = (8.0f * 9.81f) / 32768.0f;
  ax = (float)rawAx * accelScale;
  ay = (float)rawAy * accelScale;
  az = (float)rawAz * accelScale;

  // ±1000 deg/s range: 32.8 LSB/(deg/s) → rad/s = deg/s * π/180
  const float gyroScale  = (1000.0f * PI) / (32768.0f * 180.0f);
  gx = (float)rawGx * gyroScale;
  gy = (float)rawGy * gyroScale;
  gz = (float)rawGz * gyroScale;

  // Compute magnitude vectors
  atotal = sqrtf(ax * ax + ay * ay + az * az);
  gtotal = sqrtf(gx * gx + gy * gy + gz * gz);
}

// ============================================================================
//  3-STAGE CRASH DETECTION ENGINE
// ============================================================================

void crashDetectionPipeline() {
  uint32_t now = millis();

  switch (crashStage) {

    // --- IDLE: waiting for impact ---
    case CrashStage::IDLE:
      if (atotal > CRASH_IMPACT_THRESHOLD) {
        crashStage = CrashStage::IMPACT_DETECTED;
        crashStageEnter = now;
        Serial.printf("[CRASH] Stage 1: Impact! Atotal=%.2f m/s²\n", atotal);
      }
      break;

    // --- STAGE 1: Impact detected → check rotation ---
    case CrashStage::IMPACT_DETECTED:
      if (gtotal > CRASH_ROTATION_THRESHOLD) {
        crashStage = CrashStage::ROTATION_DETECTED;
        crashStageEnter = now;
        Serial.printf("[CRASH] Stage 2: Rotation! Gtotal=%.2f rad/s\n", gtotal);
      }
      // Timeout: if no rotation within 500ms, false alarm (pothole)
      else if (now - crashStageEnter > 500) {
        crashStage = CrashStage::IDLE;
        Serial.println(F("[CRASH] False alarm — impact only, resetting."));
      }
      break;

    // --- STAGE 2: Rotation detected → wait for stabilization ---
    case CrashStage::ROTATION_DETECTED:
      crashStage = CrashStage::STABILIZING;
      crashStageEnter = now;
      Serial.println(F("[CRASH] Stage 3: Waiting for stabilization..."));
      break;

    // --- STAGE 3: Wait 3s, then check if bike is flat ---
    case CrashStage::STABILIZING:
      if (now - crashStageEnter >= CRASH_STABILIZATION_MS) {
        // After 3s, check if Z-axis gravity is near zero (bike on side)
        if (fabsf(az) < CRASH_FLAT_Z_THRESHOLD) {
          crashStage = CrashStage::CONFIRMED;
          Serial.printf("[CRASH] CONFIRMED! Az=%.2f m/s² — bike is down.\n", az);
          sendCrashAlert();
          soundBuzzer(5000); // 5-second local alarm
          crashDispatched = true;
        } else {
          // Bike upright — false alarm
          crashStage = CrashStage::IDLE;
          Serial.printf("[CRASH] False alarm — bike upright (Az=%.2f). Resetting.\n", az);
        }
      }
      break;

    // --- CONFIRMED: hold state until system reset ---
    case CrashStage::CONFIRMED:
      // Keep sending crash alerts every 10 seconds until acknowledged
      if (now - crashStageEnter > 10000) {
        crashStageEnter = now;
        sendCrashAlert();
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
    Serial.println(F("[BLE] Client connected."));
  }
  void onDisconnect(BLEServer* pServer) override {
    bleClientConnected = false;
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
//  MODEM — SIMCom A7670E AT Driver (TinyGSM + Custom AT)
// ============================================================================

void modemInit() {
  Serial.print(F("Modem: Powering on SIMCom A7670E... "));
  netState = NetState::POWERING_ON;

  // Pulse PWRKEY for ~1.2s to turn on modem
  digitalWrite(PIN_MODEM_PWR, HIGH);
  delay(1200);
  digitalWrite(PIN_MODEM_PWR, LOW);

  // Give modem time to boot
  delay(3000);

  // Initialize serial
  SERIAL_AT.begin(MODEM_BAUD, SERIAL_8N1, D6, D7);
  Serial.println(F("OK. UART1 ready."));

  // Initialize TinyGSM
  netState = NetState::INITIALIZING;
  Serial.print(F("Modem: Initializing TinyGSM... "));
  if (!modem.init()) {
    Serial.println(F("FAILED. Check modem power & wiring."));
    netState = NetState::ERROR;
    return;
  }
  Serial.println(F("OK."));

  // Wait for network registration
  netState = NetState::REGISTERING;
  Serial.print(F("Modem: Registering on network... "));
  if (!modem.waitForNetwork(30000L)) {
    Serial.println(F("FAILED. No network."));
    netState = NetState::ERROR;
    return;
  }
  Serial.println(F("OK. Online."));

  // Enable GNSS
  Serial.print(F("Modem: Enabling GNSS... "));
  modemSendAT("AT+CGNSSPWR=1");
  modemWaitOK("AT+CGNSSPWR=1", 5000);
  Serial.println(F("OK."));

  netState = NetState::ONLINE;
  Serial.println(F("Modem: Ready."));
}

void modemLoop() {
  // TinyGSM maintains its own state — we just poll for incoming data
  // and feed it to the AT parser.
  if (netState == NetState::ONLINE) {
    // Parse any incoming GNSS NMEA sentences
    while (SERIAL_AT.available()) {
      String line = SERIAL_AT.readStringUntil('\n');
      if (line.startsWith("$GNRMC") || line.startsWith("$GPGGA")) {
        line.toCharArray(gpsNmea, sizeof(gpsNmea));
        modemParseGNSS();
      }
    }
  }
}

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

void modemParseGNSS() {
  // Parse GNRMC sentence for lat/lon/speed
  // Minimal parser — in production use TinyGPS++ or full NMEA parser
  // Format: $GNRMC,time,status,lat,N,lon,E,speed,course,date,,,mode*cs
  char* token = strtok(gpsNmea, ",");
  int field = 0;
  while (token != NULL) {
    switch (field) {
      case 2: // Status: A=Valid, V=Invalid
        gpsFix = (token[0] == 'A');
        break;
      case 3: // Latitude
        gpsLat = atof(token);
        break;
      case 5: // Longitude
        gpsLon = atof(token);
        break;
      case 7: // Speed (knots → km/h)
        gpsSpeed = atof(token) * 1.852f;
        break;
    }
    token = strtok(NULL, ",");
    field++;
  }
}

// ============================================================================
//  TELEMETRY — Cloudflare Worker Dispatch
// ============================================================================

void buildTelemetryPayload(JsonDocument& doc) {
  doc["device_id"] = deviceId;
  doc["timestamp"] = millis();
  doc["arm_state"]  = (uint8_t)armState;

  // GPS
  JsonObject gps = doc.createNestedObject("gps");
  gps["lat"]   = gpsLat;
  gps["lon"]   = gpsLon;
  gps["speed"] = gpsSpeed;
  gps["fix"]   = gpsFix;

  // IMU
  JsonObject imu = doc.createNestedObject("imu");
  imu["ax"] = ax;
  imu["ay"] = ay;
  imu["az"] = az;
  imu["gx"] = gx;
  imu["gy"] = gy;
  imu["gz"] = gz;
  imu["atotal"] = atotal;
  imu["gtotal"] = gtotal;

  // Battery
  doc["vbat"] = mainBatteryVoltage;

  // Crash status
  doc["crash_stage"] = (uint8_t)crashStage;
  doc["crash_confirmed"] = (crashStage == CrashStage::CONFIRMED);

  // Geofence
  doc["geofence_active"] = geofenceActive;
  if (geofenceActive) {
    doc["geofence_anchor_lat"] = geofenceAnchorLat;
    doc["geofence_anchor_lon"] = geofenceAnchorLon;
  }
}

void modemSendTelemetry(const char* path, const JsonDocument& doc) {
  if (netState != NetState::ONLINE) {
    // Offline — buffer to SPIFFS
    String buf;
    serializeJson(doc, buf);
    spiffsLog(buf.c_str());
    Serial.println(F("[TELEM] Offline — buffered to SPIFFS."));
    return;
  }

  String payload;
  serializeJson(doc, payload);

  Serial.printf("[TELEM] POST %s (%d bytes)\n", path, payload.length());

  // Build HTTP POST via TinyGSM
  // Note: TinyGSM client requires explicit connection calls
  // In production, use modem.sendAT() with raw AT+HTTPPARA/AT+HTTPACTION
  // for the SIMCom A7670E's built-in HTTP stack for reliability.

  // --- Fallback: AT-command-based HTTP POST ---
  modemSendAT("AT+HTTPINIT");
  modemWaitOK("AT+HTTPINIT");

  String cidCmd = "AT+HTTPPARA=\"CID\",1";
  modemSendAT(cidCmd.c_str());
  modemWaitOK(cidCmd.c_str());

  String urlCmd = "AT+HTTPPARA=\"URL\",\"https://" + String(CLOUD_HOST) + String(path) + "\"";
  modemSendAT(urlCmd.c_str());
  modemWaitOK(urlCmd.c_str());

  String contentType = "AT+HTTPPARA=\"CONTENT\",\"application/json\"";
  modemSendAT(contentType.c_str());
  modemWaitOK(contentType.c_str());

  String dataCmd = "AT+HTTPDATA=" + String(payload.length()) + ",10000";
  modemSendAT(dataCmd.c_str());
  delay(200);
  SERIAL_AT.print(payload);
  modemWaitOK("", 10000);

  modemSendAT("AT+HTTPACTION=1");
  // Response is +HTTPACTION: 1,200,<len> or similar
  delay(2000);

  modemSendAT("AT+HTTPTERM");
  modemWaitOK("AT+HTTPTERM");
}

void sendHeartbeat() {
  telemetryDoc.clear();
  buildTelemetryPayload(telemetryDoc);
  modemSendTelemetry(HEARTBEAT_PATH, telemetryDoc);
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
  imu["atotal"] = atotal;
  imu["gtotal"] = gtotal;
  imu["az"]     = az;

  modemSendTelemetry(CRASH_PATH, crashDoc);
}

// ============================================================================
//  SPIFFS — Offline Log Buffer
// ============================================================================

void spiffsInit() {
  if (!SPIFFS.begin(true)) {
    Serial.println(F("SPIFFS: Mount failed!"));
    return;
  }
  Serial.printf("SPIFFS: Mounted. Total=%d Used=%d\n",
                SPIFFS.totalBytes(), SPIFFS.usedBytes());
}

void spiffsLog(const char* line) {
  File f = SPIFFS.open(SPIFFS_LOG_PATH, FILE_APPEND);
  if (!f) {
    Serial.println(F("SPIFFS: Failed to open log file."));
    return;
  }
  // Check size — if exceeded, rotate
  if (f.size() > MAX_SPIFFS_LOG_SIZE) {
    f.close();
    SPIFFS.remove(SPIFFS_LOG_PATH);
    f = SPIFFS.open(SPIFFS_LOG_PATH, FILE_APPEND);
  }
  f.println(line);
  f.close();
}

void spiffsFlush() {
  if (netState != NetState::ONLINE) return;

  File f = SPIFFS.open(SPIFFS_LOG_PATH, FILE_READ);
  if (!f || f.size() == 0) {
    if (f) f.close();
    Serial.println(F("SPIFFS: No offline data to flush."));
    return;
  }

  Serial.println(F("SPIFFS: Flushing offline log to cloud..."));
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() > 0) {
      // Re-send each buffered telemetry packet
      StaticJsonDocument<1024> doc;
      DeserializationError err = deserializeJson(doc, line);
      if (!err) {
        modemSendTelemetry(TELEMETRY_PATH, doc);
        delay(500); // rate-limit flush
      }
    }
  }
  f.close();

  // Clear the offline log
  SPIFFS.remove(SPIFFS_LOG_PATH);
  Serial.println(F("SPIFFS: Flush complete."));
}

// ============================================================================
//  UTILITIES
// ============================================================================

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
  mainBatteryVoltage = readBatteryVoltage();

  if (mainBatteryVoltage < BATT_CUTOFF_VOLTAGE && !powerCutAlertSent) {
    // Main battery likely snipped — running on LiPo backup
    powerCutAlertSent = true;

    StaticJsonDocument<256> alertDoc;
    alertDoc["device_id"] = deviceId;
    alertDoc["event"]     = "POWER_CUT";
    alertDoc["vbat"]      = mainBatteryVoltage;
    alertDoc["timestamp"] = millis();

    modemSendTelemetry(POWERCUT_PATH, alertDoc);
    Serial.println(F("[ALERT] Power cut detected! On backup battery."));
    soundBuzzer(3000); // 3-second alarm
  }
}