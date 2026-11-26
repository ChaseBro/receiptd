# Photo Booth for iPhone and iPad

A native (SwiftUI) version of the booth. It uses the same Worker and printer
queue as the web booth, and prints the same strips. Registered in
`~/src/microapps` as `booth`, so `micro` builds and ships it.

It does what the web booth does: camera capture (1 or 3 shots, instant by
default, optional 1–10 s countdown ring, a 1 s posing ring between strip shots,
flash), the theme picker, ↻ per photo, copies picker (defaults to one copy per
face, found with Vision), and printing via `POST /api/print` + `/api/jobs/:id`
(`x-booth-pin`), with MQTT nudges and the anti-mash cooldown. The printing
screen doesn't wait for the printer: after the 201 it animates for 1.5–4 s,
celebrates and returns to the camera, while the job is followed in the
background (`BoothCore/Timing.swift`, same numbers as `public/timing.js`). It also follows
the active party (`/api/events/active`: its frames, its footer, a QR on each
strip that links to that guest's album page) and runs the background archive
upload (`POST /api/archive`: originals, then the printed `strip.png`). The kid
screens use drawn sticker icons (`App/Icons.swift`, the same drawings as
`public/icons.js`; settings → Icon style: Drawn / Classic emoji), not words.
Press and hold the small gear at the camera's top-right for 1.2 s to open the
adult settings (a filling ring, "Keep holding…", a haptic tick at 50 %; a tap
only shows "Hold to open settings"). The printer badge (bottom-left of the
camera, only when the printer needs a grown-up) maps `PrinterHealth.state(wake:)`
(BoothCore: offline / out of paper / cover open / error) to one drawing each; a
tap shows its one-line adult label. A stale check-in with no error is `.asleep`
(napping: a quiet, still badge) while `PrinterWake` nudges the printer and
re-checks; only an unanswered nudge makes it `.offline` (same rules as
`public/printer-state.js`; `-booth.fakePrinter napping|nappingWakes` stubs it for
the UI tests). See ../DESIGN.md "Grown-up controls".

```
App/          SwiftUI screens, camera (AVFoundation), faces (Vision), sounds
BoothCore/    Swift package, no UI: frames.js + raster.js port, QR, API, archive
UITests/      the kid flow end to end against a local booth
parity/       gen.mjs — renders reference strips with the web app's own JS in WebKit
```

## Strips match the web app's

`BoothCore` ports `public/frames.js` (layouts and print art for all 12 themes)
and `public/raster.js` + `dither.worker.js` (tone map, thermal-model Atkinson,
solid-black relief, copies sharing head heat). `swift test` compares the port
with strips that the web app's own code renders in WebKit, which is the engine
iPad Safari uses. The fixtures cover 24 strips: every theme, 1 and 3 shots,
portrait and landscape frames, QR, footer, face metering, gains A–E and
2-copy relief.

- **Printed dots: identical.** All 18.6M dots of the 24 fixture strips match.
- **Raster stage: bit-exact.** Given the same grey strip, the dither, relief
  and head heat match exactly (JS float semantics: Double maths, Float32
  stores).
- **Grey strip before dithering:** 21 of 24 strips are byte-identical. On the
  other three, 5–11 anti-aliased pixels of the outlined ticket number are off
  by one grey level (CG's text-stroke path). Not one printed dot changes.

How the canvas gets matched: WebKit's canvas *is* CoreGraphics, so
`Canvas.swift` makes the same CG calls WebKit's `GraphicsContextCG` makes:
- float geometry, float `translate`/`rotate`;
- user-space paths;
- WebKit's arc, ellipse and roundRect construction;
- integer font metrics for `textBaseline = "middle"`;
- kerned runs, glyphs placed through the text matrix.

Emoji stickers are the exception. Colour-emoji bitmaps resample slightly
differently in CoreText, and the web app's sticker silhouettes are drawn on
GPU-backed canvases. So `gen.mjs` bakes each sticker's art, halo and shadow
from WebKit into `BoothCore/Resources/Stickers` (39 stickers, 0.5 MB). An
emoji that isn't baked falls back to drawing live, and
`testEveryStickerIsBaked` catches that.

```sh
cd photobooth && node ios/parity/gen.mjs     # WebKit (Playwright) → fixtures + stickers (~30 MB fixtures, gitignored)
cd ios/BoothCore && swift test -c release    # parity + unit tests (Mac, no Simulator)
```

Re-run `gen.mjs` after changing `frames.js` or `raster.js` (and commit the
re-baked stickers if any emoji or size changed). Then port the change to
`Frames.swift` / `Raster.swift` until `swift test` passes again. Keep the
`rand()` call order. In JS, `stamp(…, { fill: rand() })` draws the fill rand
before the shape's rands.

## Run it

```sh
cd photobooth/ios
xcodegen generate && open PhotoBooth.xcodeproj
```

The booth server is https://booth.receiptd.sh by default. Change it under
settings → Server, or scan a setup link (`booth://setup#server=…&key=<PIN>`).
In the Simulator, a moving test pattern stands in for the camera.

### The PIN

With a PIN the app opens straight to the camera; the lock screen shows only
when there is none, or when the server answers 401. The PIN used is, in order:

1. the **saved PIN**: typed at the lock screen, or from a setup / share link;
2. the **bundled PIN**: `BOOTH_PIN` from the gitignored `Booth.local.xcconfig`
   (copy `Booth.local.xcconfig.example`), compiled into Info.plist `BoothPIN`.
   Without that file the build still works and the PIN is empty.

A 401 clears a saved PIN (falling back to the bundled one) or marks the
bundled one rejected, so it isn't retried until a new build carries a different
PIN; an adult types the new one. With a bundled PIN, settings offers
"Forget saved PIN" instead of "Lock booth".

### Share this photo / Share the booth

**Share this photo** (kids, wordless): the strip-with-arrow sticker on the review
and printing screens opens "your photos": a big QR to `/s/<token>` (a 24 h link
to that one session, `POST /api/sessions/:id/share`, see ../README.md), 📲 (the
strip + originals as images in a UIActivityViewController: AirDrop, Messages,
Save), ✖️. It stays until tapped away or ~30 s after the print. The session's
archive upload jumps the queue (`ArchiveQueue.prioritize`).

**Share the booth** (hosts: guests' own phones become booths too, same printer,
same party album): hold the small phone-with-plus sticker at the end of the
theme bar, off the camera window (a tap only says "Hold to share the booth"),
or settings → Party & sharing. The sheet says "Let guests use their own phone as
a booth too…" and "This lets them use your booth (prints, photos)", shows the PIN in big type with Copy PIN, and two
links, each as a big QR code and a share-sheet button. Both carry the PIN
(`BoothLinks` in `BoothCore/Share.swift`, mirrored by `public/share.js`):

- **Booth on the web**: `https://booth.receiptd.sh/#pin=<PIN>`.
- **Booth app (TestFlight)**: `https://join.receiptd.sh/booth?k=…#server=<server>&key=<PIN>`
  (`BoothLinks.join` = microapps `booth.join_url`). Before install: the
  TestFlight sign-up. After install: a universal link (AASA path `/booth`), so
  `Pairing` saves server + PIN and the app lands on the camera. `booth://setup#…`
  does the same.

The PIN may be a word or phrase: the lock screen uses the normal keyboard
(no autocorrect / auto-caps) and trims the ends; matching is exact.

The camera stage is the photo slot's shape (4:5 when the upright photo is
portrait, 4:3 when landscape; `BoothCamera.stageAspect`), fitted and centred, so
the live dots and the plain preview fill it edge to edge.

### Which way is up

Frames arrive in the sensor's native orientation. `BoothCamera` keeps clockwise angles
(`BoothCore/Orientation.swift`, `Upright`), all relative to that native orientation: the rotation
coordinator's horizon-level **capture** angle (from gravity) and **preview** angle (from the
interface orientation), plus the **buffer** angle, the rotation the video data output's connection
already applied. The booth resets that to 0, but AVCaptureSession.h says its default is 180° on the
Spring 2024 iPads' front camera and asks apps that rotate frames themselves to allow for it on every
device, so it is read back: every photo and live frame is turned by `frameTurn` = capture − buffer.
The slot's shape (4:5 / 4:3) comes from the upright frame's real size (like the print layout), and
the live dots are turned by (preview − capture) to line up with the plain video. The coordinator
reports 0° for preview while its layer isn't in a window, so it only gets the layer once
`CameraPreview` is on screen (`didMoveToWindow`); until then the preview angle (and, with no
coordinator, the capture angle) is the camera's static one (iOS 27's
`videoRotationAngleRelative(toDeviceOrientation:)`, else `Upright.builtInAngle`). Data-output
mirroring is turned off explicitly (setting it with automatic mirroring on throws). A camera with a
dynamic aspect ratio (iOS 26) is asked for the 4:3 / 3:4 one that stands up portrait. A
rotation-locked phone held sideways gets a landscape photo, upright, with the stage showing that crop
turned to the screen (3:4).

