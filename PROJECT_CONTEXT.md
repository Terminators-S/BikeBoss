# BIKEBOSS: THE COMPLETE PROJECT STORY & TECHNICAL SPECIFICATION

---

## 1. Executive Vision & Origin Story

In rapidly growing urban hubs across Southeast Asia—such as Phnom Penh—motorcycles are the primary engine of daily life, commerce, and personal transport. However, motorcycle owners face two severe, persistent threats:

1. **Pervasive Vehicle Theft:** Hotwiring, master-key bypasses, and physical "van-lift" thefts occur in seconds, leaving vehicle owners with zero real-time recovery tools.
2. **High-Risk Traffic Accidents:** Violent collisions frequently occur on unlit rural highways or busy city avenues at night. When a solo rider goes down, delayed medical emergency response due to lack of automatic crash notifications can prove fatal.

Existing aftermarket GPS trackers are expensive, bulky, require intrusive modifications to factory wiring, and rely on clunky, subscription-heavy third-party mobile apps that users rarely open.

**BikeBoss** was conceived to eliminate these friction points. It is an end-to-end IoT motorcycle security, life-saving telemetry, and keyless access ecosystem. It combines low-cost edge hardware, serverless cloud infrastructure, and a friction-free user interface built directly inside **Telegram as a Mini App (TMA)**.

---

## 2. System Architecture Overview

The BikeBoss architecture spans three distinct execution layers: the Hardware Edge, the Serverless Cloud, and the Telegram Client Ecosystem.

```text
===================================================================================================
                                      BIKEBOSS ARCHITECTURE
===================================================================================================

 [ HARDWARE EDGE NODE ]            [ SERVERLESS CLOUD MESH ]         [ FRONTEND CLIENT STACK ]
 (On-Motorcycle Unit)             (Cloudflare Infrastructure)        (Telegram Ecosystem)

 +-----------------------+        +-------------------------+        +-------------------------+
 | Seeed XIAO ESP32-S3   |        | Cloudflare Workers      |        | Telegram Mini App       |
 | (Dual-Core 240MHz)    |        | (Serverless API Engine) |        | (React / Web UI)        |
 +-----------+-----------+        +------------+------------+        +------------+------------+
             |                                 |                              |
             | I2C Bus                         | HTTPS REST / MQTT            | Webhook / API
             v                                 v                              v
 +-----------------------+        +-------------------------+        +-------------------------+
 | MPU6050 6-Axis IMU    |        | Cloudflare D1 Database  |        | Telegram Bot API        |
 | (100Hz Motion Filter) |        | (Serverless SQLite DB)  |        | (Push Notifications)    |
 +-----------------------+        +-------------------------+        +-------------------------+
             |                                 |                              |
             | UART Serial                     | HTTP Webhooks                | Native BLE
             v                                 v                              v
 +-----------------------+        +-------------------------+        +-------------------------+
 | SIMCom A7670E Modem   |        | ABA PayWay Gateway      |        | Foreground Service      |
 | (4G LTE / GNSS / Wi-Fi|        | (KHQR Payment Invoices) |        | (Background BLE Scanner)|
 +-----------------------+        +-------------------------+        +-------------------------+
             |
             | High-Power Relay
             v
 +-----------------------+
 | Engine Immobilizer    |
 | (Parallel SCU Tap)    |
 +-----------------------+

```

---

## 3. Hardware Ecosystem & Physical Layer

### Master Component Selection

| Component | Selected Part | Functional Role | Specification & Protocol |
| --- | --- | --- | --- |
| **Microcontroller** | Seeed Studio XIAO ESP32-S3 | Edge Compute, BLE Advertiser, State Machine | Dual-core Xtensa LX7 @ 240MHz, 8MB PSRAM, 8MB Flash, Vector Instructions for TinyML |
| **Cellular & Location** | SIMCom A7670E | 4G Telemetry, GNSS GPS, Wi-Fi BSSID Scanner | Hardware UART (115200 baud), LTE Cat-1, Multi-constellation GNSS |
| **Motion Sensor** | MPU6050 | Crash Detection, Vibration, Orientation Sensing | 3-Axis Gyroscope + 3-Axis Accelerometer via Hardware I2C |
| **Actuator Relay** | 5V Optocoupled Relay Module | Engine Immobilization & Smart Key Control | Single-pole high-current relay driven by ESP32-S3 GPIO |
| **Power Regulation** | DC-DC Buck Converter | Vehicle Voltage Step-down | Converts 12V-14.4V motorcycle battery input down to a clean 5.0V DC rail |
| **Backup Power** | 3.7V 800mAh LiPo Battery | Power-Cut Security Reservoir | Automatically powers the unit if main motorcycle battery wires are snipped |

