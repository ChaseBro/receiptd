# receiptd photo booth

A browser photo booth that prints strips on the receipt printer over WiFi,
running entirely on Cloudflare — no Fly app, no always-on laptop.

```
phone/tablet browser ──► booth.receiptd.sh  (Worker: static UI + /api)
   compose + dither         │ wrap 1-bit raster in StarPRNT, R2 put + KV enqueue
   to 576px 1-bit           ▼
                        JOBS_KV / JOBS_R2  (shared with receiptd-cprnt)
                            ▲
printer (WiFi) ── polls ──► cprnt.receiptd.sh  (receiptd-cprnt Worker)
```

The page captures 1 or 3 photos with a countdown, lays them out at 576px
(80mm @ 203dpi) with a header, date, and optional footer, tone-maps for
thermal paper, and Atkinson-dithers in the browser. The preview is the exact
bitmap that prints. On **Print** the browser sends the packed 1-bit raster;
`src/starprnt.ts` wraps it in the same StarPRNT bytes Star's `cputil` emits
for `[image …][feed:3][cut]` (verified byte-identical) and the Worker pushes
it onto the printer's CloudPRNT queue. Job status = "completed" once the
printer acks (the job leaves the KV queue).

Guests unlock with a shared PIN (`BOOTH_PIN`), cached in `localStorage`.
⚙ in the camera view sets header/footer/countdown per device and can re-lock.

## Deploy

```sh
cd photobooth
wrangler deploy                 # creates booth.receiptd.sh on first deploy
wrangler secret put BOOTH_PIN   # rotate any time to lock out devices
```

`PRINTER_ID` in `wrangler.toml` must be a printer already paired to
`cprnt.receiptd.sh` (its Basic-auth secret lives in the shared KV).

Open https://booth.receiptd.sh on any device (HTTPS is required for camera
access). On iPad/iPhone, "Add to Home Screen" gives a full-screen kiosk.
