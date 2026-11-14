// receiptd photo booth — serverless edition.
//
// No Fly, no laptop: the browser composes and dithers the strip to a 1-bit
// 576px raster, this Worker wraps it in StarPRNT (the same bytes cputil emits
// for an `[image]` + `[cut]` job) and drops it on the printer's existing
// CloudPRNT queue (PrinterQueue Durable Object, bodies in R2). The
// receiptd-cprnt Worker owns the DO class and serves it on the printer's next
// poll over WiFi.

import { enqueueMany, jobStatus, type JobSignal, type QueueNamespace } from "../../worker/src/queue";
import { triggerPrinterPoll, type MqttEnv } from "../../worker/src/mqtt";
import { buildStarPRNT, RASTER_WIDTH_PX } from "./starprnt";
import { handleArchive } from "./archive-api";

interface Env extends MqttEnv {
  ASSETS: Fetcher;
  CF_VERSION_METADATA?: { id: string };
  PRINTER_QUEUE: QueueNamespace;
  JOBS_R2: R2Bucket;
  PRINTER_ID: string;
  PRINTER_MAC?: string;
  BOOTH_PIN: string;
  /** Private photo archive (receiptd-photos). Never served publicly. */
  PHOTOS?: R2Bucket;
  /** Key prefix inside PHOTOS: "" in prod, "staging/" in staging. */
  ARCHIVE_PREFIX?: string;
}

const STARPRNT_MEDIA = "application/vnd.star.starprnt";
const MAX_HEIGHT_PX = 4000; // ~50cm of paper
const MAX_BODY = 4 * 1024 * 1024; // up to 6 per-copy bitmaps
const MAX_COPIES = 6; // keep in sync with public/copies.js

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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    // Public, no PIN: client crash reports → Workers logs (wrangler tail).
    if (url.pathname === "/api/log" && req.method === "POST") {
      const text = (await req.text()).slice(0, 4000);
      console.log("client-error", text);
      return new Response(null, { status: 204 });
    }
    // Public, no PIN: lets idle kiosks notice a new deploy and reload.
    if (url.pathname === "/api/version") return json(200, { id: env.CF_VERSION_METADATA?.id ?? "dev" });
    if (!(await pinOK(req, env))) return json(401, { error: "bad_pin" });

    if (url.pathname === "/api/unlock" && req.method === "POST") {
      return json(200, { ok: true });
    }

    // POST /api/print { width: 576, height, bits: base64, copies?: 1..6 } —
    // 1 bit/px, MSB first, 1 = black, rows packed to width/8 bytes. Returns
    // { id, ids } — one job per copy, in print order.
    if (url.pathname === "/api/print" && req.method === "POST") {
      if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) {
        return json(413, { error: "too_large" });
      }
      let body: { width?: unknown; height?: unknown; bits?: unknown; bitsList?: unknown; density?: unknown; speed?: unknown; copies?: unknown };
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

      const intIn = (v: unknown, lo: number, hi: number) =>
        typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;
      const settings = { density: intIn(body.density, 0, 6), speed: intIn(body.speed, 0, 2) };

      const copies = body.copies === undefined ? 1 : intIn(body.copies, 1, MAX_COPIES);
      if (copies === undefined) return json(400, { error: "invalid_copies" });

      // One R2 object per copy: receiptd-cprnt deletes a job's r2Key when the
      // printer acks it, so a shared key would vanish after the first copy.
      const base = `booth-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      // Optional per-copy bitmaps (later copies are thinned for a hotter head).
      let rasters: Uint8Array[] = [raster];
      if (body.bitsList !== undefined) {
        if (!Array.isArray(body.bitsList) || body.bitsList.length !== copies || !body.bitsList.every((b) => typeof b === "string")) {
          return json(400, { error: "invalid_bits_list" });
        }
        try {
          rasters = (body.bitsList as string[]).map(b64decode);
        } catch {
          return json(400, { error: "invalid_base64" });
        }
        if (rasters.some((r) => r.length !== raster.length)) return json(400, { error: "raster_size_mismatch" });
      }
      const bins = rasters.map((r) => buildStarPRNT(r, height, settings));
      // All copies go out as ONE job: each copy is a complete StarPRNT stream
      // (init … raster … feed + cut) concatenated, so the printer runs them
      // back to back instead of poll → fetch → ack → wait between copies.
      const parts = Array.from({ length: copies }, (_, i) => bins[Math.min(i, bins.length - 1)]!);
      const bin = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      parts.reduce((o, p) => (bin.set(p, o), o + p.length), 0);
      const sig: JobSignal = { jobId: base, r2Key: `jobs/${base}.bin`, contentType: STARPRNT_MEDIA, createdAt: Date.now() };
      await env.JOBS_R2.put(sig.r2Key, bin, { httpMetadata: { contentType: STARPRNT_MEDIA } });
      const res = await enqueueMany(env.PRINTER_QUEUE, env.PRINTER_ID, [sig]);
      // Wake the printer now via MQTT (no-op unless configured; never throws).
      ctx.waitUntil(triggerPrinterPoll(env, env.PRINTER_MAC).then((r) => console.log("mqtt-trigger", JSON.stringify(r))));
      for (const ev of res.evicted) ctx.waitUntil(env.JOBS_R2.delete(ev.r2Key).catch(() => {}));
      return json(201, { id: base, ids: [base], copies, status: "pending", position: res.depth });
    }

    // Photo archive: POST /api/archive, GET /api/photos{,/days,/file}.
    const archived = await handleArchive(req, url, env);
    if (archived) return archived;

    // GET /api/jobs/:id — "completed" once the printer has acked (popped it).
    const m = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === "GET") {
      const s = await jobStatus(env.PRINTER_QUEUE, env.PRINTER_ID, m[1]!);
      return json(200, { id: m[1], ...s });
    }

    return json(404, { error: "not_found" });
  },
} satisfies ExportedHandler<Env>;
