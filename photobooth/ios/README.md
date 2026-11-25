# Photo Booth for iPhone and iPad

A native (SwiftUI) version of the booth. It uses the same Worker and printer
queue as the web booth, and prints the same strips. Registered in
`~/src/microapps` as `booth`, so `micro` builds and ships it.

It does what the web booth does: camera capture (1 or 3 shots, countdown ring,
flash), the theme picker, ↻ per photo, copies picker (defaults to one copy per
face, found with Vision), and printing via `POST /api/print` + `/api/jobs/:id`
(`x-booth-pin`), with MQTT nudges and the anti-mash cooldown. It also follows
the active party (`/api/events/active`: its frames, its footer, a QR on each
strip that links to that guest's album page) and runs the background archive
upload (`POST /api/archive`: originals, then the printed `strip.png`). The kid
screens use stickers, not words. Long-press the top-right corner for 1.5 s to
open the adult settings.

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

- **Printed dots: identical.** All 18.9M dots of the 24 fixture strips match.
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

### Share booth

The small 📤 sticker at the top left of the camera stage (and settings → Share
booth) hands the booth to another phone: two links, each as a big QR code and a
share-sheet button. Both carry the PIN (`BoothLinks` in `BoothCore/Share.swift`,
mirrored by `public/share.js`):

- **Booth on the web**: `https://booth.receiptd.sh/#pin=<PIN>`.
- **Booth app (TestFlight)**: `https://join.receiptd.sh/booth?k=…#server=<server>&key=<PIN>`
  (`BoothLinks.join` = microapps `booth.join_url`). Before install: the
  TestFlight sign-up. After install: a universal link (AASA path `/booth`), so
  `Pairing` saves server + PIN and the app lands on the camera. `booth://setup#…`
  does the same.

End-to-end against a local booth (nothing reaches the real printer):

```sh
cd photobooth && echo BOOTH_PIN=1234 > .dev.vars && npm run dev:e2e   # needs worker/ npm ci
# make a party active so the QR path runs (see UITests header), then:
cd ios && xcodebuild test -project PhotoBooth.xcodeproj -scheme PhotoBoothUITests \
  -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M4)'
```

`testUnlockShootReviewPrint` ignores any bundled PIN and unlocks the booth. It checks that the party narrows the frames, then
shoots 3 photos. It reviews, bumps copies and prints. Then check
`/api/photos?day=…`: the session should have `orig-1..3.jpg` and `strip.png`,
with `printed: true`, `copies: 2` and `event: <party>`. The QR on the strip
decodes to `/a/<share>/<session id>`. The other tests: a saved PIN opens straight
to the camera and both share sheets show their QR codes; a `booth://setup` link
lands on the camera; a rejected PIN shows the lock screen (no share button).
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
- Upright frames use AVFoundation's rotation coordinator (horizon level), not
  the tilt-sensor maths in `orient.js`.
- The archive queue lives in Application Support, not IndexedDB, so iOS never
  evicts it. Uploads also get a little background time when the app goes to the
  background.
