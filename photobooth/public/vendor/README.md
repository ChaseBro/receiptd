# Vendored third-party files

Self-hosted so the booth works without a CDN at the party and nothing about
the guests' photos leaves the device (face detection runs locally in WASM).
Files are copied unmodified.

## `mediapipe/` — face counting for the copies picker

| file | source | sha256 |
|---|---|---|
| `vision_bundle.mjs` | npm `@mediapipe/tasks-vision@1.2.3` | `fb0c02c2…a7b9b5` |
| `vision_wasm_internal.js` | npm `@mediapipe/tasks-vision@1.2.3` (`wasm/`) | `2aa5fd3f…6d6309` |
| `vision_wasm_internal.wasm` | npm `@mediapipe/tasks-vision@1.2.3` (`wasm/`) | `225bc06c…aabf` |
| `blaze_face_short_range.tflite` | `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite` | `b4578f35…0152f` |

- License: **Apache-2.0** for both the Tasks Vision library
  (https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE) and the
  BlazeFace short-range model (model card:
  https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf).
- Only the single-threaded, non-module WASM variant is shipped (it is what
  `FilesetResolver.forVisionTasks()` loads by default); it needs no
  `SharedArrayBuffer` / cross-origin isolation. The source map referenced at
  the end of `vision_bundle.mjs` is not shipped.
- Size: ~15 MB on disk, ~4 MB gzip on the wire (the `.wasm` is 14.6 MB).
  Loaded lazily by `public/faces.js` after the camera starts, then served from
  the browser cache.

To update: download the tarball (`npm pack @mediapipe/tasks-vision@<ver>`),
copy the three files above, bump the version + hashes here, and check the
booth on iPad Safari.
