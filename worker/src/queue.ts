// Per-printer FIFO job queue: one SQLite-backed Durable Object instance per
// printerId (idFromName(printerId)). Strongly consistent — a job enqueued by
// the booth is visible to the printer's very next poll, and an ack is
// visible to the booth's very next status check. (The previous KV queue was
// eventually consistent, with edge-cached reads up to ~60s, and its
// get-then-put append could lose jobs under concurrent writers.)
//
// Atomicity: every method reads the queue, applies a pure transform from
// queue-core.ts, and writes it back using the synchronous SQL API with no
// await in between, so the DO's single-threaded execution makes each call
// atomic. Job bodies stay in R2; callers own R2 puts/deletes.
//
// Both receiptd-cprnt (this script, which defines the class) and
// receiptd-booth (via `script_name = "receiptd-cprnt"`) call it over RPC.

import { DurableObject } from "cloudflare:workers";
import {
  ackHead,
  appendJobs,
  jobsKey,
  LEGACY_KV_RECHECK_MS,
  LEGACY_KV_WINDOW_MS,
  legacyJobKey,
  mergeLegacy,
  parseKvQueue,
  statusOf,
  type JobSignal,
  type JobStatus,
} from "./queue-core";

export { jobsKey, legacyJobKey, MAX_QUEUE, type JobSignal, type JobStatus } from "./queue-core";

type QueueEnv = {
  JOBS_KV: KVNamespace;
  JOBS_R2?: R2Bucket;
  // Override for LEGACY_KV_WINDOW_MS (seconds); staging sets it short for tests.
  LEGACY_KV_WINDOW_SEC?: string;
};

export class PrinterQueue extends DurableObject<QueueEnv> {
  private ready = false;
  private legacyDone = false;
  private lastKvCheck = 0;

