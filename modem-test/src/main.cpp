/**
 * LilyGO T-A7670G bench helper for BikeBoss.
 *
 * The LilyGO board contains its own ESP32. That ESP32 must assert the modem's
 * POWER_ON / RESET / PWRKEY signals, but the XIAO ESP32-S3 is the BikeBoss
 * controller and must be the only device driving the modem UART.
 *
 * This helper powers the A7670G, then leaves GPIO26/GPIO27 as high-impedance
 * inputs so the externally wired XIAO can own those two UART nets.
 */

#include <Arduino.h>

#define BOARD_PWRKEY_PIN   4
#define BOARD_POWERON_PIN  12
#define MODEM_RESET_PIN    5

#define SerialMon  Serial
#define MODEM_CONTROLLER_TX_NET  26 // controller TX -> A7670G RX
#define MODEM_CONTROLLER_RX_NET  27 // A7670G TX -> controller RX
#define GPS_CONTROLLER_TX_PIN    21 // controller TX -> external L76K RX
#define GPS_CONTROLLER_RX_PIN    22 // external L76K TX -> controller RX
#define GPS_WAKEUP_PIN           19

HardwareSerial externalGps(2);
String gpsLine;
uint32_t gpsByteCount = 0;
uint32_t lastAntennaWarning = 0;

static void modemPowerOn()
{
    pinMode(BOARD_POWERON_PIN, OUTPUT);
    digitalWrite(BOARD_POWERON_PIN, HIGH);
    delay(500);

    pinMode(MODEM_RESET_PIN, OUTPUT);
    digitalWrite(MODEM_RESET_PIN, LOW);
    delay(100);
    digitalWrite(MODEM_RESET_PIN, HIGH);

    pinMode(BOARD_PWRKEY_PIN, OUTPUT);
    digitalWrite(BOARD_PWRKEY_PIN, LOW);
    delay(100);
    digitalWrite(BOARD_PWRKEY_PIN, HIGH);
    delay(1000);
    digitalWrite(BOARD_PWRKEY_PIN, LOW);
}

static void releaseModemUart()
{
    pinMode(MODEM_CONTROLLER_TX_NET, INPUT);
    pinMode(MODEM_CONTROLLER_RX_NET, INPUT);
}

void setup()
{
    SerialMon.begin(115200);
    delay(300);
    SerialMon.println();
    SerialMon.println(F("=== BIKEBOSS LILYGO MODEM POWER HELPER ==="));
    releaseModemUart();
    modemPowerOn();
    releaseModemUart();

    // A7670G has no internal GNSS. GPS-equipped bundles add an L76K module
    // on GPIO21/22; wake and inspect that independent UART here.
    pinMode(GPS_WAKEUP_PIN, OUTPUT);
    digitalWrite(GPS_WAKEUP_PIN, HIGH);
    externalGps.begin(9600, SERIAL_8N1, GPS_CONTROLLER_RX_PIN, GPS_CONTROLLER_TX_PIN);

    SerialMon.println(F("A7670G power sequence complete."));
    SerialMon.println(F("GPIO26/GPIO27 released; XIAO now owns modem UART."));
    SerialMon.println(F("External L76K GPS probe active on RX=GPIO22 / TX=GPIO21."));
}

void loop()
{
    while (externalGps.available()) {
        char c = (char)externalGps.read();
        gpsByteCount++;
        if (c == '\r' || c == '\n') {
            if (gpsLine.length()) {
                const bool isRmc = gpsLine.startsWith("$GNRMC")
                                || gpsLine.startsWith("$GPRMC");
                const bool antennaWarning = gpsLine.indexOf("ANTENNA") >= 0;
                if (isRmc || (antennaWarning && millis() - lastAntennaWarning >= 10000)) {
                    SerialMon.printf("[L76K] %s\r\n", gpsLine.c_str());
                    if (antennaWarning) lastAntennaWarning = millis();
                }
                gpsLine = "";
            }
        } else if (gpsLine.length() < 160) {
            gpsLine += c;
        }
    }

    static uint32_t lastStatus = 0;
    if (millis() - lastStatus >= 10000) {
        lastStatus = millis();
        SerialMon.printf("[HELPER] Modem powered; external GPS bytes=%lu.\r\n",
                         (unsigned long)gpsByteCount);
    }
}
