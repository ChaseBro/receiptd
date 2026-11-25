# receiptd photo booth

A browser photo booth that prints strips on the receipt printer over WiFi,
running entirely on Cloudflare — no Fly app, no always-on laptop.

```
phone/tablet browser ──► booth.receiptd.sh  (Worker: static UI + /api)
   compose + dither         │ wrap 1-bit raster in StarPRNT, R2 put + DO enqueue
   to 576px 1-bit           ▼
               PrinterQueue DO / JOBS_R2  (owned by receiptd-cprnt)
                            ▲
printer (WiFi) ── polls ──► cprnt.receiptd.sh  (receiptd-cprnt Worker)
```

Kid-first, no reading needed: emoji theme picker (🎞️ ⭐ 💖 🎉 🦖 🚀 📷), a
strip/single pictogram toggle, a giant bouncing 📸 button, ring countdown with
beeps, flash + shutter sound, ✖️ / 🖨️ review, a printer animation, a confetti
finish, and an anti-mashing cooldown ring (1–15 s; UX borrowed from
`ChaseBro/photo-receipts`). The screen stays awake (Wake Lock). Long-press the
top-right corner for 1.5 s to open adult settings.

The review screen has a copies picker (➖ 🧾×N ➕, 1–6). It defaults to one
copy per face: `public/faces.js` runs MediaPipe's BlazeFace short-range
detector on-device (self-hosted WASM in `public/vendor/`, lazy-loaded after
the camera starts; falls back to 1 copy if it's missing or slow) and takes the
most faces in any frame. The face boxes are also passed to `compose()` as
`faces`. `POST /api/print` takes `copies` and enqueues one job (and one R2
object, since the printer worker deletes it on ack) per copy; the printing
screen ticks off a 🧾 per copy, and every copy counts toward the cooldown.

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
printer acks (the job leaves the PrinterQueue Durable Object — strongly
consistent, so status flips on the next check). The DO class lives in
`worker/`, so deploy `receiptd-cprnt` before the booth when it changes.

KV → DO cutover: for 30 min after a printer's DO first wakes it keeps
re-reading the old `printer:<id>:jobs` KV queue (deduped by job id), so jobs
an un-redeployed booth still writes to KV are delivered (after KV's ~60s
propagation); then it deletes the KV keys. Deploy `worker/` then both booth
envs within that window. `worker/scripts/dq-smoke.mjs` exercises all of this
against `receiptd-cprnt-staging` (isolated DO namespace, workers.dev only).

Guests unlock with a shared PIN (`BOOTH_PIN`), cached in `localStorage`.
Settings (long-press top-right) set footer, countdown, anti-ghost gain,
density, speed, and sounds per device, and can re-lock the booth.

**Share booth** passes the PIN peer to peer instead of typing it: the small 📤
sticker at the top left of the camera (only when unlocked) or settings →
📤 Share booth opens a sheet with two links, each as a QR code and a "Send link"
button (share sheet → AirDrop / Messages; clipboard where `navigator.share` is
missing). Both contain the PIN. Built in `public/share.js` (mirrored by
`ios/BoothCore/.../Share.swift`):
- **Web booth**: `<origin>/#pin=<PIN>`. The boot code saves the PIN and strips
  the hash.
- **iOS app**: the TestFlight join link (`JOIN_URL`, = microapps
  `booth.join_url`) + `#server=<origin>&key=<PIN>`. Before install it shows the
  sign-up form (the join Worker never sees the fragment); after install the same
  link is a universal link and the app saves server + PIN and opens the camera.

### Native app

`ios/` is a SwiftUI booth for iPhone and iPad. It uses the same API and prints
the same strips: `frames.js` + `raster.js` are ported to Swift, and the printed
dots are checked to match the web app's in WebKit. See [ios/README.md](ios/README.md).

## Parties, albums, QR codes

Adults manage parties at **/party.html** (booth PIN): name, date, which frames
the booth offers (the 🦃 Thanksgiving set is one tap: 🦃 turkey · 🥧 feast ·
🍂 leaves · 🌟 starry · 🌽 harvest), the default frame, a footer, and whether
strips carry a QR code. **▶️ Shoot for this party** makes it the active event:
open booths pick it up within a minute (theme picker narrows, footer +
QR switch on, every session's archive upload carries `event`, which adds it to
the album index).

- **Album** (public, unguessable token): `/a/<token>` — every session, tap to
  view, ⬇️ save (or 📤 share on phones), ⬇️ download all (.zip built in the
  browser), 📺 slideshow (`?show=1`, for a TV: auto-advances, picks up new
  photos, shows the album QR in the corner). Hosts with the PIN saved on that
  device get 🙈 to hide a session from the album (it stays in the archive).
- **Strip QR**: `/a/<token>/<session id>` → "Your photos" at the top (waits
  for the background upload). The QR block skips the solid-black relief pass
  so modules stay whole; module = 5 dots.
- **Sign**: 🪧 on the party page → letter-size poster (browser print) or a
  576px sign on the receipt printer; optional "be the booth" QR that unlocks
  the booth on a guest's phone (`/#pin=…`, contains the PIN).
- 📥 adds every session from a day (e.g. shot before the party was set up);
  ♻️ rotates the album link (old sign + strip QRs stop working).

Storage (PHOTOS bucket, same prefix as the archive): `events/<slug>/event.json`,
`events/<slug>/s/<day>/<id>` (album index), `share/<token>` → slug,
`active-event`. API: `src/events-api.ts`.

### Testing

```sh
npm test                 # unit + API (in-memory R2) + design lint
npm run dev:e2e          # local booth + cprnt DO (PIN from .dev.vars: BOOTH_PIN=1234)
npm run test:e2e         # Playwright: party → booth (fake camera) → 5 strips, QR decoded → print → album
```

## Photo archive

Every session is kept in the private R2 bucket `receiptd-photos` (binding
`PHOTOS`; staging writes under `staging/` via `ARCHIVE_PREFIX`):

```
${prefix}YYYY-MM-DD/<id>/orig-N.jpg   camera frames, upright + ↻ fixes, as seen on screen (selfies mirrored)
                         strip.png    the exact 1-bit bitmap that printed (copy 1), 1-bit greyscale PNG
                         meta.json    theme, shots, faces/frame, rotations, copies, printed, sizes, UA…
```

The day is New York time, taken from the timestamp inside the session id
(`<base36 ms>-<8 hex>`), so retries and re-uploads land in the same folder.
Originals are capped at 2048 px (long side), JPEG q 0.82 (~250–450 KB each);
strips are ~25–70 KB.

`public/archive.js` uploads in the background (`POST /api/archive`,
multipart): originals once the review screen is up, then `strip.png` +
`printed: true` once the print is enqueued (and the originals again if ↻
changed them). Uploads pause while a print is being sent. The queue lives in
IndexedDB, retries with backoff (on load, `online`, every minute), and drops
the oldest sessions beyond 300 MB. Failures are reported to `/api/log`
(rate-limited, no image data). On iPad, use the Home Screen app: Safari can
evict a plain tab's IndexedDB after 7 days without a visit.

- **Gallery**: https://booth.receiptd.sh/gallery.html (same PIN) — browse by
  day, tap for full size, "Download day (.zip)" builds a zip in the browser.
- **Pull to the Mac**: `BOOTH_PIN=… npm run photos:pull -- --day 2026-11-14 --out ~/Pictures/Cheese`
  (`--all` for every day; existing files are skipped).
- API (PIN header): `GET /api/photos/days`, `GET /api/photos?day=YYYY-MM-DD`,
  `GET /api/photos/file?key=…`.

One-time setup: `wrangler r2 bucket create receiptd-photos` (keep it private:
no r2.dev URL, no custom domain).

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
`cprnt.receiptd.sh` (its Basic-auth secret lives in receiptd-cprnt's KV).

Open https://booth.receiptd.sh on any device (HTTPS is required for camera
access). On iPad/iPhone, "Add to Home Screen" gives a full-screen kiosk.
