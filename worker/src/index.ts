import { Hono } from "hono";
import { parseBasicAuth, timingSafeEqual, verifyAdminSignature } from "./auth";
import { ackPop, drain, enqueue, peek } from "./queue";
import { statusKey, updatePrinterStatus } from "./status";

export type Env = {
  JOBS_KV: KVNamespace;
  JOBS_R2: R2Bucket;
  FLY_HMAC_SECRET: string;
  JOB_SIGNAL_TTL: string;
};

const CPRNT_CONTENT_TYPE = "application/vnd.star.cloudprnt";
const STARPRNT_MEDIA = "application/vnd.star.starprnt";

const secretKey = (printerId: string) => `printer:${printerId}:secret`;

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Printer-facing: /cprnt/:printerId
// Protocol reference: Star CloudPRNT spec. Printer polls POST, GETs the job
// body, DELETEs to ack. HTTP Basic auth per printer.
// ---------------------------------------------------------------------------

async function requirePrinterAuth(
  req: Request,
  env: Env,
  printerId: string,
): Promise<Response | null> {
  const expected = await env.JOBS_KV.get(secretKey(printerId));
  if (!expected) {
    return new Response("unknown printer", { status: 404 });
  }
  const creds = parseBasicAuth(req.headers.get("Authorization"));
  if (!creds || creds.user !== printerId || !timingSafeEqual(creds.pass, expected)) {
    return new Response("unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="receiptd-cprnt"' },
    });
  }
  return null;
}

app.post("/cprnt/:printerId", async (c) => {
  const printerId = c.req.param("printerId");
  const unauth = await requirePrinterAuth(c.req.raw, c.env, printerId);
  if (unauth) return unauth;

  // Body is CloudPRNT JSON. Parse for status capture; best-effort on
  // malformed bodies — the printer response still goes out quickly.
  const bodyText = await c.req.raw.text();
  let parsed: unknown = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // ignore — status update will no-op
    }
  }
  c.executionCtx.waitUntil(updatePrinterStatus(c.env.JOBS_KV, printerId, parsed));

  const head = await peek(c.env.JOBS_KV, printerId);
  if (!head) {
    return c.json(
      {
        jobReady: false,
        mediaTypes: [STARPRNT_MEDIA],
        pollInterval: 5,
        deleteMethod: "DELETE",
      },
      200,
      { "Content-Type": CPRNT_CONTENT_TYPE },
    );
  }
  return c.json(
    {
      jobReady: true,
      mediaTypes: [head.contentType],
      jobToken: head.jobId,
      pollInterval: 5,
      deleteMethod: "DELETE",
    },
    200,
    { "Content-Type": CPRNT_CONTENT_TYPE },
  );
});

app.get("/cprnt/:printerId", async (c) => {
  const printerId = c.req.param("printerId");
  const unauth = await requirePrinterAuth(c.req.raw, c.env, printerId);
  if (unauth) return unauth;

  // CloudPRNT spec: printer may pass the `token` from the poll response as
  // a query param. When present, verify we're serving the expected job.
  const token = new URL(c.req.url).searchParams.get("token");
  const head = await peek(c.env.JOBS_KV, printerId);
  if (!head) return new Response("no job", { status: 404 });
  if (token && token !== head.jobId) {
    // Head advanced between poll and GET — printer should re-poll for the
    // new token rather than fetch stale.
    return new Response("token mismatch", { status: 409 });
  }

  const obj = await c.env.JOBS_R2.get(head.r2Key);
  if (!obj) return new Response("job binary missing", { status: 410 });

  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": head.contentType,
      "Content-Length": String(obj.size),
    },
  });
});

