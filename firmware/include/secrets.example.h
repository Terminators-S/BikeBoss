#ifndef BIKEBOSS_SECRETS_H
#define BIKEBOSS_SECRETS_H

// Copy to secrets.h and fill in local bench values. secrets.h is gitignored.
#define WIFI_SSID     "your-2.4ghz-wifi"
#define WIFI_PASSWORD "your-wifi-password"
// Friendly owner-facing alias only. Do not repeat the raw SSID here.
#define WIFI_NETWORK_LABEL "Home Wi-Fi"

// 32-byte per-device key derived during factory provisioning. Never use the
// Worker master secret here. Enable USE_SIGNED_TELEMETRY_V2 only after this
// device's credential row is activated in D1.
#define DEVICE_SIGNING_KEY_HEX "64-lowercase-hex-characters"

#endif // BIKEBOSS_SECRETS_H