### Physical Hardware Pinout Matrix

```text
                     +---------------------------------------+
                     |    SEEED STUDIO XIAO ESP32-S3 PINS    |
                     +-------------------+-------------------+
                                         |
         +-------------------------------+-------------------------------+
         |                               |                               |
         v                               v                               v
   [ PIN D4 / D5 ]                 [ PIN D6 / D7 ]                 [ PIN D1 ]
   Hardware I2C                    Hardware UART1                  GPIO Output
         |                               |                               |
         v                               v                               v
 +---------------+               +---------------+               +---------------+
 | MPU6050 IMU   |               | SIMCom A7670E |               | 5V Relay      |
 | SDA = D4      |               | TX = D6 (RX1) |               | Signal = D1   |
 | SCL = D5      |               | RX = D7 (TX1) |               | (High = Cut)  |
 +---------------+               +---------------+               +---------------+

```

### Motorcycle Integration Modes

1. **Universal Mode (Direct Ignition Intercept):**
   - Installed in series with the main ignition switch (ACC line).
   - Activating the relay breaks the circuit, physically preventing engine start.

2. **Modern Scooter Mode (Solenoid Parallel Override):**
   - Designed for keyless smart-key vehicles (e.g., Honda PCX, Click, Yamaha Aerox).
   - Does **not** cut ECU lines. Instead, the relay wires in parallel across the ignition rotary selector knob solenoid.
   - Sending an unlock command injects 12V into the solenoid, allowing the rider to turn the dial without searching for their physical factory key fob.

---

## 4. Software Architecture & Monorepo Structure

```text
bikeboss-project/
├── PROJECT_CONTEXT.md          # Architecture specs & prompt context for AI tools
├── firmware/                   # PlatformIO Embedded C++ Project
│   ├── platformio.ini          # ESP32-S3 board configs & library dependencies
│   └── src/
│       └── main.cpp            # 100Hz MPU6050 loop, AT driver, state machine
└── backend/                    # Cloudflare Serverless Project
    ├── wrangler.toml           # Environment bindings & worker settings
    ├── schema.sql              # Cloudflare D1 database schema
    └── src/
        └── index.js            # Telemetry receiver, Geofence worker, Telegram bot
```

### Firmware Execution Design (ESP32-S3)

- **Non-Blocking Architecture:** Uses `millis()` state timers instead of `delay()` to maintain a strict 100Hz sampling rate on the MPU6050 sensor engine.
- **AT-Command Modem Driver:** Custom serial wrapper handles SIMCom A7670E network attachment, HTTP POST telemetry dispatches, and raw GNSS parsing asynchronously.

### Serverless Cloud Backend (Cloudflare)

- **Workers Engine:** Edge microservices handle data ingestion, calculate geofences, and process Telegram webhooks with zero cold-start latency.
- **D1 Relational Database:** Serverless SQLite database managing user profiles, vehicle states, incident records, and KHQR payment invoices.

---

## 5. Algorithmic Specifications & Mathematical Models

### A. Keyless Proximity Unlock (BLE 5.0)

The ESP32-S3 advertises a secure BLE beacon. The user's phone measures signal strength (RSSI). To filter out radio interference, raw values pass through an **Exponential Moving Average (EMA) Filter**:

```
RSSI_smoothed = (α * RSSI_new) + ((1 - α) * RSSI_old)
```

Where α = 0.2. An unlock is triggered when RSSI_smoothed ≥ -55 dBm.

### B. Geofencing Engine (The Haversine Formula)

When armed, the cloud backend records an anchor point (lat1, lon1). For every incoming telemetry packet (lat2, lon2), the worker calculates the great-circle distance d:

