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

Kid-first, no reading needed: emoji theme picker (🎞️ ⭐ 💖 🎉 🦖 🚀 📷), a
strip/single pictogram toggle, a giant bouncing 📸 button, ring countdown with
beeps, flash + shutter sound, ✖️ / 🖨️ review, a printer animation, a confetti
finish, and an anti-mashing cooldown ring (1–15 s; UX borrowed from
`ChaseBro/photo-receipts`). The screen stays awake (Wake Lock). Long-press the
top-right corner for 1.5 s to open adult settings.

Photos are turned upright from the phone's tilt sensor at capture time; tap ↻
on a photo in the review screen to fix one by hand. Strips are laid out at
576px (80mm @ 203dpi) with a theme frame (`public/frames.js`), a date/time
stamp, and an optional footer, then dithered in a Web Worker
(`public/dither.worker.js`). The preview is the exact bitmap that prints.

### Anti-ghosting

`public/raster.js` runs Atkinson error diffusion against a printer model
(Pappas & Neuhoff, model-based error diffusion), not against ideal dots. Each head element
tracks fast heat (~3 lines) and slow substrate heat (~65 lines) with lateral
spread, as in Saquib/Vetterling US6819347B2. A dot fired on a hot element is
modeled as darker, so the dither fires fewer dots in greys that follow dark
areas. Solid blacks are left solid. Settings → 🧪 prints a calibration strip
with five gains (A–E): pick the band where the greys under the black block
match the greys to its right. The print density (`ESC RS d n`) and speed
(`ESC RS r n`, default slow) are sent with each job.

On **Print** the browser sends the packed 1-bit raster;
`src/starprnt.ts` wraps it in the same StarPRNT bytes Star's `cputil` emits
for `[image …][feed:3][cut]` (verified byte-identical) and the Worker pushes
it onto the printer's CloudPRNT queue. Job status = "completed" once the
printer acks (the job leaves the KV queue).

Guests unlock with a shared PIN (`BOOTH_PIN`), cached in `localStorage`.
Settings (long-press top-right) set footer, countdown, anti-ghost gain,
density, speed, and sounds per device, and can re-lock the booth.

## Release flow (don't test on the live booth)

```sh
npm test                 # raster tests + design lint
npm run deploy:staging   # → https://booth-staging.receiptd.sh (real printer)
#   …verify on the iPad / WebKit…
npm run deploy           # → https://booth.receiptd.sh
```

Open kiosks poll `/api/version` and reload themselves after a production
deploy, but only once they have been untouched for 2 minutes on the camera
screen. To stop Safari asking for the camera on every load, set
**aA → Website Settings → Camera → Allow**.

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
