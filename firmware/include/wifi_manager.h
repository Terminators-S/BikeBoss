#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>

#if USE_WIFI_UPLINK
#include <WiFi.h>

class TrustedWifiManager {
 public:
  void begin(Preferences& preferences);
  void loop();
  bool connected() const;
  bool hasProfiles() const;
  const char* currentProfileId() const;
  const char* currentLabel() const;
  uint32_t appliedRevision() const;
  void reconnectNow();
  void scanNow();
  void printStatus() const;
  bool applyEncryptedSync(JsonObjectConst payload, const char* signingKeyHex);

 private:
  struct Profile {
    String id;
    String label;
    String ssid;
    String password;
    uint8_t priority = 50;
    uint32_t version = 1;
    uint8_t failures = 0;
    uint32_t cooldownUntil = 0;
  };

  enum class State : uint8_t { IDLE, SCANNING, CONNECTING, ONLINE };
  static constexpr uint8_t MAX_PROFILES = 8;
  Profile profiles_[MAX_PROFILES];
  uint8_t profileCount_ = 0;
  int8_t currentIndex_ = -1;
  int8_t candidateIndex_ = -1;
  State state_ = State::IDLE;
  Preferences* preferences_ = nullptr;
  uint32_t revision_ = 0;
  uint32_t stateSince_ = 0;
  uint32_t nextScanAt_ = 0;
  uint32_t connectedSince_ = 0;
  bool clockSyncRequested_ = false;

  void loadPersisted();
  bool savePersisted();
  void addBootstrapProfile();
  void startScan();
  void finishScan(int count);
  void startConnect(int index);
  void connectionFailed();
  int bestVisibleProfile(int scanCount) const;
  static bool timeReached(uint32_t now, uint32_t target);
};

extern TrustedWifiManager trustedWifi;
#endif
