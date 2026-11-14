// receiptd photo booth — a thin edge proxy in front of api.receiptd.sh.
//
// The browser never sees the receiptd API key. Guests unlock the booth with a
// shared PIN; the Worker checks it and forwards the composed photo strip to
// POST /v1/jobs, which dithers, converts to StarPRNT, and hands it to the
// CloudPRNT edge for the printer to pick up over WiFi.

interface Env {
  ASSETS: Fetcher;
  RECEIPTD_API: string;
  RECEIPTD_API_KEY: string;
  BOOTH_PIN: string;
  DITHER: string;
}

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // base64 payload cap

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function pinOK(req: Request, env: Env): Promise<boolean> {
  const got = req.headers.get("x-booth-pin") ?? "";
  if (!env.BOOTH_PIN) return false;
  // Constant-time compare via digests.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(got)),
    crypto.subtle.digest("SHA-256", enc.encode(env.BOOTH_PIN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function upstream(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env.RECEIPTD_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.RECEIPTD_API_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }
    if (!(await pinOK(req, env))) {
      return json(401, { error: "bad_pin" });
    }

    // POST /api/unlock — PIN check only.
    if (url.pathname === "/api/unlock" && req.method === "POST") {
      return json(200, { ok: true });
    }

    // POST /api/print { imageData: "data:image/png;base64,..." }
    if (url.pathname === "/api/print" && req.method === "POST") {
      const len = Number(req.headers.get("content-length") ?? "0");
      if (len > MAX_IMAGE_BYTES) return json(413, { error: "too_large" });
      let body: { imageData?: unknown };
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid_body" });
      }
      if (typeof body.imageData !== "string" || !body.imageData.startsWith("data:image/")) {
        return json(400, { error: "invalid_image" });
      }
      if (body.imageData.length > MAX_IMAGE_BYTES) return json(413, { error: "too_large" });

      const res = await upstream(env, "/v1/jobs", {
        method: "POST",
        body: JSON.stringify({ imageData: body.imageData, dither: env.DITHER || "atkinson" }),
      });
      const text = await res.text();
      if (!res.ok) {
        console.error("receiptd create failed", res.status, text);
        return json(502, { error: "print_failed", status: res.status });
      }
      const job = JSON.parse(text) as { id?: string; status?: string };
      return json(201, { id: job.id, status: job.status });
    }

    // GET /api/jobs/:id — status polling for the "printing…" screen.
    const m = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === "GET") {
      const res = await upstream(env, `/v1/jobs/${m[1]}`);
      if (!res.ok) return json(res.status, { error: "lookup_failed" });
      const job = (await res.json()) as { id?: string; status?: string; errorMsg?: string };
      return json(200, { id: job.id, status: job.status, error: job.errorMsg });
    }

    return json(404, { error: "not_found" });
  },
} satisfies ExportedHandler<Env>;