**On a real device:** Settings → About this booth shows the app version + build, device model, camera,
whether the coordinator is in use (and with the on-screen layer), the capture / preview / buffer
angles, raw buffer and upright frame sizes, stage aspect, interface and device orientation, active
format, dynamic aspect ratio and Center Stage, as they were on the camera screen and now. The same
line is logged once per camera start (os_log, subsystem `com.chasebro.booth`, category `camera`:
Console.app or a sysdiagnose).

In the Simulator, a fake sensor built from a physical model of the hardware (`SensorMount`: which
device edge the sensor's top row faces, which way it looks; the unit tests check `builtInAngle`
against it) sees an up arrow (plus a block at the right edge to show mirroring) the way a real sensor
would, a fake coordinator reports the model's angles, and the frames go through the same path.
`-booth.fakeCamera connection180` (the front data output pre-rotates 180° and keeps it) and
`portraitNative` (a front camera upright with the port at the bottom) stress the other cases.
`testUpIsUpPortrait` (+ `…ConnectionRotated`, `…PortraitNativeSensor`) reads the screenshots back:
arrow up in the plain preview, the live dots and the captured photo on the review strip; selfie
preview mirrored, photo not. `testUpIsUpPhoneHeldSideways` covers the locked phone turned.

End-to-end against a local booth (nothing reaches the real printer):

