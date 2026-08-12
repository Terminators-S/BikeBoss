#!/usr/bin/env python3
"""
BikeBoss ABA payment listener.

Watches the ABA notification chat and forwards verified transaction IDs to the
BikeBoss payment webhook. It also exposes a localhost QR fallback service that
returns ABA's real QR string when available, with the rendered image as a
fallback.
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

def load_env(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
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
PAYWAY_STATIC_LINK = os.environ.get("PAYWAY_STATIC_LINK", "https://link.payway.com.kh/ABAPAY30494500t")
QR_HTTP_PORT = int(os.environ.get("QR_HTTP_PORT", "8791"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bikeboss-listener")

def parse_aba_transaction_text(text: str):
    TRX_RE = re.compile(r"(?:Trx\.?\s*ID:|លេខប្រតិបត្តិការ:|Transaction\s*ID:|Txn\s*ID:|ID:)\s*(\d{8,})", re.IGNORECASE)
    AMOUNT_RE = re.compile(r"(?:\$|USD\s*)(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*USD", re.IGNORECASE)
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

# QR Fallback with network intercept for qr_string (real ABA QR)
async def scrape_payway_qr(amount: float):
    """Return ABA's QR payload and rendered image for the given amount."""
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        )
        page = await browser.new_page()
        qr_string = None

        async def capture_qr_response(response):
            nonlocal qr_string
            try:
                content_type = response.headers.get("content-type", "")
                if "json" not in content_type:
                    return
                data = await response.json()
                value = data.get("qr_string") if isinstance(data, dict) else None
                if value and str(value).startswith("000201"):
                    qr_string = str(value)
            except Exception:
                return

        page.on("response", capture_qr_response)
        try:
            await page.goto(PAYWAY_STATIC_LINK, wait_until="networkidle", timeout=15000)
            await page.fill("#txt_amount", f"{amount:.2f}")
            await page.click("button.st-button")
            await page.wait_for_selector("canvas", timeout=10000)
            await page.wait_for_timeout(1000)
            image = await page.evaluate(
                "() => { const c = document.querySelector('canvas');"
                " return c ? c.toDataURL('image/png') : null; }"
            )
            return {
                "qr_string": qr_string,
                "qr_image_base64": image,
                "source": "payway-service",
            }
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
            result = asyncio.run(asyncio.wait_for(scrape_payway_qr(amount), timeout=25.0))
            if not result.get("qr_string") and not result.get("qr_image_base64"):
                raise RuntimeError("no QR data")
            body = json.dumps({**result, "amount": amount}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:
            log.error("QR scrape failed: %s", error)
            body = b'{"error":"qr service unavailable"}'
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *args):
        pass


def run_qr_server():
    server = HTTPServer(("127.0.0.1", QR_HTTP_PORT), QRFallbackHandler)
    log.info("QR fallback endpoint: http://127.0.0.1:%d/qr?amount=15.01", QR_HTTP_PORT)
    server.serve_forever()


def main():
    log.info("Starting BikeBoss payment listener…")
    log.info("Watching chat %s → %s", ABA_GROUP_ID, WEBHOOK_URL)

    try:
        import playwright  # noqa: F401
        threading.Thread(target=run_qr_server, daemon=True).start()
    except ImportError:
        log.info("Playwright not installed — QR fallback disabled")

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
