// Face detection for the copies picker (and face-aware tone): MediaPipe Tasks
// Vision face detector (BlazeFace short-range), self-hosted under
// ./vendor/mediapipe/ (see vendor/README.md). Works on iPad Safari, which has
// no FaceDetector API.
//
// Everything here is best effort: if the ~4 MB (gzip) WASM fails to load or
// is slow, callers get null and the booth defaults to 1 copy.

import { facesInFrame, MIN_FACE_SCORE } from "./copies.js";

const BASE = new URL("./vendor/mediapipe/", import.meta.url).href.replace(/\/$/, "");
let loading = null;

/** Start loading the detector (idempotent). Resolves to the detector or null. */
export function loadFaceDetector() {
  loading ??= (async () => {
    const { FilesetResolver, FaceDetector } = await import("./vendor/mediapipe/vision_bundle.mjs");
    const fileset = await FilesetResolver.forVisionTasks(BASE);
    return FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${BASE}/blaze_face_short_range.tflite`, delegate: "CPU" },
      runningMode: "IMAGE",
      minDetectionConfidence: MIN_FACE_SCORE,
    });
  })().catch((err) => {
    console.warn("face detector unavailable", err);
    setTimeout(() => { loading = null; }, 60000);   // allow a retry later
    return null;
  });
  return loading;
}

/**
 * Face boxes per frame: `[[{ x, y, w, h, score }], …]` in each frame's pixel
 * coords (frames as passed in, i.e. after grab()'s upright rotation), or null
 * if the detector isn't ready within `waitMs` or detection throws. Only boxes
 * at or above MIN_FACE_SCORE are kept, so `boxes[i].length` is the face count.
 */
export async function detectFaces(frames, waitMs = 4000) {
  const detector = await Promise.race([loadFaceDetector(), new Promise((r) => setTimeout(() => r(null), waitMs))]);
  if (!detector) return null;
  try {
    return frames.map((f) => toBoxes(detector.detect(f).detections));
  } catch (err) {
    console.warn("face detection failed", err);
    return null;
  }
}

/** MediaPipe detections → plain boxes, confident ones only. */
export function toBoxes(detections, minScore = MIN_FACE_SCORE) {
  if (!Array.isArray(detections)) return [];
  return detections.filter((d) => d?.boundingBox && facesInFrame([d], minScore) === 1).map((d) => {
    const b = d.boundingBox;
    return { x: b.originX, y: b.originY, w: b.width, h: b.height, score: d.categories[0].score };
  });
}

/**
 * Boxes in a w×h frame → the same boxes after rotating that frame clockwise
 * by `deg` (0/90/180/270), matching rotate() in index.html (the ↻ button).
 */
export function rotateBoxes(boxes, w, h, deg) {
  const d = ((deg % 360) + 360) % 360;
  return boxes.map((b) => {
    if (d === 90) return { ...b, x: h - b.y - b.h, y: b.x, w: b.h, h: b.w };
    if (d === 180) return { ...b, x: w - b.x - b.w, y: h - b.y - b.h };
    if (d === 270) return { ...b, x: b.y, y: w - b.x - b.w, w: b.h, h: b.w };
    return { ...b };
  });
}
