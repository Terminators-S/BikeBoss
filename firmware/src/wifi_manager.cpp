#include "config.h"
#include "wifi_manager.h"

#if USE_WIFI_UPLINK

#include <mbedtls/gcm.h>
#include <mbedtls/md.h>
#include <vector>

TrustedWifiManager trustedWifi;

namespace {
constexpr uint32_t CONNECT_TIMEOUT_MS = 12000UL;
constexpr uint32_t OFFLINE_SCAN_INTERVAL_MS = 30000UL;
constexpr uint32_t ONLINE_SCAN_INTERVAL_MS = 300000UL;
constexpr uint32_t MINIMUM_DWELL_MS = 120000UL;
constexpr int ROAM_GAIN_DB = 12;
constexpr char CONFIG_KEY_CONTEXT[] = "bikeboss:wifi-profile:v1";

bool hexKeyToBytes(const char* value, uint8_t output[32]) {
  if (!value || strlen(value) != 64) return false;
  for (size_t index = 0; index < 32; index++) {
    char pair[3] = {value[index * 2], value[index * 2 + 1], '\0'};
    char* end = nullptr;
    const long byte = strtol(pair, &end, 16);
    if (!end || *end != '\0' || byte < 0 || byte > 255) return false;
    output[index] = static_cast<uint8_t>(byte);
  }
  return true;
}

bool hmacSha256(const uint8_t* key, size_t keyLength,
                const uint8_t* data, size_t dataLength, uint8_t output[32]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  return info && mbedtls_md_hmac(info, key, keyLength, data, dataLength, output) == 0;
}

int base64Value(char character) {
  if (character >= 'A' && character <= 'Z') return character - 'A';
  if (character >= 'a' && character <= 'z') return character - 'a' + 26;
  if (character >= '0' && character <= '9') return character - '0' + 52;
  if (character == '-' || character == '+') return 62;
  if (character == '_' || character == '/') return 63;
  return -1;
}

bool decodeBase64Url(const String& input, std::vector<uint8_t>& output) {
  output.clear();
  uint32_t accumulator = 0;
  uint8_t bits = 0;
  for (size_t index = 0; index < input.length(); index++) {
    const char character = input[index];
    if (character == '=') break;
    const int value = base64Value(character);
    if (value < 0) return false;
    accumulator = (accumulator << 6) | static_cast<uint32_t>(value);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push_back(static_cast<uint8_t>((accumulator >> bits) & 0xff));
    }
  }
  return true;
}

bool decryptProfile(JsonArrayConst envelope, const char* signingKeyHex,
                    String& id, uint32_t& version, JsonDocument& profile) {
  if (envelope.size() != 5) return false;
  id = envelope[0].as<String>();
  version = envelope[1] | 0;
  const uint32_t keyVersion = envelope[2] | 0;
  const String nonceEncoded = envelope[3].as<String>();
  const String ciphertextEncoded = envelope[4].as<String>();
  if (id.length() < 8 || id.length() > 64 || version < 1 || keyVersion != 1) return false;

  uint8_t signingKey[32] = {0};
  uint8_t configKey[32] = {0};
  if (!hexKeyToBytes(signingKeyHex, signingKey)) return false;
  if (!hmacSha256(signingKey, sizeof(signingKey),
                  reinterpret_cast<const uint8_t*>(CONFIG_KEY_CONTEXT),
                  strlen(CONFIG_KEY_CONTEXT), configKey)) return false;

  std::vector<uint8_t> nonce;
  std::vector<uint8_t> sealed;
  if (!decodeBase64Url(nonceEncoded, nonce) || nonce.size() != 12
      || !decodeBase64Url(ciphertextEncoded, sealed) || sealed.size() <= 16) return false;
  const size_t cipherLength = sealed.size() - 16;
  std::vector<uint8_t> plaintext(cipherLength + 1, 0);
  const String aad = String(DEVICE_ID) + "|" + id + "|" + String(version)
                   + "|" + String(keyVersion);

  mbedtls_gcm_context context;
  mbedtls_gcm_init(&context);
  const int keyResult = mbedtls_gcm_setkey(
    &context, MBEDTLS_CIPHER_ID_AES, configKey, sizeof(configKey) * 8);
  const int decryptResult = keyResult == 0 ? mbedtls_gcm_auth_decrypt(
    &context,
    cipherLength,
    nonce.data(), nonce.size(),
    reinterpret_cast<const uint8_t*>(aad.c_str()), aad.length(),
    sealed.data() + cipherLength, 16,
    sealed.data(), plaintext.data()) : keyResult;
  mbedtls_gcm_free(&context);
  if (decryptResult != 0) return false;
  return deserializeJson(profile, plaintext.data(), cipherLength) == DeserializationError::Ok;
}
}  // namespace

