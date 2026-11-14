// Pure per-printer queue logic, shared by the PrinterQueue Durable Object
// (queue.ts) and unit tests (worker/test/). No Workers imports here so the
// tests can run under plain `node --test`.

export const MAX_QUEUE = 50;

export type JobSignal = {
  jobId: string;
  r2Key: string;
  contentType: string;
  createdAt: number; // unix ms
};

export type JobStatus =
  | { status: "printing"; position: 1 }
  | { status: "pending"; position: number }
  | { status: "completed" };

// Pre-DO KV keys. Only read (once per printer) by the DO's import step.
export const jobsKey = (printerId: string) => `printer:${printerId}:jobs`;
export const legacyJobKey = (printerId: string) => `printer:${printerId}:job`;

/**
 * Append jobs in order; if the queue exceeds MAX_QUEUE the oldest entries
 * are evicted (FIFO drop) and returned so the caller can delete their R2
 * objects.
 */
export function appendJobs(
  jobs: readonly JobSignal[],
  sigs: readonly JobSignal[],
  max = MAX_QUEUE,
): { jobs: JobSignal[]; evicted: JobSignal[] } {
  const next = [...jobs, ...sigs];
  const evicted = next.length > max ? next.splice(0, next.length - max) : [];
  return { jobs: next, evicted };
}

/**
 * Pop the head if its jobId matches `token`. A missing token (null or "")
 * pops unconditionally. A non-matching token is dropped silently — a slow
 * printer's DELETE for an older job must not wipe a newer one.
 */
export function ackHead(
  jobs: readonly JobSignal[],
  token: string | null,
): { jobs: JobSignal[]; popped: JobSignal | null } {
  const head = jobs[0];
  if (!head) return { jobs: [...jobs], popped: null };
  if (token !== null && token !== "" && head.jobId !== token) {
    return { jobs: [...jobs], popped: null };
  }
  return { jobs: jobs.slice(1), popped: head };
}

/** Head = printing, later = pending (1-based position), absent = completed. */
export function statusOf(jobs: readonly JobSignal[], jobId: string): JobStatus {
  const idx = jobs.findIndex((j) => j.jobId === jobId);
  if (idx === -1) return { status: "completed" };
  if (idx === 0) return { status: "printing", position: 1 };
  return { status: "pending", position: idx + 1 };
}

/**
 * Normalize the pre-DO KV values (`{jobs:[...]}` list, or a legacy
 * single-slot JobSignal) into a job list. Malformed values yield [].
 */
export function parseKvQueue(raw: string | null, legacy: string | null): JobSignal[] {
  const valid = (j: unknown): j is JobSignal =>
    !!j && typeof j === "object" &&
    typeof (j as JobSignal).jobId === "string" &&
    typeof (j as JobSignal).r2Key === "string";
  const out: JobSignal[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.jobs)) out.push(...parsed.jobs.filter(valid));
    } catch {
      // ignore
    }
  }
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy);
      if (valid(parsed) && !out.some((j) => j.jobId === parsed.jobId)) out.unshift(parsed);
    } catch {
      // ignore
    }
  }
  for (const j of out) {
    if (typeof j.contentType !== "string") j.contentType = "application/vnd.star.starprnt";
    if (typeof j.createdAt !== "number") j.createdAt = 0;
  }
  return out;
}

/**
 * How long after its first access the DO keeps re-reading the pre-DO KV
 * queue. Covers the rollout gap where receiptd-cprnt (DO) is live but an
 * older receiptd-booth is still appending to KV — and KV's own propagation
 * delay (~60s) on top. After the window the KV keys are deleted once.
 */
export const LEGACY_KV_WINDOW_MS = 30 * 60 * 1000;
/** Min gap between KV re-reads during the window (polls are ~2s apart). */
export const LEGACY_KV_RECHECK_MS = 2000;

/**
 * Merge jobs read from the pre-DO KV queue into the DO queue. A job is taken
 * only the first time its id is seen: `importedIds` remembers every id ever
 * imported, so a job that was imported and since acked is not re-delivered
 * when an old writer's read-modify-write puts it back into KV (or a stale
 * edge-cached KV read returns it again). Appended in KV order, after the
 * current queue, subject to the usual cap.
 */
export function mergeLegacy(
  jobs: readonly JobSignal[],
  importedIds: readonly string[],
  kvJobs: readonly JobSignal[],
  max = MAX_QUEUE,
): { jobs: JobSignal[]; evicted: JobSignal[]; added: JobSignal[]; importedIds: string[] } {
  const known = new Set([...importedIds, ...jobs.map((j) => j.jobId)]);
  const added: JobSignal[] = [];
  for (const j of kvJobs) {
    if (known.has(j.jobId)) continue;
    known.add(j.jobId);
    added.push(j);
  }
  const ids = [...importedIds, ...added.map((j) => j.jobId)];
  if (added.length === 0) return { jobs: [...jobs], evicted: [], added, importedIds: ids };
  return { ...appendJobs(jobs, added, max), added, importedIds: ids };
}
