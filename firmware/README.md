# BikeBoss Firmware

Edge firmware for the Seeed XIAO ESP32-S3 on-bike unit: 100 Hz IMU crash detection, BLE proximity unlock, SIMCom A7670E 4G/GNSS telemetry, engine immobilizer relay.

## Requirements

- [PlatformIO](https://platformio.org/) (VS Code extension or CLI)
- Seeed XIAO ESP32-S3 board
- MPU6050 IMU (I2C), SIMCom A7670E modem (UART), 5V relay, buzzer

## Wiring

| Peripheral | MCU Pin | Notes |
|---|---|---|
| MPU6050 SDA | D4 | I2C @ 400 kHz |
| MPU6050 SCL | D5 | |
| A7670E TX | D6 (RX1) | 115200 baud |
| A7670E RX | D7 (TX1) | |
| Relay signal | D1 | HIGH = cut ignition |
| Buzzer | D3 | Local alarm |
| Battery sense | D0 | ADC, 10k/4.7k divider from 12V rail |
| Modem PWRKEY | D2 | 1.2 s pulse to power on |

## Build & flash

```bash
pio run                 # build
pio run -t upload       # flash over USB
pio device monitor -b 115200
```

## Configure

Edit `include/config.h` before flashing:

| Setting | What to change |
|---|---|
| `DEVICE_ID` | Unique per unit, matches backend (`BB-00000001`) |
| `CLOUD_HOST` | Your deployed Worker hostname |
| `MODEM_APN` | SIM APN (Cellcard default included) |
| `INSTALL_MODE` | `0` universal ignition cut · `1` scooter solenoid pulse |
| Thresholds | Crash/BLE/battery tuning |

## Serial debug commands

Open the monitor and type:

| Key | Action |
|---|---|
| `a` | Arm (relay cut) |
| `d` | Disarm (relay release) |
| `g` | Print current GPS fix |
| `s` | Full status dump |
| `f` | Flush SPIFFS offline log to cloud |

## Bench bring-up order

1. **IMU only** — comment out modem init; verify 100 Hz sampling with `s`
2. **Crash engine** — shake the unit: Stage 1 → Stage 2 → lay flat 3 s → CONFIRMED
3. **Modem** — attach network, check `AT+CSQ`, get GNSS fix outdoors
4. **Telemetry** — heartbeat POST reaches `/api/v1/heartbeat` (watch `wrangler tail`)
5. **BLE** — phone app writes RSSI; verify EMA unlock at ≥ −55 dBm
6. **Relay/buzzer/ADC** — arm/disarm clicks, power-cut alert on <11 V

## Known TODOs

- Non-blocking AT state machine (current HTTP POST blocks up to ~10 s)
- OTA update support
- TinyML crash-vs-pothole classifier (Edge Impulse) replacing threshold stages
- Deep-sleep power budget for parked mode
