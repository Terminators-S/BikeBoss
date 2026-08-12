from playwright.sync_api import sync_playwright
import json
from pathlib import Path
import sys

amount = sys.argv[1] if len(sys.argv) > 1 else "0.11"
url = "https://link.payway.com.kh/ABAPAY30494500t"
out_path = Path("payway_live_qr.json")
qr_string = None
download_qr = None
captured = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    def on_response(resp):
        global qr_string, download_qr
        if "pwapp.ababank.com" not in resp.url:
            return
        try:
            body = resp.text()
        except Exception:
            return
        if not body or "qr_string" not in body:
            return
        try:
            data = json.loads(body)
        except Exception:
            return
        if data.get("qr_string"):
            qr_string = data["qr_string"]
            download_qr = data.get("download_qr")
            captured.append({
                "url": resp.url,
                "qr": qr_string,
                "amount": ((data.get("transaction_summary") or {}).get("order_details") or {}).get("amount"),
                "client_id": data.get("client_id"),
            })

    page.on("response", on_response)
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)

    filled = False
    for sel in ["input[type=text]", "input[type=number]", "input"]:
        locs = page.locator(sel)
        for i in range(locs.count()):
            el = locs.nth(i)
            try:
                if el.is_visible():
                    el.click()
                    el.fill("")
                    el.type(str(amount), delay=40)
                    filled = True
                    break
            except Exception:
                pass
        if filled:
            break

    page.wait_for_timeout(300)
    buttons = page.locator("button")
    for i in range(min(buttons.count(), 15)):
        try:
            t = (buttons.nth(i).inner_text() or "").strip().lower()
            if any(k in t for k in ["continue", "pay", "next", "confirm", "ok"]):
                buttons.nth(i).click()
                break
        except Exception:
            pass

    for _ in range(40):
        if qr_string:
            break
        page.wait_for_timeout(500)

    browser.close()

result = {
    "ok": bool(qr_string),
    "amount": amount,
    "qr_string": qr_string,
    "download_qr": download_qr,
    "captured": captured,
}
out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({"ok": result["ok"], "amount": amount, "qr_len": len(qr_string or ""), "qr_prefix": (qr_string or "")[:80]}))
if not qr_string:
    sys.exit(2)