bool TrustedWifiManager::timeReached(uint32_t now, uint32_t target) {
  return static_cast<int32_t>(now - target) >= 0;
}

void TrustedWifiManager::begin(Preferences& preferences) {
  preferences_ = &preferences;
  loadPersisted();
  addBootstrapProfile();
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false);
  state_ = State::IDLE;
  stateSince_ = millis();
  nextScanAt_ = millis();
  Serial.printf("[WIFI] Trusted connection manager ready with %u profile(s).\n",
                static_cast<unsigned>(profileCount_));
}

void TrustedWifiManager::loadPersisted() {
  profileCount_ = 0;
  revision_ = preferences_ ? preferences_->getULong("wifi_rev", 0) : 0;
  const String stored = preferences_ ? preferences_->getString("wifi_json", "") : "";
  if (stored.isEmpty()) return;
  JsonDocument document;
  if (deserializeJson(document, stored)) {
    Serial.println(F("[WIFI] Stored profile set is unreadable; bootstrap remains available."));
    return;
  }
  for (JsonObjectConst item : document["p"].as<JsonArrayConst>()) {
    if (profileCount_ >= MAX_PROFILES) break;
    const String ssid = item["s"].as<String>();
    if (ssid.isEmpty()) continue;
    Profile& profile = profiles_[profileCount_++];
    profile.id = item["i"].as<String>();
    profile.label = item["l"].as<String>();
    profile.ssid = ssid;
    profile.password = item["w"].as<String>();
    profile.priority = constrain(item["p"] | 50, 1, 100);
    profile.version = item["v"] | 1;
  }
}

bool TrustedWifiManager::savePersisted() {
  if (!preferences_) return false;
  JsonDocument document;
  JsonArray items = document["p"].to<JsonArray>();
  for (uint8_t index = 0; index < profileCount_; index++) {
    const Profile& profile = profiles_[index];
    if (profile.id == "bootstrap") continue;
    JsonObject item = items.add<JsonObject>();
    item["i"] = profile.id;
    item["l"] = profile.label;
    item["s"] = profile.ssid;
    item["w"] = profile.password;
    item["p"] = profile.priority;
    item["v"] = profile.version;
  }
  String serialized;
  serializeJson(document, serialized);
  return preferences_->putString("wifi_json", serialized) == serialized.length()
      && preferences_->putULong("wifi_rev", revision_) > 0;
}

void TrustedWifiManager::addBootstrapProfile() {
  if (WIFI_SSID[0] == '\0') return;
  for (uint8_t index = 0; index < profileCount_; index++) {
    if (profiles_[index].ssid == WIFI_SSID) return;
  }
  if (profileCount_ >= MAX_PROFILES) return;
  Profile& profile = profiles_[profileCount_++];
  profile.id = "bootstrap";
  profile.label = WIFI_NETWORK_LABEL[0] == '\0' ? "Bootstrap Wi-Fi" : WIFI_NETWORK_LABEL;
  profile.ssid = WIFI_SSID;
  profile.password = WIFI_PASSWORD;
  profile.priority = 50;
}

void TrustedWifiManager::startScan() {
  if (profileCount_ == 0 || WiFi.scanComplete() == WIFI_SCAN_RUNNING) return;
  WiFi.scanDelete();
  const int result = WiFi.scanNetworks(true, true);
  if (result == WIFI_SCAN_FAILED) {
    nextScanAt_ = millis() + OFFLINE_SCAN_INTERVAL_MS;
    return;
  }
  state_ = State::SCANNING;
  stateSince_ = millis();
  Serial.println(F("[WIFI] Scanning for trusted 2.4 GHz networks..."));
}

