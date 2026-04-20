// HMAC verification for Fly → Worker admin requests, and HTTP Basic for printer polls.

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: ArrayBuffer): string {
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  return bytesToHex(await crypto.subtle.digest("SHA-256", buf));
}

/**
 * Verify an HMAC-signed request from Fly.
 *
 * Signed string: `${timestamp}.${method}.${path}.${bodySha256}`
 * Headers: `X-Timestamp` (unix ms), `X-Signature` (hex hmac-sha256)
 *
 * Rejects if timestamp drift > 5 minutes (replay protection).
 */
export async function verifyAdminSignature(
  req: Request,
  secret: string,
  bodyBytes: ArrayBuffer,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sigHex = req.headers.get("X-Signature");
  const tsHeader = req.headers.get("X-Timestamp");
  if (!sigHex || !tsHeader) return { ok: false, reason: "missing signature headers" };

  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const skewMs = Math.abs(Date.now() - ts);
  if (skewMs > 5 * 60 * 1000) return { ok: false, reason: "timestamp skew" };

  const url = new URL(req.url);
  const bodyHash = await sha256Hex(bodyBytes);
  const signedString = `${ts}.${req.method}.${url.pathname}.${bodyHash}`;

  const key = await hmacKey(secret);
  let expected: Uint8Array;
  try {
    expected = hexToBytes(sigHex);
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }
  const valid = await crypto.subtle.verify("HMAC", key, expected, encoder.encode(signedString));
  return valid ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/**
 * Parse `Authorization: Basic <b64>` → `{user, pass}`, or null.
 */
export function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice("Basic ".length));
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

/**
 * Constant-time string compare. Both inputs must be ASCII / UTF-8 safe.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