```
d = 2R * arcsin(√(sin²(Δlat/2) + cos(lat1) * cos(lat2) * sin²(Δlon/2)))
```

Where earth radius R = 6,371,000 meters. A breach alert fires if d > 100 meters AND reported vehicle speed ≥ 0.5 km/h.

### C. 3-Stage Crash Detection Engine

```text
[ STAGE 1: Impact Force ]    -->    [ STAGE 2: Rotation ]    -->    [ STAGE 3: Vehicle Orientation ]
Atotal > 19.6 m/s² (~2.0G)          Gtotal > 2.1 rad/sec            Wait 3s -> Z-Axis Gravity < 3.0 m/s²
```

1. **Impact Check:** Atotal = √(Ax² + Ay² + Az²) > 19.6 m/s²
2. **Rotation Check:** Gtotal = √(Gx² + Gy² + Gz²) > 2.1 rad/sec
3. **Flatness Verification:** Waits 3s. If |Az| < 3.0 m/s², motorcycle is lying flat → confirmed CRASH event dispatched.

---

## 6. The Hybrid AI Strategy

```text
+-----------------------------------------------------------------------------------+
|                            BIKEBOSS HYBRID AI ARCHITECTURE                        |
+-----------------------------------------+-----------------------------------------+
| EDGE AI (On-Bike / ESP32-S3)            | CLOUD AI (Serverless / Cloudflare)      |
+-----------------------------------------+-----------------------------------------+
| - Framework: TinyML via Edge Impulse    | - Framework: Cloudflare Workers AI      |
| - Execution: Local C++ library on MCU   | - Execution: Asynchronous GPU inference |
| - Processing: Live 100Hz IMU wave forms | - Processing: Database trip history     |
| - Task: Crash vs. Pothole Classifier    | - Task: Predictive Battery Diagnostics  |
| - Latency: < 15ms (100% Offline)        | - Task: Driver Safety & Eco Scoring     |
+-----------------------------------------+-----------------------------------------+
```

---

## 7. Edge Cases, Failures & Resilience Engineering

| Edge Case Scenario | System Vulnerability | Hardware/Software Mitigation |
| --- | --- | --- |
| **"Through-the-Wall" BLE Unlock** | Phone sitting near a wall close to the parked bike triggers unlock. | Requiring physical movement: Even if BLE unlocks, ignition dial must be turned within 10 seconds or system auto-relocks. |
| **Van-Lift Theft (GPS Blocked)** | Bike loaded inside a metal van; GPS signal drops to zero. | If GPS signal becomes invalid BUT accelerometer senses continuous driving vibrations, push a "Motion with Signal Loss" alert. |
| **Underground Garage Dead Zone** | No 4G connection inside basement parking lots. | **Cloud Heartbeat Timeout:** If server misses pings for > 10 mins while armed, Telegram notifies user of connection loss. |
| **Main Battery Snipped** | Thief cuts 12V motorcycle battery wires. | System switches to 3.7V internal LiPo backup battery and sends a high-priority "Power-Cut Alert" before going to low-power tracking mode. |
| **Telco SMS Network Block** | Cellcard AO Data SIM ($10/yr) blocks outgoing SMS. | Network communication uses 4G LTE MQTT/HTTP. On connection loss, data logs to SPIFFS flash memory, and local piezoceramic buzzer sounds locally. |

---

## 8. Business & SaaS Monetization Strategy

### Unit Economics

- **Hardware Bill of Materials (BOM) Cost:** ~$22.00 - $25.00 USD
- **Annual Telco Data Allowance (Cellcard AO Data):** $10.00 USD / year (365-day validity)
- **Customer Subscription Renewal Price:** $15.00 USD / year
- **Net Profit Margin:** $5.00 USD annual recurring profit per user on software services alone.

### Automated Payment Workflow (Telegram Mini App)

1. The Telegram Mini App prompts the user 14 days prior to subscription expiration.
2. The user clicks "Extend Connectivity ($15/Year)".
3. Cloudflare Worker requests a dynamic KHQR Code from the ABA PayWay API.
4. The user approves payment in their local banking app (ABA Mobile / Bakong).
5. ABA fires an automated HTTP webhook to Cloudflare Workers, which validates the cryptographic signature and extends the vehicle's active status in the D1 database for 365 days.