int TrustedWifiManager::bestVisibleProfile(int scanCount) const {
  int bestIndex = -1;
  float bestScore = -1000.0f;
  const uint32_t now = millis();
  for (int network = 0; network < scanCount; network++) {
    for (uint8_t profileIndex = 0; profileIndex < profileCount_; profileIndex++) {
      const Profile& profile = profiles_[profileIndex];
      if (profile.ssid != WiFi.SSID(network) || !timeReached(now, profile.cooldownUntil)) continue;
      const float score = static_cast<float>(WiFi.RSSI(network))
                        + static_cast<float>(profile.priority) * 0.15f;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = profileIndex;
      }
    }
  }
  return bestIndex;
}

void TrustedWifiManager::finishScan(int count) {
  const bool wasConnected = WiFi.status() == WL_CONNECTED && currentIndex_ >= 0;
  const int bestIndex = bestVisibleProfile(count);
  Serial.printf("[WIFI] Scan complete: %d visible, trusted candidate=%d.\n", count, bestIndex);
  if (wasConnected) {
    state_ = State::ONLINE;
    if (bestIndex >= 0 && bestIndex != currentIndex_
        && millis() - connectedSince_ >= MINIMUM_DWELL_MS) {
      int candidateRssi = -127;
      for (int network = 0; network < count; network++) {
        if (WiFi.SSID(network) == profiles_[bestIndex].ssid) {
          candidateRssi = max(candidateRssi, WiFi.RSSI(network));
        }
      }
      if (candidateRssi >= WiFi.RSSI() + ROAM_GAIN_DB) startConnect(bestIndex);
    }
  } else if (bestIndex >= 0) {
    startConnect(bestIndex);
  } else {
    state_ = State::IDLE;
    currentIndex_ = -1;
    nextScanAt_ = millis() + OFFLINE_SCAN_INTERVAL_MS;
  }
  WiFi.scanDelete();
}

void TrustedWifiManager::startConnect(int index) {
  if (index < 0 || index >= profileCount_) return;
  candidateIndex_ = index;
  WiFi.disconnect(false, false);
  const Profile& profile = profiles_[index];
  WiFi.begin(profile.ssid.c_str(), profile.password.c_str());
  state_ = State::CONNECTING;
  stateSince_ = millis();
  Serial.printf("[WIFI] Connecting with trusted profile \"%s\"...\n", profile.label.c_str());
}

void TrustedWifiManager::connectionFailed() {
  if (candidateIndex_ >= 0 && candidateIndex_ < profileCount_) {
    Profile& profile = profiles_[candidateIndex_];
    profile.failures = min<uint8_t>(profile.failures + 1, 5);
    profile.cooldownUntil = millis() + min<uint32_t>(
      300000UL, 15000UL << (profile.failures - 1));
    Serial.printf("[WIFI] Profile \"%s\" failed; cooldown=%lu ms.\n",
                  profile.label.c_str(),
                  static_cast<unsigned long>(profile.cooldownUntil - millis()));
  }
  WiFi.disconnect(false, false);
  candidateIndex_ = -1;
  currentIndex_ = -1;
  state_ = State::IDLE;
  nextScanAt_ = millis() + 1000UL;
}

