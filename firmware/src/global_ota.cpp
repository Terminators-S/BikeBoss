#include "global_ota.h"
#include "config.h"

#if ENABLE_GLOBAL_OTA

#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <esp_ota_ops.h>
#include <mbedtls/base64.h>
#include <mbedtls/md.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>
#include <memory>

#include "cloud_root_ca.h"
#include "ota_release_public_key.h"

namespace {
constexpr uint32_t HEALTH_CONFIRM_MS = 15000UL;
constexpr uint32_t OFFER_SETTLE_MS = 1000UL;
constexpr size_t MAX_FIRMWARE_BYTES = 0x330000;
constexpr char PREFERENCE_PENDING[] = "ota_pending";
constexpr char PREFERENCE_COMMAND[] = "ota_cmd";
constexpr char PREFERENCE_RELEASE[] = "ota_release";
constexpr char PREFERENCE_BUILD[] = "ota_build";
constexpr char PREFERENCE_VERSION[] = "ota_version";

struct Offer {
  bool pending = false;
  uint32_t commandId = 0;
  String releaseId;
  String version;
  uint32_t buildNumber = 0;
  String board;
  size_t sizeBytes = 0;
  String sha256Hex;
  String signatureBase64;
  String path;
  bool allowCellular = false;
  uint64_t requestSequence = 0;
  uint32_t receivedAt = 0;
};

Preferences* preferences = nullptr;
Offer offer;
bool inProgress = false;
bool bootVerificationPending = false;
uint32_t bootVerificationStartedAt = 0;
uint32_t acknowledgementCommandId = 0;
bool acknowledgementApplied = false;
GlobalOtaCellularDownloader cellularDownloader = nullptr;

bool decodeHex(const String& value, uint8_t* output, size_t length) {
  if (value.length() != length * 2) return false;
  for (size_t index = 0; index < length; index++) {
    const char pair[3] = { value[index * 2], value[index * 2 + 1], '\0' };
    char* end = nullptr;
    const long parsed = strtol(pair, &end, 16);
    if (!end || *end != '\0' || parsed < 0 || parsed > 255) return false;
    output[index] = static_cast<uint8_t>(parsed);
  }
  return true;
}

String bytesToHex(const uint8_t* bytes, size_t length) {
  static constexpr char digits[] = "0123456789abcdef";
  String result;
  result.reserve(length * 2);
  for (size_t index = 0; index < length; index++) {
    result += digits[(bytes[index] >> 4) & 0x0f];
    result += digits[bytes[index] & 0x0f];
  }
  return result;
}

String base64Url(const uint8_t* bytes, size_t length) {
  static constexpr char alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  String output;
  output.reserve(((length + 2) / 3) * 4);
  for (size_t index = 0; index < length; index += 3) {
    const uint32_t chunk = (static_cast<uint32_t>(bytes[index]) << 16)
      | ((index + 1 < length ? bytes[index + 1] : 0) << 8)
      | (index + 2 < length ? bytes[index + 2] : 0);
    output += alphabet[(chunk >> 18) & 0x3f];
    output += alphabet[(chunk >> 12) & 0x3f];
    if (index + 1 < length) output += alphabet[(chunk >> 6) & 0x3f];
    if (index + 2 < length) output += alphabet[chunk & 0x3f];
  }
  return output;
}

bool signRequestHeader(
  const char* method,
  const String& path,
  uint64_t sequence,
  String& value
) {
  uint8_t signingKey[32] = {0};
  if (!decodeHex(DEVICE_SIGNING_KEY_HEX, signingKey, sizeof(signingKey))) return false;
  const time_t now = time(nullptr);
  if (now < 1704067200) return false;

  uint8_t emptyHash[32] = {0};
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info || mbedtls_md(info, nullptr, 0, emptyHash) != 0) return false;

  String canonical = method;
  canonical += '\n';
  canonical += path;
  canonical += '\n';
  canonical += DEVICE_ID;
  canonical += '\n';
  canonical += String(static_cast<unsigned long>(now));
  canonical += '\n';
  char sequenceBuffer[24] = {0};
  snprintf(sequenceBuffer, sizeof(sequenceBuffer), "%llu",
    static_cast<unsigned long long>(sequence));
  canonical += sequenceBuffer;
  canonical += '\n';
  canonical += bytesToHex(emptyHash, sizeof(emptyHash));

