# BikeBoss — Hardware Pinout (Bench Build)

> Verified 2026-08-08: IMU calibrated, Wi-Fi telemetry HTTP 200, A7670G AT link proven, external L76K NMEA detected, and the supplied T-A7670G R2 pinout identifies exposed GPIO22.

**Boards:**
- Seeed **XIAO ESP32-S3** — main MCU (COM7)
- LilyGO **T-A7670G + L76K** — A7670G 4G modem plus separate GPS module (COM12, own USB power)
- **MPU6050** — 6-axis IMU (I2C)

---

## XIAO ESP32-S3 pin assignments

| XIAO pin | GPIO | Direction | Connects to | Purpose |
|---|---|---|---|---|
| D0 | GPIO1 | ADC IN | *(bench: unconnected)* | 12V battery divider sense (install phase) |
| D1 | GPIO2 | OUT | Relay signal | Engine immobilizer (HIGH = cut) |
| D2 | GPIO3 | UART2 **RX** | LilyGO R2 header GPIO22 (`22 / Wire_SCL`) | L76K GPS NMEA at 9600 baud |
| D3 | GPIO4 | OUT | Piezo buzzer + | Local alarm |
| D4 | GPIO5 | I2C SDA | MPU6050 SDA | IMU data |
| D5 | GPIO6 | I2C SCL | MPU6050 SCL | IMU clock |
| D6 | GPIO43 | UART1 **RX** | LilyGO GPIO27 (A7670G TX) | Modem data in |
| D7 | GPIO44 | UART1 **TX** | LilyGO GPIO26 (A7670G RX) | Modem data out |
| 3V3 | — | PWR | MPU6050 VCC | IMU power |
| GND | — | PWR | MPU6050 GND + LilyGO GND | **Common ground (required)** |
| USB-C | — | PWR | PC (COM7) | XIAO power + flash + serial monitor |

## MPU6050 IMU (I2C @ 0x68)

| MPU6050 pin | → XIAO |
|---|---|
| VCC | 3V3 |
| GND | GND |
| SDA | D4 |
| SCL | D5 |
| AD0 | GND (→ address 0x68) |

## LilyGO T-A7670G modem + external GPS

The LilyGO GPIO labels are from its onboard ESP32's point of view. The A7670G
itself has **no internal GNSS**; GPS-equipped boards include a separate L76K.

| LilyGO pin | → XIAO | Note |
|---|---|---|
| GPIO27 (controller RX / A7670G TX) | D6 (RX1) | modem → XIAO |
| GPIO26 (controller TX / A7670G RX) | D7 (TX1) | XIAO → modem |
| ESP32 IO22 (controller RX / L76K TX) | D2 (RX2) | R2 right-side header pin marked `22 / Wire_SCL`; GPS NMEA tap |
| GND | GND | must be common with XIAO |
| GPIO4 / GPIO5 | — | no wires; PWRKEY/reset controlled by LilyGO helper firmware |
| USB-C | own 5V source | use a supply capable of at least 2A peak |

The `modem-test/` helper runs on the LilyGO onboard ESP32. It powers the A7670G,
wakes the L76K on GPIO19, and releases GPIO26/GPIO27 so the XIAO owns modem UART.

GPIO22 is an **onboard ESP32 pin**, not an A7670G modem pin. The supplied
T-A7670G R2 pinout exposes it on the right-side header, directly below GND and
above GPIO21, with the board label `22 / Wire_SCL`. On this revision it can be
tapped to XIAO D2 while the LilyGO controller also listens to the L76K. A helper
relay remains the fallback for a different board revision.

⚠️ Attach the active GPS antenna to the separate **L76K module's** antenna
connector—not an unused GNSS socket on the A7670G. `ANTENNA OPEN` in COM12
output means the L76K is alive but is not electrically seeing its antenna.

## Power

- **Two USB-C cables**: one → XIAO (COM7), one → LilyGO (COM12)
- **GND must be shared** between XIAO and LilyGO
- Modem/common wires: GPIO27→D6, GPIO26→D7, GND→GND
- R2 GPS tap: right-side header `22 / Wire_SCL` → XIAO D2

## Serial ports (Windows)

| Port | Device | Use |
|---|---|---|
| COM7 | XIAO ESP32-S3 | BikeBoss flash + serial monitor (115200 baud) |
| COM12 | LilyGO onboard ESP32 | modem power-helper / L76K diagnostic output |

⚠️ **Uploads need an explicit port:** BikeBoss firmware uses COM7; the LilyGO helper uses COM12.

⚠️ **Only one tool holds a COM port at a time** — close its serial monitor before uploading.

## Memory hook

**A7670: 27→D6 and 26→D7. R2 GPS header 22→D2. Grounds always meet.**