```sh
cd photobooth && echo BOOTH_PIN=1234 > .dev.vars && npm run dev:e2e   # needs worker/ npm ci
# make a party active so the QR path runs (see UITests header), then:
cd ios && xcodebuild test -project PhotoBooth.xcodeproj -scheme PhotoBoothUITests \
  -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M4)'
```

`testGearTapHintsHoldOpens` (tap → hint, settings stay shut; hold → settings),
`testPrinterOfflineBadgeAndLabel` (the local booth has no printer, so it's offline)
and `testClassicIcons` write screenshots to `$BOOTH_SHOTS` (pass it as
`TEST_RUNNER_BOOTH_SHOTS=…` to xcodebuild). `testBundledPinShootPrintArchive` covers a fresh install with only a bundled PIN (build with a temporary `Booth.local.xcconfig` `BOOTH_PIN = 1234` for the local booth; skipped otherwise): straight to the camera, shoot, print, and the session reaches `/api/photos` with `orig-1.jpg`, `strip.png`, `printed: true`. `testFirstRunCoach` checks the pointing hand (shutter, then Print, gone after a print). `testUnlockShootReviewPrint` ignores any bundled PIN and unlocks the booth (3 photos, asked for: the default is 1). It checks that the party narrows the frames, then
shoots 3 photos. It reviews, bumps copies and prints. Then check
`/api/photos?day=…`: the session should have `orig-1..3.jpg` and `strip.png`,
with `printed: true`, `copies: 2` and `event: <party>`. The QR on the strip
decodes to `/a/<share>/<session id>`. The other tests: a saved PIN opens straight
to the camera and the share-the-booth sheet (theme bar + settings) shows the PIN
and both QR codes; share this photo on review shows the `/s/<token>` QR; the stage
has the slot's aspect; a `booth://setup` link lands on the camera; a rejected PIN
shows the lock screen (no share-the-booth button).
If signing the BoothCore resource bundle fails locally, add `CODE_SIGNING_ALLOWED=NO`.

## Ship (TestFlight)

```sh
cd ~/src/microapps
./micro link booth          # once, after the App Store Connect record exists (see microapps AGENTS.md)
./micro ship booth --wait
./micro internal booth      # family testers
```

## Differences from the web booth

- Faces come from Vision, not BlazeFace. Archive JPEGs come from ImageIO, not
  Safari's encoder. The strip itself is unaffected by either.
- Upright frames use AVFoundation's rotation coordinator (horizon level; see
  "Which way is up"), not the tilt-sensor maths in `orient.js`.
- The archive queue lives in Application Support, not IndexedDB, so iOS never
  evicts it. Uploads also get a little background time when the app goes to the
  background.