  uint8_t signature[32] = {0};
  const int result = mbedtls_md_hmac(
    info,
    signingKey,
    sizeof(signingKey),
    reinterpret_cast<const uint8_t*>(canonical.c_str()),
    canonical.length(),
    signature
  );
  memset(signingKey, 0, sizeof(signingKey));
  if (result != 0) return false;
  value = String(static_cast<unsigned long>(now)) + "." + sequenceBuffer
    + ".1." + base64Url(signature, sizeof(signature));
  return true;
}

String canonicalRelease(const Offer& candidate) {
  String value = "bikeboss-ota-v1\n";
  value += candidate.releaseId;
  value += '\n';
  value += candidate.version;
  value += '\n';
  value += String(candidate.buildNumber);
  value += '\n';
  value += candidate.board;
  value += '\n';
  value += String(candidate.sizeBytes);
  value += '\n';
  value += candidate.sha256Hex;
  return value;
}

bool verifyReleaseSignature(const Offer& candidate) {
  if (BIKEBOSS_OTA_RELEASE_PUBLIC_KEY[0] == '\0') return false;
  String normalized = candidate.signatureBase64;
  normalized.replace('-', '+');
  normalized.replace('_', '/');
  while (normalized.length() % 4 != 0) normalized += '=';

  uint8_t signature[96] = {0};
  size_t signatureLength = 0;
  if (mbedtls_base64_decode(
      signature,
      sizeof(signature),
      &signatureLength,
      reinterpret_cast<const uint8_t*>(normalized.c_str()),
      normalized.length()) != 0) return false;

  const String canonical = canonicalRelease(candidate);
  uint8_t digest[32] = {0};
  if (mbedtls_sha256_ret(
      reinterpret_cast<const uint8_t*>(canonical.c_str()),
      canonical.length(),
      digest,
      0) != 0) return false;

  mbedtls_pk_context key;
  mbedtls_pk_init(&key);
  const int parseResult = mbedtls_pk_parse_public_key(
    &key,
    reinterpret_cast<const uint8_t*>(BIKEBOSS_OTA_RELEASE_PUBLIC_KEY),
    strlen(BIKEBOSS_OTA_RELEASE_PUBLIC_KEY) + 1
  );
  const int verifyResult = parseResult == 0
    ? mbedtls_pk_verify(
      &key, MBEDTLS_MD_SHA256, digest, sizeof(digest), signature, signatureLength)
    : parseResult;
  mbedtls_pk_free(&key);
  return verifyResult == 0;
}

void persistPending(const Offer& candidate) {
  if (!preferences) return;
  preferences->putBool(PREFERENCE_PENDING, true);
  preferences->putUInt(PREFERENCE_COMMAND, candidate.commandId);
  preferences->putString(PREFERENCE_RELEASE, candidate.releaseId);
  preferences->putUInt(PREFERENCE_BUILD, candidate.buildNumber);
  preferences->putString(PREFERENCE_VERSION, candidate.version);
}

void clearPersistedPending() {
  if (!preferences) return;
  preferences->remove(PREFERENCE_PENDING);
  preferences->remove(PREFERENCE_COMMAND);
  preferences->remove(PREFERENCE_RELEASE);
  preferences->remove(PREFERENCE_BUILD);
  preferences->remove(PREFERENCE_VERSION);
}

void queuePersistentAcknowledgement(bool applied) {
  if (!preferences) return;
  acknowledgementCommandId = preferences->getUInt(PREFERENCE_COMMAND, 0);
  acknowledgementApplied = applied;
}

