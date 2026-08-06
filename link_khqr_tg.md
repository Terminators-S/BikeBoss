# ABA KHQR Link Generator & Telegram Listener Verification System

This document describes the complete architecture, design patterns, rules, and implementation code of the collision-free automatic payment verification system extracted from the **CreativeStudioWeb** project. 

This system allows any web application to accept **KHQR (ABA Bank / Bakong)** payments securely without paying expensive payment gateway fees or integrating complex enterprise APIs. Instead, it utilizes **Playwright web scraping** to dynamically generate QR codes from a static Payway link and a **Pyrogram Telegram client** to listen for and match real-time bank notifications.

---

## Table of Contents
1. [System Architecture Flow](#1-system-architecture-flow)
2. [Pillar 1: Dynamic Pricing System (Collision Prevention)](#2-pillar-1-dynamic-pricing-system-collision-prevention)
3. [Pillar 2: Playwright Web Scraper (QR Code Generation)](#3-pillar-2-playwright-web-scraper-qr-code-generation)
4. [Pillar 3: Pyrogram Telegram Listener & Auto-Verification](#4-pillar-3-pyrogram-telegram-listener--auto-verification)
5. [Pillar 4: Pyrogram Telegram Layer Compatibility](#5-pillar-4-pyrogram-telegram-layer-compatibility)
6. [Pillar 5: Database Models & Environment Variables](#6-pillar-5-database-models--environment-variables)
7. [Integration Guide for New Projects](#7-integration-guide-for-new-projects)

---

## 1. System Architecture Flow

The payment cycle proceeds through the following steps:

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant Frontend
    participant Backend
    participant Playwright
    participant ABA Payway
    participant Telegram as Telegram Bot/Group
    
    Customer->>Frontend: Click Checkout (e.g. $10.00)
    Backend->>Backend: Allocate unique price by adding 1-cent offsets (e.g., $10.01) if $10.00 is already pending
    Backend->>Frontend: Return unique PaymentIntent/Order
    Frontend->>Backend: Request QR code for $10.01
    Backend->>Playwright: Launch browser & navigate to static Payway Link
    Playwright->>ABA Payway: Enter amount $10.01 & submit
    ABA Payway-->>Playwright: Render QR Canvas
    Playwright-->>Backend: Extract base64 image (data:image/png;base64)
    Backend-->>Frontend: Send base64 QR code image
    Frontend-->>Customer: Display QR code & start polling/listener
    Customer->>ABA Payway: Scan and pay $10.01
    ABA Payway->>Telegram: Send transaction notification to ABA Group Chat
    Backend->>Telegram: Pyrogram listener intercepts message
    Backend->>Backend: Parse Transaction ID & exact amount ($10.01)
    Backend->>Backend: Query Database for pending intent of $10.01
    Backend->>Backend: Match found! Mark Order as Paid and Fulfill
    Backend-->>Frontend: WebApp polling detects "Paid" status -> Success Page
```

---

## 2. Pillar 1: Dynamic Pricing System (Collision Prevention)

### The Problem
When ABA Bank sends a notification to your Telegram group/channel, it only provides the **amount** and a **Transaction ID**. It does **not** include custom metadata like customer email or order ID. 

If two users checkout a cart worth exactly `$10.00` at the same time, it becomes impossible to distinguish which payment belongs to which customer when the bank notification arrives.

### The Solution
We enforce **amount uniqueness** by adding a small floating-point offset (1-cent increments, i.e., `0.01`) during checkout for any concurrent orders. The system checks if there are any other `Pending Payment` intents with the exact target amount. If there are, it increments the amount by `$0.01` and checks again, looping until it finds a unique amount.

This guarantees that the paid amount maps to exactly **one** unique `PaymentIntent` or `Order`.

### Backend Implementation Code (FastAPI/SQLAlchemy)
```python
# main.py
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import models

def checkout(db: Session, customer_email: str, base_amount: float):
    # Lock db table to prevent race conditions during amount allocation
    db.query(models.Product).with_for_update().all()
    
    discounted_price = round(base_amount, 2)
    discounted_price = max(0.01, discounted_price)

    offset = 0.0
    final_order_price = discounted_price
    
    # Uniqueness allocation loop
    while True:
        candidate_price = round(discounted_price + offset, 2)
        
        # Check if there is already an active order with this price
        existing_pending = db.query(models.Order).filter(
            models.Order.status == "Pending Payment",
            models.Order.price == candidate_price
        ).first()
        
        if not existing_pending:
            # Check if there is an active cart payment intent with this price
            existing_intent = db.query(models.PaymentIntent).filter(
                models.PaymentIntent.status == "Pending Payment",
                models.PaymentIntent.total_amount == candidate_price
            ).first()
            
            if not existing_intent:
                final_order_price = candidate_price
                break
                
        offset += 0.01

    # Create new order with unique final_order_price
    new_order = models.Order(
        customer_email=customer_email, 
        status="Pending Payment",
        price=final_order_price,
        created_at=datetime.utcnow().isoformat() + "Z",
        expires_at=(datetime.utcnow() + timedelta(minutes=15)).isoformat() + "Z",
    )
    db.add(new_order)
    db.commit()
    db.refresh(new_order)
    return new_order
```

---

## 3. Pillar 2: Playwright Web Scraper (QR Code Generation)

Instead of using Bakong KHQR official APIs (which require complex merchant credentials, static keys, and SDK imports), this method scrapes an **ABA Payway Link** (a payment link provided by ABA Bank to standard merchants/individuals).

### Web Scraper API Route
This route uses `playwright` to load the target Payway URL, enter the unique order amount, submit it, wait for the canvas containing the generated KHQR code to render, and pull the base64 URL.

```python
# main.py
import os
import asyncio
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from playwright.async_api import async_playwright
from sqlalchemy.orm import Session
from database import get_db
import models

router = APIRouter()

ALLOWED_HOSTS = {"link.payway.com.kh"}

def validate_payment_scraper_url(raw_url: str) -> str:
    from urllib.parse import urlparse
    parsed = urlparse((raw_url or "").strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host:
        raise HTTPException(status_code=400, detail="Payment link must be a valid HTTPS URL.")
    if host not in ALLOWED_HOSTS:
        raise HTTPException(status_code=400, detail="Payment link domain is not allowed.")
    return parsed.geturl()

@router.get("/api/checkout/aba-scraper")
async def generate_aba_qr_scraper(amount: float, url: Optional[str] = None, db: Session = Depends(get_db)):
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0.")
        
    # Get payment link from config or Database SiteSettings
    if not url:
        payment_link_setting = db.query(models.SiteSetting).filter(models.SiteSetting.key == "paymentStaticLink").first()
        configured_payment_link = payment_link_setting.value if payment_link_setting else None
    else:
        configured_payment_link = url

    # Default fallback
    target_url = validate_payment_scraper_url(
        configured_payment_link or os.getenv("DEFAULT_PAYMENT_STATIC_LINK", "https://link.payway.com.kh/ABAPAYYi434542I")
    )
        
    try:
        async def fetch_qr():
            async with async_playwright() as p:
                browser = await p.chromium.launch(
                    headless=True,
                    args=['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
                )
                page = await browser.new_page()
                try:
                    await page.goto(target_url, wait_until='networkidle', timeout=15000)
                    
                    # Fill amount text box and click continue/pay
                    await page.fill('#txt_amount', f"{amount:.2f}")
                    await page.click('button.st-button')
                    
                    # Wait for QR code canvas to render in the DOM
                    await page.wait_for_selector('canvas', timeout=10000)
                    await page.wait_for_timeout(1000) # Ensure full render completion
                    
                    # Extract the base64 data URL from the canvas
                    data_url = await page.evaluate('''() => {
                        const canvas = document.querySelector('canvas');
                        return canvas ? canvas.toDataURL('image/png') : null;
                    }''')
                    
                    return data_url
                finally:
                    await browser.close()
                    
        qr_base64 = await asyncio.wait_for(fetch_qr(), timeout=25.0)
        
        if not qr_base64:
            raise Exception("Failed to extract QR code canvas from the page.")
            
        return {
            "khqr_string": qr_base64,
            "amount": amount,
            "currency": "USD"
        }
            
    except Exception as e:
        print(f"[Error Scraper] {e}")
        raise HTTPException(status_code=502, detail="Payment QR service is temporarily unavailable.")
```

---

## 4. Pillar 3: Pyrogram Telegram Listener & Auto-Verification

The verification side runs a background Telegram user client (via Pyrogram) that connects to a specific channel/group (`ABA_GROUP_ID`) where bank notification messages are pushed.

### Regex Extraction Rules
Bank notifications contain varying text structures based on language settings. We parse them with regex:
1. **Transaction ID:** Matches the number containing at least 8 digits starting after `Trx ID:`, `លេខប្រតិបត្តិការ:`, `Transaction ID:`, `Txn ID:`, or `ID:`.
2. **Amount (USD):** Extracts values preceded/succeeded by `$` or `USD`.

```python
import re
from typing import Optional, tuple

def parse_aba_transaction_text(text: str) -> tuple[Optional[str], Optional[float]]:
    # Regex to match Transaction IDs
    trx_match = re.search(
        r'(?:Trx\.?\s*ID:|លេខប្រតិបត្តិការ:|Transaction\s*ID:|Txn\s*ID:|ID:)\s*(\d{8,})', 
        text, 
        re.IGNORECASE
    )
    
    # Regex to match amounts in USD
    amount_match = re.search(
        r'(?:\$|USD\s*)(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*USD', 
        text, 
        re.IGNORECASE
    )
    
    trx_id = trx_match.group(1) if trx_match else None
    amount_value = None
    if amount_match:
        amount_text = amount_match.group(1) or amount_match.group(2)
        try:
            amount_value = float(amount_text)
        except (TypeError, ValueError):
            amount_value = None
            
    return trx_id, amount_value
```

### Pyrogram Handler
We configure Pyrogram to start at application startup and register a handler. We verify that the transaction wasn't already processed, then search the DB.

```python
# main.py / telegram_service.py
from pyrogram import Client, filters
from pyrogram.handlers import MessageHandler
from sqlalchemy.orm import Session
from database import SessionLocal
import models

ABA_GROUP_ID = int(os.getenv("ABA_GROUP_ID", "-10022334455"))
telegram_client = None

def is_payment_timestamp_valid(created_at: str, expires_at: str, received_at: datetime) -> bool:
    if received_at is None:
        return True
    
    # Parse times
    from datetime import datetime
    created = datetime.fromisoformat(created_at.replace("Z", ""))
    expires = datetime.fromisoformat(expires_at.replace("Z", ""))
    
    # Prevent matching legacy orders that expired hours/days ago
    if received_at < created - timedelta(seconds=60):
        return False
    if received_at > expires + timedelta(minutes=10):
        return False
    return True

def process_aba_transaction_text(text: str, source: str, received_at: datetime) -> bool:
    trx_id, amount = parse_aba_transaction_text(text)
    if not trx_id or amount is None:
        return False

    db = SessionLocal()
    try:
        # Check if transaction has already been logged/processed
        existing = db.query(models.AbaTransaction).filter(models.AbaTransaction.trx_id == trx_id).first()
        if existing:
            if existing.is_used:
                return True
            db_trx = existing
        else:
            db_trx = models.AbaTransaction(trx_id=trx_id, amount=amount, label=text[:1000])
            db.add(db_trx)
            db.flush()

        # Database Match Queries with float safety boundary (+/- 0.001)
        pending_intents = db.query(models.PaymentIntent).filter(
            models.PaymentIntent.status == "Pending Payment",
            models.PaymentIntent.total_amount.between(amount - 0.001, amount + 0.001)
        ).all()

        matched_intent = next(
            (intent for intent in pending_intents if is_payment_timestamp_valid(intent.created_at, intent.expires_at, received_at)),
            None
        )

        if matched_intent:
            matched_intent.status = "Paid"
            matched_intent.receipt_url = trx_id
            db_trx.is_used = True
            
            # Fulfill all orders associated with this payment intent
            orders = db.query(models.Order).filter(models.Order.cart_group_id == matched_intent.cart_group_id).all()
            for order in orders:
                order.status = "Completed"
                order.payment_transaction_id = trx_id
            
            db.commit()
            print(f"[Verification] Successfully verified payment for cart group: {matched_intent.cart_group_id}")
            return True

        # Fallback to single order matching if cart_group_id is null
        pending_orders = db.query(models.Order).filter(
            models.Order.status == "Pending Payment",
            models.Order.price.between(amount - 0.001, amount + 0.001),
            models.Order.cart_group_id == None
        ).all()

        matched_order = next(
            (order for order in pending_orders if is_payment_timestamp_valid(order.created_at, order.expires_at, received_at)),
            None
        )

        if matched_order:
            matched_order.status = "Completed"
            matched_order.payment_transaction_id = trx_id
            db_trx.is_used = True
            db.commit()
            print(f"[Verification] Successfully verified single order: {matched_order.id}")
            return True

        print(f"[Verification Alert] ABA transaction {trx_id} for ${amount} received but could not match any active order.")
        return False
    except Exception as e:
        db.rollback()
        print(f"[Verification Error] {e}")
        return False
    finally:
        db.close()

async def handle_aba_transaction(client, message):
    text = message.text or message.caption or ""
    received_at = message.date # datetime object timezone-aware or UTC depending on Pyrogram setup
    process_aba_transaction_text(text, source=f"Telegram Chat ({message.chat.id})", received_at=received_at)

async def start_telegram_listener():
    global telegram_client
    telegram_client = Client(
        "payment_listener",
        api_id=int(os.environ["TELEGRAM_API_ID"]),
        api_hash=os.environ["TELEGRAM_API_HASH"],
        workdir="."
    )
    await telegram_client.start()
    
    # Register filter looking strictly at the ABA notification chat
    handler = MessageHandler(
        handle_aba_transaction,
        filters.chat(ABA_GROUP_ID) & (filters.text | filters.caption)
    )
    telegram_client.add_handler(handler)
```

---

## 5. Pillar 4: Pyrogram Telegram Layer Compatibility

### The Protocol Change Problem
Telegram frequently updates its server-side protocol constructor IDs. If a Pyrogram client encounters newer constructor IDs (e.g. `types.Message` updates) that are not recognized by its built-in schema parsing layer, it will crash with parsing or decoding exceptions.

### The Fix
To bypass protocol crashes, the system uses a custom compatibility layer that catches and reads modern constructors:

```python
# telegram_compat.py
from io import BytesIO
from typing import Any
from pyrogram import raw
from pyrogram.raw.all import objects
from pyrogram.raw.core import TLObject
from pyrogram.raw.core.primitives import Int

NEW_MESSAGE_CONSTRUCTOR_ID = 0x7600B9D3

class MessageLayerCompat(TLObject):
    ID = NEW_MESSAGE_CONSTRUCTOR_ID
    QUALNAME = "types.Message"

    @staticmethod
    def read(b: BytesIO, *args: Any) -> "raw.types.Message":
        # Decode fields in correct sequence conforming to modern Telegram standards
        flags = Int.read(b)
        flags2 = Int.read(b)
        message_id = Int.read(b)
        # Add remaining decoder logic ...
        return raw.types.Message(...) # Return standard Pyrogram raw object

def install_pyrogram_layer_compat():
    # Inject compat class overrides into the Pyrogram parsing system
    objects[NEW_MESSAGE_CONSTRUCTOR_ID] = MessageLayerCompat
```

Ensure `install_pyrogram_layer_compat()` is executed **before** importing `Client` from `pyrogram`.

---

## 6. Pillar 5: Database Models & Environment Variables

### Database Schema (SQLAlchemy Reference)
```python
# models.py
from sqlalchemy import Column, Integer, String, Float, Boolean, Text
from database import Base

class PaymentIntent(Base):
    __tablename__ = "payment_intents"
    id = Column(Integer, primary_key=True, index=True)
    cart_group_id = Column(String, unique=True, index=True)
    total_amount = Column(Float)
    customer_email = Column(String)
    status = Column(String, default="Pending Payment") # "Pending Payment", "Paid", "Expired"
    receipt_url = Column(String, nullable=True) # stores ABA Transaction ID on payment
    created_at = Column(String)
    expires_at = Column(String)

class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True, index=True)
    customer_email = Column(String)
    price = Column(Float)
    status = Column(String, default="Pending Payment") # "Pending Payment", "Completed", "Expired"
    cart_group_id = Column(String, nullable=True, index=True)
    payment_transaction_id = Column(String, nullable=True)
    created_at = Column(String)
    expires_at = Column(String)

class AbaTransaction(Base):
    __tablename__ = "aba_transactions"
    id = Column(Integer, primary_key=True, index=True)
    trx_id = Column(String, unique=True, index=True)
    amount = Column(Float)
    is_used = Column(Boolean, default=False)
    label = Column(String, nullable=True)
```

### Necessary `.env` Variables
Ensure these settings are populated in your project deployment config:
```ini
# Pyrogram Client API Access
TELEGRAM_API_ID="1234567"
TELEGRAM_API_HASH="your_telegram_api_hash_here"

# Notification Channel/Group Target containing ABA Bot messages
ABA_GROUP_ID="-10022334455"

# The static URL of the ABA Payway payment link
DEFAULT_PAYMENT_STATIC_LINK="https://link.payway.com.kh/ABAPAYYourLinkID"

# Scraper configuration
ABA_SCRAPER_ALLOWED_HOSTS="link.payway.com.kh"
```

---

## 7. Integration Guide for New Projects

To integrate this payment method into a new python/javascript web application:

1. **Install Prerequisites**:
   ```bash
   pip install fastapi playwright pyrogram bakong-khqr sqlalchemy
   playwright install chromium
   ```
2. **Setup Unique Allocation**: Ensure that every transaction creation step runs inside a database transaction lock (`with_for_update`) and runs the uniqueness loop to resolve the exact decimal amount.
3. **Configure Playwright Scraper**: Copy the scraper route into your API backend to handle rendering the Payway form headlessly and fetching the resulting QR code.
4. **Deploy Background Listener**: Run the Pyrogram client daemon alongside your primary server process (using systemd or asyncio concurrent loops) to process Telegram bank messages instantly. Include matching checks inside `is_payment_timestamp_valid` to filter out matching mistakes for stale or expired items.
