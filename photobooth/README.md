# receiptd photo booth

A browser photo booth that prints strips on the receipt printer over WiFi.

```
phone/tablet/laptop browser ──► booth.receiptd.sh (CF Worker: static UI + /api proxy)
                                    │  Bearer RECEIPTD_API_KEY (never sent to the browser)
                                    ▼
                               api.receiptd.sh  POST /v1/jobs {imageData, dither}
                                    ▼
                               cprnt.receiptd.sh ◄── printer polls over WiFi
```

The page captures 1 or 3 photos with a countdown, lays them out at 576px
(80mm @ 203dpi) with a header, date, and optional footer, tone-maps for
thermal paper, and shows an Atkinson-dithered preview. On **Print** the
Worker forwards the PNG to `/v1/jobs`; the server dithers (`DITHER` var,
default `atkinson`) and queues it for the default printer.

Guests unlock with a shared PIN (`BOOTH_PIN`), cached in `localStorage`.
⚙ in the camera view sets header/footer/countdown per device and can re-lock.

## Deploy

```sh
# 1. Mint a key that can only create/read jobs (needs an admin login)
receiptd --api https://api.receiptd.sh auth keys create \
  --label photobooth --scope jobs:write --scope jobs:read

# 2. Store secrets on the Worker
cd photobooth
wrangler secret put RECEIPTD_API_KEY   # paste rd_live_…
wrangler secret put BOOTH_PIN          # e.g. 4–6 digits

# 3. Ship (creates the booth.receiptd.sh DNS record on first deploy)
wrangler deploy
```

Open https://booth.receiptd.sh on any device (HTTPS is required for camera
access). On iPad/iPhone, "Add to Home Screen" gives a full-screen kiosk.

Revoke access any time with `receiptd auth keys revoke <id>`, or rotate
`BOOTH_PIN` to lock out existing devices.