bool downloadAndInstallWifi() {
  WiFiClientSecure secureClient;
  secureClient.setCACert(BIKEBOSS_CLOUD_ROOT_CA);
  HTTPClient http;
  const String url = String(CLOUD_SCHEME) + "://" + CLOUD_HOST + offer.path;
  if (!http.begin(secureClient, url)) return false;
  http.setTimeout(30000);
  String auth;
  if (!signRequestHeader("GET", offer.path, offer.requestSequence, auth)) {
    http.end();
    return false;
  }
  http.addHeader("X-BikeBoss-Auth", auth);
  const int status = http.GET();
  if (status != 200 || http.getSize() != static_cast<int>(offer.sizeBytes)) {
    Serial.printf("[GLOBAL-OTA] Download rejected: HTTP %d size=%d.\n",
      status, http.getSize());
    http.end();
    return false;
  }
  if (!Update.begin(offer.sizeBytes, U_FLASH)) {
    Serial.printf("[GLOBAL-OTA] Flash slot rejected: %s.\n", Update.errorString());
    http.end();
    return false;
  }

  mbedtls_sha256_context hash;
  mbedtls_sha256_init(&hash);
  mbedtls_sha256_starts_ret(&hash, 0);
  WiFiClient* stream = http.getStreamPtr();
  // Keep the streaming buffer on the heap. This path runs from the main loop,
  // where a 4 KB local array can collide with the TLS/HTTP call stack.
  std::unique_ptr<uint8_t[]> buffer(new (std::nothrow) uint8_t[4096]);
  if (!buffer) {
    Serial.println(F("[GLOBAL-OTA] Download buffer allocation failed."));
    http.end();
    Update.abort();
    return false;
  }
  size_t total = 0;
  uint32_t lastProgressAt = millis();
  bool ok = true;
  while (total < offer.sizeBytes) {
    const size_t available = stream->available();
    if (available == 0) {
      if (!http.connected() || millis() - lastProgressAt > 30000UL) {
        ok = false;
        break;
      }
      delay(5);
      continue;
    }
    const size_t wanted = min(static_cast<size_t>(4096),
      min(available, offer.sizeBytes - total));
    const int received = stream->readBytes(buffer.get(), wanted);
    if (received <= 0
        || Update.write(buffer.get(), static_cast<size_t>(received))
             != static_cast<size_t>(received)) {
      ok = false;
      break;
    }
    mbedtls_sha256_update_ret(&hash, buffer.get(), static_cast<size_t>(received));
    total += static_cast<size_t>(received);
    lastProgressAt = millis();
    yield();
  }

  uint8_t digest[32] = {0};
  mbedtls_sha256_finish_ret(&hash, digest);
  mbedtls_sha256_free(&hash);
  http.end();

  if (!ok || total != offer.sizeBytes || bytesToHex(digest, sizeof(digest)) != offer.sha256Hex) {
    Serial.println(F("[GLOBAL-OTA] Binary hash/length verification failed."));
    Update.abort();
    return false;
  }
  if (!Update.end(false)) {
    Serial.printf("[GLOBAL-OTA] Image activation failed: %s.\n", Update.errorString());
    return false;
  }
  return true;
}

bool downloadAndInstall(bool useCellular) {
  bool installed = false;
  if (useCellular) {
    String auth;
    if (!cellularDownloader
        || !signRequestHeader("GET", offer.path, offer.requestSequence, auth)) {
      return false;
    }
    Serial.println(F("[GLOBAL-OTA] Downloading over rider-approved 4G data."));
    installed = cellularDownloader(
      offer.path.c_str(), auth.c_str(), offer.sizeBytes, offer.sha256Hex.c_str());
  } else {
    Serial.println(F("[GLOBAL-OTA] Downloading over trusted Wi-Fi."));
    installed = downloadAndInstallWifi();
  }
  if (!installed) return false;
  persistPending(offer);
  Serial.println(F("[GLOBAL-OTA] Verified image installed; rebooting into trial slot."));
  delay(250);
  ESP.restart();
  return true;
}
}  // namespace

#ifdef CONFIG_APP_ROLLBACK_ENABLE
bool verifyRollbackLater() { return true; }
#endif

void globalOtaBegin(Preferences& devicePreferences) {
  preferences = &devicePreferences;
  if (!preferences->getBool(PREFERENCE_PENDING, false)) return;

  const uint32_t targetBuild = preferences->getUInt(PREFERENCE_BUILD, 0);
  if (targetBuild != FIRMWARE_BUILD) {
    Serial.printf("[GLOBAL-OTA] Trial build %lu rolled back; reporting failure.\n",
      static_cast<unsigned long>(targetBuild));
    queuePersistentAcknowledgement(false);
    return;
  }

  // Always survive the health window before acknowledging, even on Arduino
  // cores that expose the newly selected slot as VALID instead of PENDING_VERIFY.
  bootVerificationPending = true;
  bootVerificationStartedAt = millis();
  Serial.println(F("[GLOBAL-OTA] Trial image running; 15-second health confirmation pending."));
}

void globalOtaSetCellularDownloader(GlobalOtaCellularDownloader downloader) {
  cellularDownloader = downloader;
}

