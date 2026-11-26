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

Kid-first, no reading needed: emoji theme picker (🎞️ ⭐ 💖 🎉 🦖 🚀 📷), drawn
sticker icons everywhere else (`public/icons.js`; settings → Icon style: Drawn /
Classic emoji), a strip/single toggle, a giant bouncing camera button, instant
capture (flash + shutter sound the moment it's tapped; an optional 1–10 s ring
countdown with beeps in settings; 3-photo strips always give at least a 1 s ring to
pose between shots), retake / print review, a printer
animation, a confetti finish, and an anti-mashing cooldown ring (1–15 s; UX
borrowed from `ChaseBro/photo-receipts`). The screen stays awake (Wake Lock).
**Press and hold the small gear** at the camera's top-right for 1.2 s to open
adult settings (a filling ring and "Keep holding…"; a tap only says "Hold to
open settings"). When the printer needs a grown-up (offline, out of paper,
cover open, error) a drawn sun sticker wiggles at the camera's bottom-left; tap
it for one line of words (`public/printer-state.js`). With MQTT the printer only
polls when poked (its own poll is hourly), so a stale check-in with no error is
"napping", not offline: a quieter badge (smaller, still, no "!") while the booth
nudges it (`POST /api/nudge`, at most every 2 min while in use, and right
before / after each print) and re-checks for ~25 s. Only a nudge that gets no
check-in makes it offline; a check-in clears it. Paper out / cover open / error
codes always win. See DESIGN.md "Grown-up
controls" for the adult-label rules.

Settings (one sheet): a status strip (printer · paper · upload queue, red when
something needs attention) with Nudge printer / Upload now / Print test strip;
then Booth (icon style, live print preview, sounds, screen flash), Camera
(start with front/back, mirror preview, countdown: Instant (default) to 10 s,
photos per strip), Strip &
copies (copies to start with — a floor under one-per-face —, most copies a kid
can pick, default 3, hard cap 6, footer), Party & sharing, Printer
(anti-ghost A–E, darkness, speed, calibration), Archive, Lock.

The review screen has a copies picker (− receipt×N +, 1 to the kid max, default 3, cap 6). It defaults to one
copy per face (at least "copies to start with"): `public/faces.js` runs MediaPipe's BlazeFace short-range
detector on-device (self-hosted WASM in `public/vendor/`, lazy-loaded after
the camera starts; falls back to 1 copy if it's missing or slow) and takes the
most faces in any frame. The face boxes are also passed to `compose()` as
`faces`. `POST /api/print` takes `copies` and enqueues one job (and one R2
object, since the printer worker deletes it on ack) per copy; every copy counts
toward the cooldown.

The printing screen doesn't wait for the printer. Once `POST /api/print` says
201 the job is safely queued (the printer takes it when it next polls; the booth
nudges it over MQTT), so the screen plays the printer animation for a beat
(1.5 s at least, 4 s at most after the 201: sooner if the job reports
completed; the 🧾 per copy tick off on an estimate if it starts printing, all
fill if it finishes), then confetti (2.4 s) and back to the camera, about 7 s
from the tap. The job is followed in the background (`/api/jobs/:id` every 3 s
for up to 60 s + 30 s per copy: MQTT re-nudges if the first poke seems lost,
and the printer badge for paper out etc.) without blocking the next shot. A
failed request (network, non-2xx) shows 😕 + retry; a 401 locks the booth.
Timings: `public/timing.js` (iOS: `BoothCore/Timing.swift`).

The camera stage is the photo slot's shape (4:3 for landscape frames, 4:5 for
portrait ones, `frames.js` slotAspect), as big as fits and centred, so the live
dithered preview and the plain video fill it with no bars: exactly the crop that
prints. It reshapes when the camera's frames turn.

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

Guests unlock with a shared PIN (`BOOTH_PIN`), cached in `localStorage`. It can be
digits, a word or a phrase: lock screens use a normal text keyboard (no autocorrect,
no auto-caps) and trim the ends. The match is exact, case included (the server trims
the ends of both sides too, so a secret pasted with a trailing newline still works).
Settings (hold the gear) are per device and can re-lock the booth.

Two different "share" actions:

**Share this photo** (guests, kids; wordless): the sticker with a strip and an
arrow, next to 🖨️ on the review screen and on the printing screen, opens "your
photos": a big QR code for another phone to scan, 📲 to send the files themselves
(strip PNG + originals via `navigator.share({ files })`, else downloads — peer to
peer, works offline) and ✖️. It stays until tapped away, or ~30 s after the print
finishes. The QR is a per-session link, `/s/<token>` (`public/mine.html`): that
session's printed receipt as the hero (the exact 1-bit `strip.png`, dot for dot on
receipt paper with torn edges), the colour originals as small thumbnails, Save
receipt / Save photos / Share all; "on its way…" / "Printing…" (with the colour
photo) on a paper placeholder (polling) until the background upload lands, and a 404 / "Link expired" after 24 h. It
works with or without a party (a party's strip QR still links the album). Opening
it makes that session's archive upload jump the queue (`archive.js`
`prioritize` / `orderDue`).

