// receiptd photo booth — serverless edition.
//
// No Fly, no laptop: the browser composes and dithers the strip to a 1-bit
// 576px raster, this Worker wraps it in StarPRNT (the same bytes cputil emits
// for an `[image]` + `[cut]` job) and drops it on the printer's existing
// CloudPRNT queue in KV/R2. The receiptd-cprnt Worker serves it on the
// printer's next poll over WiFi.

import { enqueue, jobsKey, type JobSignal } from "../../worker/src/queue";
import { buildStarPRNT, RASTER_WIDTH_PX } from "./starprnt";

interface Env {
  ASSETS: Fetcher;
  JOBS_KV: KVNamespace;
  JOBS_R2: R2Bucket;
  PRINTER_ID: string;
  BOOTH_PIN: string;
}

const STARPRNT_MEDIA = "application/vnd.star.starprnt";
const MAX_HEIGHT_PX = 4000; // ~50cm of paper
const MAX_BODY = 2 * 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function pinOK(req: Request, env: Env): Promise<boolean> {
  if (!env.BOOTH_PIN) return false;
  const got = req.headers.get("x-booth-pin") ?? "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(got)),
    crypto.subtle.digest("SHA-256", enc.encode(env.BOOTH_PIN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function queueIds(env: Env): Promise<string[]> {
  const raw = await env.JOBS_KV.get(jobsKey(env.PRINTER_ID));
  if (!raw) return [];
  try {
    const q = JSON.parse(raw) as { jobs?: JobSignal[] };
    return (q.jobs ?? []).map((j) => j.jobId);
  } catch {
    return [];
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!(await pinOK(req, env))) return json(401, { error: "bad_pin" });

    if (url.pathname === "/api/unlock" && req.method === "POST") {
      return json(200, { ok: true });
    }

    // POST /api/print { width: 576, height, bits: base64 } — 1 bit/px, MSB
    // first, 1 = black, rows packed to width/8 bytes.
    if (url.pathname === "/api/print" && req.method === "POST") {
      if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) {
        return json(413, { error: "too_large" });
      }
      let body: { width?: unknown; height?: unknown; bits?: unknown };
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid_body" });
      }
      const { width, height, bits } = body;
      if (
        width !== RASTER_WIDTH_PX ||
        typeof height !== "number" || !Number.isInteger(height) ||
        height < 1 || height > MAX_HEIGHT_PX ||
        typeof bits !== "string"
      ) {
        return json(400, { error: "invalid_raster" });
      }
      let raster: Uint8Array;
      try {
        raster = b64decode(bits);
      } catch {
        return json(400, { error: "invalid_base64" });
      }
      if (raster.length !== (RASTER_WIDTH_PX / 8) * height) {
        return json(400, { error: "raster_size_mismatch" });
      }

      const jobId = `booth-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      const r2Key = `jobs/${jobId}.bin`;
      await env.JOBS_R2.put(r2Key, buildStarPRNT(raster, height), {
        httpMetadata: { contentType: STARPRNT_MEDIA },
      });
      const res = await enqueue(env.JOBS_KV, env.PRINTER_ID, {
        jobId,
        r2Key,
        contentType: STARPRNT_MEDIA,
        createdAt: Date.now(),
      });
      if (res.evicted) {
        ctx.waitUntil(env.JOBS_R2.delete(res.evicted.r2Key).catch(() => {}));
      }
      return json(201, { id: jobId, status: "pending", position: res.depth });
    }

    // GET /api/jobs/:id — "completed" once the printer has acked (popped it).
    const m = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === "GET") {
      const ids = await queueIds(env);
      const idx = ids.indexOf(m[1]!);
      return idx === -1
        ? json(200, { id: m[1], status: "completed" })
        : json(200, { id: m[1], status: idx === 0 ? "printing" : "pending", position: idx + 1 });
    }

    return json(404, { error: "not_found" });
  },
} satisfies ExportedHandler<Env>;
