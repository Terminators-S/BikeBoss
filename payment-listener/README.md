# BikeBoss Payment Listener

External service that watches the ABA bank notification Telegram chat and
confirms BikeBoss KHQR payments by calling the Worker webhook.

Adapted from the CreativeStudioWeb architecture (`link_khqr_tg.md`) —
the Playwright scraper is **not needed** here: the Worker generates the
KHQR EMV payload locally (`backend/src/lib/khqr.js`), so this service only
does Pillar 3 (listen + match).

## How it works

```
ABA Bank → notification msg in Telegram group (Trx ID + amount, no metadata)
        ↓
this listener (Pyrogram user client in that group)
        ↓ parses Trx ID + $amount (EN/KM regexes)
POST https://api.creative-studio.blog/webhook/abapayway
  { txn_id, amount, secret }
        ↓
Worker matches exact amount (unique via $0.01 offsets) → marks invoice paid
→ extends subscription 365d → notifies user in their language
```

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # fill values
python listener.py
```

First run creates a Pyrogram session (interactive phone-code login) —
after that it runs headless. Use a **dedicated Telegram account** that is a
member of the ABA notification group, not your personal one.

## Deploy

Any always-on box: Raspberry Pi, VPS, or `systemd` unit (see `bikeboss-listener.service`).
