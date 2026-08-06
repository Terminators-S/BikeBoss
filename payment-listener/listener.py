#!/usr/bin/env python3
"""
BikeBoss ABA Payment Listener
=============================

Two jobs:

1. LISTEN (primary): Pyrogram user-client watches the ABA bank notification
   chat, parses Trx ID + amount, forwards to the BikeBoss worker webhook.
   The worker matches the collision-free amount against pending invoices.

2. QR FALLBACK: /qr?amount=15.01 HTTP endpoint that scrapes the merchant's
   static PayWay link with Playwright and returns the rendered QR as base64.
   Only used if the worker-side EMV QR ever fails (rare). Requires:
     pip install playwright && playwright install chromium
"""

import os
import re
import sys
import json
import time
import asyncio
import logging
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

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
PAYWAY_STATIC_LINK = os.environ.get(
    "PAYWAY_STATIC_LINK",
    "https://link.payway.com.kh/ABAPAY30494500t",
)
QR_HTTP_PORT = int(os.environ.get("QR_HTTP_PORT", "8791"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bikeboss-listener")

# ---------------------------------------------------------------------------
# Part 1 — Bank notification parsing (EN + KM, from link_khqr_tg.md Pillar 3)
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


seen_trx_ids = set()


def forward_to_worker(trx_id: str, amount: float) -> bool:
    if trx_id in seen_trx_ids:
        log.info("Duplicate trx %s — skipping", trx_id)
        return True

    payload = {"txn_id": trx_id, "amount": amount, "secret": WEBHOOK_SECRET}
    for attempt in range(3):
        try:
            resp = requests.post(WEBHOOK_URL, json=payload, timeout=15)
            if resp.ok:
                data = resp.json()
                log.info("Webhook OK: trx=%s $%.2f → %s", trx_id, amount, data.get("status"))
                seen_trx_ids.add(trx_id)
                if data.get("status") == "unmatched":
                    log.warning("No pending invoice for $%.2f (trx %s)", amount, trx_id)
                return True
            log.warning("Webhook attempt %d: HTTP %s", attempt + 1, resp.status_code)
        except requests.RequestException as e:
            log.warning("Webhook attempt %d failed: %s", attempt + 1, e)
        time.sleep(2 * (attempt + 1))
    return False


async def handle_aba_message(client, message):
    text = message.text or message.caption or ""
    if not text:
        return
    trx_id, amount = parse_aba_transaction_text(text)
    if not trx_id or amount is None:
        return
    log.info("ABA notification: trx=%s $%.2f", trx_id, amount)
    forward_to_worker(trx_id, amount)


# ---------------------------------------------------------------------------
# Part 2 — Playwright QR scraper (fallback only)
# ---------------------------------------------------------------------------

async def scrape_payway_qr(amount: float):
    """Render the static PayWay link with the given amount, extract QR canvas."""
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        )
        page = await browser.new_page()
        try:
            await page.goto(PAYWAY_STATIC_LINK, wait_until="networkidle", timeout=15000)
            await page.fill("#txt_amount", f"{amount:.2f}")
            await page.click("button.st-button")
            await page.wait_for_selector("canvas", timeout=10000)
            await page.wait_for_timeout(1000)
            return await page.evaluate(
                "() => { const c = document.querySelector('canvas');"
                " return c ? c.toDataURL('image/png') : null; }"
            )
        finally:
            await browser.close()


class QRFallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/qr":
            self.send_response(404)
            self.end_headers()
            return

        try:
            amount = float(parse_qs(parsed.query).get("amount", ["0"])[0])
        except ValueError:
            amount = 0
        if amount <= 0:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error":"amount must be > 0"}')
            return

        try:
            data_url = asyncio.run(asyncio.wait_for(scrape_payway_qr(amount), timeout=25.0))
            if not data_url:
                raise RuntimeError("no canvas")
            body = json.dumps({"qr_base64": data_url, "amount": amount}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            log.error("QR scrape failed: %s", e)
            self.send_response(502)
            self.end_headers()
            self.wfile.write(b'{"error":"qr service unavailable"}')

    def log_message(self, *args):
        pass  # quiet


def run_qr_server():
    server = HTTPServer(("127.0.0.1", QR_HTTP_PORT), QRFallbackHandler)
    log.info("QR fallback endpoint: http://127.0.0.1:%d/qr?amount=15.01", QR_HTTP_PORT)
    server.serve_forever()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    log.info("Starting BikeBoss payment listener…")
    log.info("Watching chat %s → %s", ABA_GROUP_ID, WEBHOOK_URL)

    # QR fallback HTTP server in a side thread (only if playwright available)
    try:
        import playwright  # noqa: F401
        threading.Thread(target=run_qr_server, daemon=True).start()
    except ImportError:
        log.info("Playwright not installed — QR fallback disabled (EMV primary is fine)")

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
