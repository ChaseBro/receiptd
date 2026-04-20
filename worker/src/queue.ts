// Per-printer FIFO job queue, stored under a single KV key
// (printer:<id>:jobs). One key keeps the poll-path read cost at 1 KV read
// per poll regardless of queue depth.
//
// Tradeoff: KV get-then-put is not atomic, so two concurrent Fly appends
// can race and lose one job. Accepted for MVP (Fly runs 1 machine by
// default). If we ever run multi-region Fly, switch to per-job KV keys
// with `list` + a lexicographic `createdAt` prefix.

const MAX_QUEUE = 50;
const QUEUE_TTL_SEC = 7 * 24 * 3600; // 7d; individual jobs ack-pop or age out

export type JobSignal = {
  jobId: string;
  r2Key: string;
  contentType: string;
  createdAt: number; // unix ms
};

type JobQueue = {
  jobs: JobSignal[];
};

export const jobsKey = (printerId: string) => `printer:${printerId}:jobs`;

// Legacy: single-slot entries lived at `printer:<id>:job` (singular). Keep
// the accessor so a passing-by cleanup can find them. New writes never go
// through this key.
export const legacyJobKey = (printerId: string) => `printer:${printerId}:job`;

/**
 * Read and normalize the printer's queue. Accepts legacy single-slot
 * values by wrapping them into a one-element list, so deploys during
 * in-flight jobs don't drop them.
 */
async function loadQueue(kv: KVNamespace, printerId: string): Promise<JobQueue> {
  const [raw, legacy] = await Promise.all([
    kv.get(jobsKey(printerId)),
    kv.get(legacyJobKey(printerId)),
  ]);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.jobs)) return parsed as JobQueue;
    } catch {
      // fall through
    }
  }
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as JobSignal;
      if (parsed?.jobId) return { jobs: [parsed] };
    } catch {
      // fall through
    }
  }
  return { jobs: [] };
}

async function saveQueue(kv: KVNamespace, printerId: string, q: JobQueue): Promise<void> {
  if (q.jobs.length === 0) {
    await kv.delete(jobsKey(printerId));
    return;
  }
  await kv.put(jobsKey(printerId), JSON.stringify(q), { expirationTtl: QUEUE_TTL_SEC });
}

export type EnqueueResult = {
  depth: number;
  evicted: JobSignal | null;
};

/**
 * Append a job. If the queue is already at MAX_QUEUE, the oldest entry is
 * evicted (FIFO drop) and returned so the caller can clean up its R2 object.
 * Not atomic — caller must accept rare lost writes under concurrent append.
 */
export async function enqueue(
  kv: KVNamespace,
  printerId: string,
  sig: JobSignal,
): Promise<EnqueueResult> {
  const q = await loadQueue(kv, printerId);
  let evicted: JobSignal | null = null;
  if (q.jobs.length >= MAX_QUEUE) {
    evicted = q.jobs.shift() ?? null;
  }
  q.jobs.push(sig);
  await saveQueue(kv, printerId, q);
  return { depth: q.jobs.length, evicted };
}

/**
 * Return the head of the queue without modifying it.
 * Used by POST poll and GET binary fetch.
 */
export async function peek(kv: KVNamespace, printerId: string): Promise<JobSignal | null> {
  const q = await loadQueue(kv, printerId);
  return q.jobs[0] ?? null;
}

/**
 * Pop the head if its jobId matches `token`. If `token` is missing
 * (null, undefined, or empty string), pop unconditionally. If the head
 * doesn't match a non-empty token, the ack is dropped silently — this
 * prevents a slow printer's DELETE for an older job from wiping a newer
 * one.
 */
export async function ackPop(
  kv: KVNamespace,
  printerId: string,
  token: string | null,
): Promise<JobSignal | null> {
  const q = await loadQueue(kv, printerId);
  if (q.jobs.length === 0) return null;
  const head = q.jobs[0]!;
  // Only enforce the token check when the printer actually sent one.
  // Empty string is treated the same as absent, matching JS falsy
  // convention so the guard's intent is obvious on inspection.
  if (token !== null && token !== "" && head.jobId !== token) return null;
  q.jobs.shift();
  await saveQueue(kv, printerId, q);
  return head;
}

/**
 * Clear the entire queue for a printer. Returns the evicted signals so
 * the caller can clean up R2.
 */
export async function drain(kv: KVNamespace, printerId: string): Promise<JobSignal[]> {
  const q = await loadQueue(kv, printerId);
  await Promise.all([
    kv.delete(jobsKey(printerId)),
    kv.delete(legacyJobKey(printerId)),
  ]);
  return q.jobs;
}