void TrustedWifiManager::loop() {
  const uint32_t now = millis();
  if (state_ == State::CONNECTING) {
    if (WiFi.status() == WL_CONNECTED) {
      currentIndex_ = candidateIndex_;
      candidateIndex_ = -1;
      Profile& profile = profiles_[currentIndex_];
      profile.failures = 0;
      profile.cooldownUntil = 0;
      state_ = State::ONLINE;
      connectedSince_ = now;
      nextScanAt_ = now + ONLINE_SCAN_INTERVAL_MS;
      if (!clockSyncRequested_) {
        configTime(0, 0, "pool.ntp.org", "time.google.com");
        clockSyncRequested_ = true;
      }
      Serial.printf("[WIFI] Online via \"%s\" IP=%s RSSI=%d dBm.\n",
                    profile.label.c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else if (now - stateSince_ >= CONNECT_TIMEOUT_MS) {
      connectionFailed();
    }
    return;
  }
  if (state_ == State::SCANNING) {
    const int result = WiFi.scanComplete();
    if (result >= 0) finishScan(result);
    else if (result == WIFI_SCAN_FAILED && now - stateSince_ > 15000UL) {
      state_ = connected() ? State::ONLINE : State::IDLE;
      nextScanAt_ = now + OFFLINE_SCAN_INTERVAL_MS;
    }
    return;
  }
  if (state_ == State::ONLINE && WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[WIFI] Link lost; searching trusted profiles."));
    currentIndex_ = -1;
    state_ = State::IDLE;
    nextScanAt_ = now + 1000UL;
  }
  if (timeReached(now, nextScanAt_)) startScan();
}

bool TrustedWifiManager::connected() const {
  return currentIndex_ >= 0 && WiFi.status() == WL_CONNECTED;
}

bool TrustedWifiManager::hasProfiles() const { return profileCount_ > 0; }

const char* TrustedWifiManager::currentProfileId() const {
  return connected() ? profiles_[currentIndex_].id.c_str() : "";
}

const char* TrustedWifiManager::currentLabel() const {
  return connected() ? profiles_[currentIndex_].label.c_str() : "";
}

uint32_t TrustedWifiManager::appliedRevision() const { return revision_; }

void TrustedWifiManager::reconnectNow() {
  for (uint8_t index = 0; index < profileCount_; index++) {
    profiles_[index].failures = 0;
    profiles_[index].cooldownUntil = 0;
  }
  WiFi.disconnect(false, false);
  currentIndex_ = -1;
  candidateIndex_ = -1;
  state_ = State::IDLE;
  nextScanAt_ = millis();
}

void TrustedWifiManager::scanNow() {
  nextScanAt_ = millis();
  if (state_ == State::IDLE || state_ == State::ONLINE) startScan();
}

void TrustedWifiManager::printStatus() const {
  Serial.printf("[WIFI] connected=%d state=%u profiles=%u revision=%lu RSSI=%d label=\"%s\"\n",
                connected(), static_cast<unsigned>(state_), static_cast<unsigned>(profileCount_),
                static_cast<unsigned long>(revision_), connected() ? WiFi.RSSI() : 0,
                currentLabel());
}

bool TrustedWifiManager::applyEncryptedSync(JsonObjectConst payload,
                                            const char* signingKeyHex) {
  const uint32_t nextRevision = payload["r"] | 0;
  const JsonArrayConst encryptedProfiles = payload["p"].as<JsonArrayConst>();
  if (nextRevision < revision_ || encryptedProfiles.size() > MAX_PROFILES) return false;
  Profile nextProfiles[MAX_PROFILES];
  uint8_t nextCount = 0;
  for (JsonArrayConst envelope : encryptedProfiles) {
    JsonDocument decrypted;
    String profileId;
    uint32_t profileVersion = 0;
    if (!decryptProfile(envelope, signingKeyHex, profileId, profileVersion, decrypted)) {
      Serial.println(F("[WIFI] Encrypted profile authentication failed."));
      return false;
    }
    const String ssid = decrypted["ssid"].as<String>();
    const String label = decrypted["label"].as<String>();
    const String password = decrypted["password"].as<String>();
    const int priority = decrypted["priority"] | 50;
    if (ssid.isEmpty() || ssid.length() > 32 || label.isEmpty()
        || (password.length() > 0 && (password.length() < 8 || password.length() > 63))
        || priority < 1 || priority > 100) return false;
    Profile& profile = nextProfiles[nextCount++];
    profile.id = profileId;
    profile.label = label;
    profile.ssid = ssid;
    profile.password = password;
    profile.priority = priority;
    profile.version = profileVersion;
  }
  profileCount_ = nextCount;
  for (uint8_t index = 0; index < nextCount; index++) profiles_[index] = nextProfiles[index];
  revision_ = nextRevision;
  addBootstrapProfile();
  if (!savePersisted()) {
    Serial.println(F("[WIFI] Failed to persist synchronized profiles."));
    return false;
  }
  Serial.printf("[WIFI] Applied encrypted profile revision %lu (%u profile(s)).\n",
                static_cast<unsigned long>(revision_), static_cast<unsigned>(profileCount_));
  reconnectNow();
  return true;
}

#endif