- `POST /api/sessions/:id/share` (PIN; optional `{ ttl }` seconds, 1 s–7 days,
  default 24 h) → `{ token, url, expiresAt }`; stores `share-s/<token>` →
  `{ day, id, exp }` in PHOTOS (under `ARCHIVE_PREFIX`). Clients build the link
  from their own origin.
- `GET /api/s/<token>` → `{ session: { id, day, files, meta }, expiresAt }`
  (public meta only: capturedAt, theme, shots, printed); `GET
  /api/s/<token>/file?key=…` serves only that session's images. Expired → 404
  (the record is deleted; the photos stay in the archive). `src/session-share.ts`.

**Share the booth** (hosts; it grants access) lets guests use their own phones
as a booth too, alongside the iPad: same printer, same party album. It passes
the PIN peer to peer: **hold** the small phone-with-plus sticker at the end of
the theme bar, off the camera window (only when unlocked; a tap says "Hold to
share the booth"), or settings → Share the booth. The sheet says "Let guests use
their own phone as a booth too…" and "This lets them use your booth
(prints, photos)", shows the PIN in big type with Copy PIN, and two links, each
as a QR code and a "Send link" button (share sheet → AirDrop / Messages;
clipboard where `navigator.share` is missing). Both links contain the PIN
(URL-encoded). Built in `public/share.js` (mirrored by
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

- **Album** (public, unguessable token): `/a/<token>` — every session as its
  printed receipt (tile = the top of the strip; not printed yet = the colour
  photo marked "printing…") with small colour thumbnails, tap to view, ⬇️ save
  (or 📤 share on phones), ⬇️ download all (.zip built in the browser), 📺
  slideshow (`?show=1`, for a TV: one session per slide, the receipt big in the
  middle — one screen pixel per dot on a 1× TV — feeding slowly up when taller
  than the screen, the colour photo small beside it; auto-advances, picks up new
  photos, shows the album QR in the corner). Hosts with the PIN saved on that
  device get 🙈 to hide a session from the album (it stays in the archive).
- **Strip QR**: `/a/<token>/<session id>` → "Your receipt" at the top, big, with
  that guest's colour photos beside it (waits for the background upload: "on its
  way…", then "Printing…" with the colour photo until `strip.png` lands). The QR block skips the solid-black relief pass
  so modules stay whole; module = 5 dots (0.6 mm), 2-module quiet zone inside
  its ink frame, tucked up under the ticket stub. `tools/qr-size/` renders
  strips at other sizes through the real dither + a simulated thermal print and
  decodes them with Apple Vision (4 dots fails once dot spread + blur are added).
- **Signs** (`public/sign.js`, Thermal Arcade like the app's TestFlight sign:
  cream card + confetti, drawn art, QR ≥ 3.5 in pure black on a white sticker
  card, everything 0.4 in inside the page): 🪧 on a party → its album poster;
  📱 **Booth sign** (header, or "instead" on the album sign) → "use the booth on
  your own phone, no app needed": QR → `<origin>/#pin=<PIN>` (opens the web
  booth unlocked; the PIN is only in the QR, never printed as text), three steps
  (scan, allow the camera, tap the camera then print). Each prints on Letter
  (browser print) or as a 576px sign on the receipt printer.
  `BOOTH_PIN=… node scripts/web-sign.mjs sign.pdf [preview.png]` renders the
  booth sign to a PDF without a running booth (PIN from the env, never printed;
  `BOOTH_ORIGIN` defaults to https://booth.receiptd.sh). `party.html#sign=web`
  opens it directly.
- 📥 adds every session from a day (e.g. shot before the party was set up);
  ♻️ rotates the album link (old sign + strip QRs stop working).

Storage (PHOTOS bucket, same prefix as the archive): `events/<slug>/event.json`,
`events/<slug>/s/<day>/<id>` (album index), `share/<token>` → slug,
`active-event`, `share-s/<token>` → one session's 24 h link (see Share this photo). API: `src/events-api.ts`.

### Testing

```sh
npm test                 # unit + API (in-memory R2) + design lint + printer badge / icons
npm run dev:e2e          # local booth + cprnt DO (PIN from .dev.vars: BOOTH_PIN=1234)
npm run test:e2e         # Playwright: party → booth (fake camera) → 5 strips, QR decoded → print → album;
                         #   share.e2e: stage shape, share-the-booth placement + PIN, share photo → /s/<token> → expiry
                         #   receipt-hero.e2e: real strips → /s/, /a/, /a/<session>, slideshow lead with the receipt
                         #     (iPhone / iPad / 1920×1080 TV screenshots → e2e/out/receipt-hero/)
                         #   redesign.e2e: gear tap/hold, printer badges + labels (napping → nudge → offline / check-in), Drawn/Classic, new settings
                         #   (screenshots → ios/build/shots/redesign/web-*.png; e2e/icon-sheet.mjs renders all icons)
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