app.delete("/cprnt/:printerId", async (c) => {
  const printerId = c.req.param("printerId");
  const unauth = await requirePrinterAuth(c.req.raw, c.env, printerId);
  if (unauth) return unauth;

  // Pop only if the token matches the head — a DELETE for an older job
  // (e.g. a slow printer's ack that arrived after the queue advanced) is
  // silently dropped rather than clobbering newer jobs.
  const token = new URL(c.req.url).searchParams.get("token");
  const popped = await ackPop(c.env.JOBS_KV, printerId, token);
  if (popped) {
    // Fly is source of truth for job state; R2 cleanup is best-effort.
    c.executionCtx.waitUntil(c.env.JOBS_R2.delete(popped.r2Key).catch(() => {}));
  }
  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Admin-facing: Fly → Worker
// ---------------------------------------------------------------------------

/**
 * POST /admin/jobs
 * Body: raw StarPRNT binary (application/vnd.star.starprnt).
 * Headers: X-Printer-Id, X-Job-Id, X-Signature, X-Timestamp.
 * Effect: store binary in R2, set KV signal. Printer's next poll returns jobReady.
 */
app.post("/admin/jobs", async (c) => {
  const printerId = c.req.header("X-Printer-Id");
  const jobId = c.req.header("X-Job-Id");
  const contentType = c.req.header("Content-Type") ?? STARPRNT_MEDIA;
  if (!printerId || !jobId) {
    return c.json({ error: "missing X-Printer-Id or X-Job-Id" }, 400);
  }

  const bodyBytes = await c.req.raw.arrayBuffer();
  const verify = await verifyAdminSignature(c.req.raw, c.env.FLY_HMAC_SECRET, bodyBytes);
  if (!verify.ok) {
    return c.json({ error: verify.reason }, 401);
  }
  if (bodyBytes.byteLength === 0) {
    return c.json({ error: "empty body" }, 400);
  }

  const r2Key = `jobs/${jobId}.bin`;
  await c.env.JOBS_R2.put(r2Key, bodyBytes, {
    httpMetadata: { contentType },
  });

  const result = await enqueue(c.env.JOBS_KV, printerId, {
    jobId,
    r2Key,
    contentType,
    createdAt: Date.now(),
  });

  if (result.evicted) {
    // Queue was at cap — clean up the dropped job's R2 object.
    c.executionCtx.waitUntil(c.env.JOBS_R2.delete(result.evicted.r2Key).catch(() => {}));
  }

  return c.json({ jobId, r2Key, depth: result.depth, evicted: result.evicted?.jobId ?? null }, 201);
});

/**
 * PUT /admin/printers/:printerId/secret
 * Body: { secret: "<basic-auth-password>" } (JSON)
 * Used by Fly's pairing flow to provision per-printer HTTP Basic creds.
 */
app.put("/admin/printers/:printerId/secret", async (c) => {
  const printerId = c.req.param("printerId");
  const bodyBytes = await c.req.raw.arrayBuffer();
  const verify = await verifyAdminSignature(c.req.raw, c.env.FLY_HMAC_SECRET, bodyBytes);
  if (!verify.ok) return c.json({ error: verify.reason }, 401);

  let parsed: { secret?: string };
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  if (!parsed.secret || parsed.secret.length < 16) {
    return c.json({ error: "secret too short" }, 400);
  }
  await c.env.JOBS_KV.put(secretKey(printerId), parsed.secret);
  return c.json({ ok: true }, 200);
});

/**
 * GET /admin/printers/:printerId/status
 * Returns the last known status snapshot, or 404 if the printer has never
 * polled (or TTL expired). HMAC-signed like other admin endpoints.
 */
app.get("/admin/printers/:printerId/status", async (c) => {
  const printerId = c.req.param("printerId");
  const verify = await verifyAdminSignature(c.req.raw, c.env.FLY_HMAC_SECRET, new ArrayBuffer(0));
  if (!verify.ok) return c.json({ error: verify.reason }, 401);

  const raw = await c.env.JOBS_KV.get(statusKey(printerId));
  if (!raw) return c.json({ error: "no status" }, 404);
  return new Response(raw, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

app.delete("/admin/printers/:printerId/secret", async (c) => {
  const printerId = c.req.param("printerId");
  const bodyBytes = await c.req.raw.arrayBuffer();
  const verify = await verifyAdminSignature(c.req.raw, c.env.FLY_HMAC_SECRET, bodyBytes);
  if (!verify.ok) return c.json({ error: verify.reason }, 401);

  const dropped = await drain(c.env.JOBS_KV, printerId);
  await Promise.all([
    c.env.JOBS_KV.delete(secretKey(printerId)),
    c.env.JOBS_KV.delete(statusKey(printerId)),
    ...dropped.map((d) => c.env.JOBS_R2.delete(d.r2Key).catch(() => {})),
  ]);
  return new Response(null, { status: 204 });
});

// Healthcheck / sanity
app.get("/", (c) => c.text("receiptd-cprnt worker\n"));

export default app;