  constructor(ctx: DurableObjectState, env: QueueEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  private get(k: string): string | null {
    const rows = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM state WHERE k = ?", k).toArray();
    return rows[0]?.v ?? null;
  }

  private set(k: string, v: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO state (k, v) VALUES (?, ?)", k, v);
  }

  private load(): JobSignal[] {
    const raw = this.get("jobs");
    return raw ? (JSON.parse(raw) as JobSignal[]) : [];
  }

  private save(jobs: JobSignal[]): void {
    this.set("jobs", JSON.stringify(jobs));
  }

  private windowMs(): number {
    const s = Number(this.env.LEGACY_KV_WINDOW_SEC);
    return Number.isFinite(s) && s >= 0 ? s * 1000 : LEGACY_KV_WINDOW_MS;
  }

  /**
   * Read the pre-DO KV queue and merge any job ids not seen before. The KV
   * read is async, but the merge (load → mergeLegacy → save) is synchronous,
   * so concurrent imports can't double-insert: the second sees the first's
   * importedIds.
   */
  private async importLegacy(printerId: string): Promise<void> {
    const [raw, legacy] = await Promise.all([
      this.env.JOBS_KV.get(jobsKey(printerId)),
      this.env.JOBS_KV.get(legacyJobKey(printerId)),
    ]);
    if (raw === null && legacy === null) return;
    const prev = JSON.parse(this.get("importedIds") ?? "[]") as string[];
    const r = mergeLegacy(this.load(), prev, parseKvQueue(raw, legacy));
    if (r.added.length === 0) return;
    this.save(r.jobs);
    this.set("importedIds", JSON.stringify(r.importedIds));
    for (const ev of r.evicted) this.env.JOBS_R2?.delete(ev.r2Key).catch(() => {});
    console.log("kv-imported", printerId, r.added.map((j) => j.jobId).join(","));
  }

  /** End the dual-read window: stop reading KV and delete the old keys once. */
  private async finishLegacy(printerId: string): Promise<void> {
    if (this.get("legacyDone") !== null) return;
    this.set("legacyDone", String(Date.now()));
    await Promise.all([
      this.env.JOBS_KV.delete(jobsKey(printerId)),
      this.env.JOBS_KV.delete(legacyJobKey(printerId)),
    ]).catch((e) => console.error("kv-legacy-delete", printerId, String(e)));
  }

  /**
   * Pre-DO KV queue import. First access imports under blockConcurrencyWhile
   * so nothing observes the queue before the import lands. Then, for
   * LEGACY_KV_WINDOW_MS after that, KV is re-read (at most every
   * LEGACY_KV_RECHECK_MS) so jobs appended by a not-yet-redeployed booth are
   * still delivered; mergeLegacy's importedIds keeps acked jobs from coming
   * back. The first access after the window deletes the KV keys.
   */
  private async ensureReady(printerId: string): Promise<void> {
    if (!this.ready) {
      await this.ctx.blockConcurrencyWhile(async () => {
        if (this.ready) return;
        if (this.get("migrated") === null) {
          await this.importLegacy(printerId);
          this.set("migrated", String(Date.now()));
          this.lastKvCheck = Date.now();
        }
        this.ready = true;
      });
      // Fall through: a fresh instance (after eviction) must still run the
      // window check below, or the KV keys may never be cleaned up.
    }
    if (this.legacyDone || this.get("legacyDone") !== null) {
      this.legacyDone = true;
      return;
    }
    const now = Date.now();
    if (now - Number(this.get("migrated")) > this.windowMs()) {
      this.legacyDone = true;
      await this.importLegacy(printerId);
      await this.finishLegacy(printerId);
      return;
    }
    if (now - this.lastKvCheck < LEGACY_KV_RECHECK_MS) return;
    this.lastKvCheck = now;
    await this.importLegacy(printerId);
  }

  async enqueue(printerId: string, sigs: JobSignal[]): Promise<{ depth: number; evicted: JobSignal[] }> {
    await this.ensureReady(printerId);
    const { jobs, evicted } = appendJobs(this.load(), sigs);
    this.save(jobs);
    return { depth: jobs.length, evicted };
  }

  async peek(printerId: string): Promise<JobSignal | null> {
    await this.ensureReady(printerId);
    return this.load()[0] ?? null;
  }

  async ackPop(printerId: string, token: string | null): Promise<JobSignal | null> {
    await this.ensureReady(printerId);
    const { jobs, popped } = ackHead(this.load(), token);
    if (popped) this.save(jobs);
    return popped;
  }

  async drain(printerId: string): Promise<JobSignal[]> {
    await this.ensureReady(printerId);
    const jobs = this.load();
    this.save([]);
    // An explicit drain also ends the KV dual-read, so old KV entries can't
    // refill the queue afterwards.
    this.legacyDone = true;
    await this.finishLegacy(printerId);
    return jobs;
  }

  async status(printerId: string, jobId: string): Promise<JobStatus> {
    await this.ensureReady(printerId);
    return statusOf(this.load(), jobId);
  }
}

// ---------------------------------------------------------------------------
// Caller helpers. Same names/semantics as the old KV module, but they take the
// PRINTER_QUEUE namespace instead of the KV binding.
// ---------------------------------------------------------------------------

export type QueueNamespace = DurableObjectNamespace<PrinterQueue>;

const stub = (ns: QueueNamespace, printerId: string) => ns.get(ns.idFromName(printerId));

export type EnqueueResult = { depth: number; evicted: JobSignal | null };
export type EnqueueManyResult = { depth: number; evicted: JobSignal[] };

/** Append one job; FIFO-evicts the oldest at MAX_QUEUE (returned for R2 cleanup). */
export async function enqueue(ns: QueueNamespace, printerId: string, sig: JobSignal): Promise<EnqueueResult> {
  const r = await stub(ns, printerId).enqueue(printerId, [sig]);
  return { depth: r.depth, evicted: r.evicted[0] ?? null };
}

/** Append several jobs atomically, contiguous (e.g. copies of one booth strip). */
export async function enqueueMany(ns: QueueNamespace, printerId: string, sigs: JobSignal[]): Promise<EnqueueManyResult> {
  return stub(ns, printerId).enqueue(printerId, sigs);
}

/** Head of the queue, unmodified. Used by POST poll and GET body fetch. */
export async function peek(ns: QueueNamespace, printerId: string): Promise<JobSignal | null> {
  return stub(ns, printerId).peek(printerId);
}

/** Pop the head if it matches `token` (or unconditionally when token is null/""). */
export async function ackPop(ns: QueueNamespace, printerId: string, token: string | null): Promise<JobSignal | null> {
  return stub(ns, printerId).ackPop(printerId, token);
}

/** Clear the queue; returns dropped signals for R2 cleanup. */
export async function drain(ns: QueueNamespace, printerId: string): Promise<JobSignal[]> {
  return stub(ns, printerId).drain(printerId);
}

/** printing (head) / pending + 1-based position / completed (no longer queued). */
export async function jobStatus(ns: QueueNamespace, printerId: string, jobId: string): Promise<JobStatus> {
  return stub(ns, printerId).status(printerId, jobId);
}
