#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>

enum class GlobalOtaOfferResult : uint8_t {
  ACCEPTED,
  REJECTED,
};

using GlobalOtaCellularDownloader = bool (*)(
  const char* path,
  const char* authorization,
  size_t sizeBytes,
  const char* sha256Hex
);

void globalOtaBegin(Preferences& preferences);
void globalOtaSetCellularDownloader(GlobalOtaCellularDownloader downloader);
void globalOtaLoop(
  bool wifiConnected,
  bool cellularConnected,
  bool safeToInstall,
  uint64_t requestSequence
);
GlobalOtaOfferResult globalOtaOffer(
  uint32_t commandId,
  JsonVariantConst payload,
  uint64_t requestSequence
);
void globalOtaAppendFirmware(JsonDocument& document);
void globalOtaAppendAcknowledgement(JsonArray acknowledgements);
bool globalOtaHasAcknowledgement();
void globalOtaClearAcknowledgement();
bool globalOtaInProgress();