GlobalOtaOfferResult globalOtaOffer(
  uint32_t commandId,
  JsonVariantConst payload,
  uint64_t requestSequence
) {
  if (!payload.is<JsonObjectConst>()) return GlobalOtaOfferResult::REJECTED;
  const JsonObjectConst object = payload.as<JsonObjectConst>();
  Offer candidate;
  candidate.commandId = commandId;
  candidate.releaseId = object["r"] | "";
  candidate.version = object["v"] | "";
  candidate.buildNumber = object["n"] | 0;
  candidate.board = object["b"] | "";
  candidate.sizeBytes = object["z"] | 0;
  candidate.sha256Hex = object["h"] | "";
  candidate.signatureBase64 = object["s"] | "";
  candidate.path = object["p"] | "";
  const String transport = object["t"] | "wifi";
  candidate.allowCellular = transport == "any";
  candidate.requestSequence = requestSequence;
  candidate.receivedAt = millis();

  if (candidate.commandId == 0
      || candidate.releaseId.length() != 36
      || candidate.version.isEmpty()
      || candidate.buildNumber <= FIRMWARE_BUILD
      || candidate.board != FIRMWARE_BOARD
      || candidate.sizeBytes == 0 || candidate.sizeBytes > MAX_FIRMWARE_BYTES
      || candidate.sha256Hex.length() != 64
      || !candidate.path.startsWith("/api/v2/device/")
      || (transport != "wifi" && transport != "any")
      || !verifyReleaseSignature(candidate)) {
    Serial.println(F("[GLOBAL-OTA] Release offer rejected before download."));
    return GlobalOtaOfferResult::REJECTED;
  }
  offer = candidate;
  offer.pending = true;
  Serial.printf(
    "[GLOBAL-OTA] Release %s build %lu accepted; transport=%s, waiting for safe install.\n",
    offer.version.c_str(), static_cast<unsigned long>(offer.buildNumber),
    offer.allowCellular ? "wifi-preferred/4g-allowed" : "wifi-only");
  return GlobalOtaOfferResult::ACCEPTED;
}

void globalOtaLoop(
  bool wifiConnected,
  bool cellularConnected,
  bool safeToInstall,
  uint64_t requestSequence
) {
  if (bootVerificationPending && millis() - bootVerificationStartedAt >= HEALTH_CONFIRM_MS) {
    const esp_partition_t* running = esp_ota_get_running_partition();
    esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
    const esp_err_t stateResult = running
      ? esp_ota_get_state_partition(running, &state)
      : ESP_ERR_INVALID_STATE;
    const esp_err_t confirmResult = stateResult == ESP_OK
        && state == ESP_OTA_IMG_PENDING_VERIFY
      ? esp_ota_mark_app_valid_cancel_rollback()
      : ESP_OK;
    if (confirmResult == ESP_OK) {
      bootVerificationPending = false;
      queuePersistentAcknowledgement(true);
      Serial.println(F("[GLOBAL-OTA] Trial image marked valid; cloud acknowledgement queued."));
    }
  }
  const bool useCellular = !wifiConnected && offer.allowCellular
    && cellularConnected && cellularDownloader;
  if (!offer.pending || inProgress || (!wifiConnected && !useCellular) || !safeToInstall
      || millis() - offer.receivedAt < OFFER_SETTLE_MS) return;
  offer.requestSequence = requestSequence;
  inProgress = true;
  const bool installed = downloadAndInstall(useCellular);
  if (!installed) {
    acknowledgementCommandId = offer.commandId;
    acknowledgementApplied = false;
    offer.pending = false;
  }
  inProgress = false;
}

void globalOtaAppendFirmware(JsonDocument& document) {
  JsonArray firmware = document["f"].to<JsonArray>();
  firmware.add(FIRMWARE_BUILD);
  firmware.add(FIRMWARE_VERSION);
}

void globalOtaAppendAcknowledgement(JsonArray acknowledgements) {
  if (acknowledgementCommandId == 0) return;
  JsonArray acknowledgement = acknowledgements.add<JsonArray>();
  acknowledgement.add(acknowledgementCommandId);
  acknowledgement.add(acknowledgementApplied ? 1 : 0);
}

bool globalOtaHasAcknowledgement() {
  return acknowledgementCommandId != 0;
}

void globalOtaClearAcknowledgement() {
  if (acknowledgementCommandId == 0) return;
  acknowledgementCommandId = 0;
  acknowledgementApplied = false;
  clearPersistedPending();
}

bool globalOtaInProgress() { return inProgress; }

#else

void globalOtaBegin(Preferences&) {}
void globalOtaSetCellularDownloader(GlobalOtaCellularDownloader) {}
void globalOtaLoop(bool, bool, bool, uint64_t) {}
GlobalOtaOfferResult globalOtaOffer(uint32_t, JsonVariantConst, uint64_t) {
  return GlobalOtaOfferResult::REJECTED;
}
void globalOtaAppendFirmware(JsonDocument&) {}
void globalOtaAppendAcknowledgement(JsonArray) {}
bool globalOtaHasAcknowledgement() { return false; }
void globalOtaClearAcknowledgement() {}
bool globalOtaInProgress() { return false; }

#endif
