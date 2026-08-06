#!/usr/bin/env python3
"""
BikeBoss ABA Payment Listener
=============================

Pyrogram user-client that listens to the ABA bank notification chat and
forwards parsed transactions to the BikeBoss Cloudflare Worker webhook.

The worker matches the exact (collision-free) amount against pending
invoices — see backend/src/lib/payments.js.
"""

import os
import re
import sys
import time
import logging
from datetime import datetime, timezone

import requests
from pyrogram import Client, filters
from pyrogram.handlers import MessageHandler

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_env(path=".env"):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()

API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
ABA_GROUP_ID = int(os.environ["ABA_GROUP_ID"])
WEBHOOK_URL = os.environ.get(
    "BIKEBOSS_WEBHOOK_URL",
    "https://api.creative-studio.blog/webhook/abapayway",
)
WEBHOOK_SECRET = os.environ["PAYMENT_WEBHOOK_SECRET"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("bikeboss-listener")

# ---------------------------------------------------------------------------
# Parsing — EN + KM bank notification formats (from link_khqr_tg.md Pillar 3)
# ---------------------------------------------------------------------------

TRX_RE = re.compile(
    r"(?:Trx\.?\s*ID:|លេខប្រតិបត្តិការ:|Transaction\s*ID:|Txn\s*ID:|ID:)\s*(\d{8,})",
    re.IGNORECASE,
)
AMOUNT_RE = re.compile(
    r"(?:\$|USD\s*)(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*USD",
    re.IGNORECASE,
)


def parse_aba_transaction_text(text: str):
    trx = TRX_RE.search(text)
    amt = AMOUNT_RE.search(text)

    trx_id = trx.group(1) if trx else None
    amount = None
    if amt:
        raw = amt.group(1) or amt.group(2)
        try:
            amount = float(raw)
        except (TypeError, ValueError):
            amount = None
    return trx_id, amount


# ---------------------------------------------------------------------------
# Webhook forwarding (with simple retry)
# ---------------------------------------------------------------------------

seen_trx_ids = set()


def forward_to_worker(trx_id: str, amount: float) -> bool:
    if trx_id in seen_trx_ids:
        log.info("Duplicate trx %s — already forwarded, skipping", trx_id)
        return True

    payload = {"txn_id": trx_id, "amount": amount, "secret": WEBHOOK_SECRET}
    for attempt in range(3):
        try:
            resp = requests.post(WEBHOOK_URL, json=payload, timeout=15)
            if resp.ok:
                data = resp.json()
                log.info(
                    "Webhook OK: trx=%s amount=%.2f → %s",
                    trx_id, amount, data.get("status"),
                )
                seen_trx_ids.add(trx_id)
                if data.get("status") == "unmatched":
                    log.warning(
                        "No pending invoice for $%.2f (trx %s) — unmatched",
                        amount, trx_id,
                    )
                return True
            log.warning("Webhook %s attempt %d: HTTP %s", trx_id, attempt + 1, resp.status_code)
        except requests.RequestException as e:
            log.warning("Webhook %s attempt %d failed: %s", trx_id, attempt + 1, e)
        time.sleep(2 * (attempt + 1))
    return False


# ---------------------------------------------------------------------------
# Telegram handler
# ---------------------------------------------------------------------------

async def handle_aba_message(client, message):
    text = message.text or message.caption or ""
    if not text:
        return

    trx_id, amount = parse_aba_transaction_text(text)
    if not trx_id or amount is None:
        return  # not a bank notification

    log.info("ABA notification: trx=%s amount=$%.2f", trx_id, amount)
    forward_to_worker(trx_id, amount)


def main():
    log.info("Starting BikeBoss payment listener…")
    log.info("Watching chat %s → %s", ABA_GROUP_ID, WEBHOOK_URL)

    app = Client("bikeboss_listener", api_id=API_ID, api_hash=API_HASH)
    app.add_handler(
        MessageHandler(
            handle_aba_message,
            filters.chat(ABA_GROUP_ID) & (filters.text | filters.caption),
        )
    )
    app.run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
