// How many copies to print. Pure logic (no DOM) so it runs under node --test.

export const MIN_COPIES = 1;
export const MAX_COPIES = 6;          // keep in sync with MAX_COPIES in src/index.ts
export const MIN_FACE_SCORE = 0.6;    // BlazeFace confidence to count a face

/** Any value → an integer copy count in MIN_COPIES..MAX_COPIES (bad input → 1). */
export function clampCopies(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return MIN_COPIES;
  return Math.min(MAX_COPIES, Math.max(MIN_COPIES, v));
}

/** Faces in one frame: detections ({ categories: [{ score }] }) at or above minScore. */
export function facesInFrame(detections, minScore = MIN_FACE_SCORE) {
  if (!Array.isArray(detections)) return 0;
  return detections.filter((d) => (d?.categories?.[0]?.score ?? 0) >= minScore).length;
}

/**
 * Most faces seen in any frame of the strip (everyone may not be in every
 * shot), or null when detection didn't run.
 */
export function maxFaces(counts) {
  if (!Array.isArray(counts) || counts.length === 0) return null;
  const ok = counts.filter((c) => Number.isInteger(c) && c >= 0);
  return ok.length ? Math.max(...ok) : null;
}

/** Default copies for a strip: one per face, clamped; 1 if no faces or no detector. */
export function defaultCopies(counts) {
  const n = maxFaces(counts);
  return n ? clampCopies(n) : MIN_COPIES;
}

/** Settings defaults: copies to start with, and the most copies a kid can pick (hard cap MAX_COPIES). */
export const START_COPIES = 1;
export const KID_MAX_COPIES = 3;

/** The kid's limit: settings → "most copies a kid can pick", 1..MAX_COPIES. */
export function kidMax(max = KID_MAX_COPIES) { return clampCopies(max); }

/**
 * Copies on the review screen: one per face (defaultCopies), never below the "copies to start
 * with" setting, never above the kid's limit.
 */
export function startCopies(counts, start = START_COPIES, max = KID_MAX_COPIES) {
  const top = kidMax(max);
  return Math.min(top, Math.max(clampCopies(start), defaultCopies(counts)));
}
