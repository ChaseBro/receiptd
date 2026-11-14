#!/usr/bin/env node
// End-to-end smoke test for the PrinterQueue Durable Object against a
// DEPLOYED receiptd-cprnt worker (normally receiptd-cprnt-staging). Simulates
// a CloudPRNT printer with a throwaway printer id; never touches real ones.
//
//   CPRNT_URL=https://receiptd-cprnt-staging.<sub>.workers.dev \
//   HMAC_SECRET_FILE=.wrangler/staging-hmac \
//   node scripts/dq-smoke.mjs [--trials 10] [--skip-migration] [--keep]
//
// HMAC_SECRET (or HMAC_SECRET_FILE) must match the target worker's
// FLY_HMAC_SECRET. The migration step seeds KV with `wrangler kv key put
// --remote` (KV_NAMESPACE_ID, default = the namespace in wrangler.toml), so
// wrangler must be logged in. Exits non-zero on the first failed check.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    trials: { type: "string", default: "10" },
    "skip-migration": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "printer-id": { type: "string" },
  },
});

const BASE = (process.env.CPRNT_URL ?? "").replace(/\/$/, "");
if (!BASE) throw new Error("CPRNT_URL is required");
if (/\/\/cprnt\.receiptd\.sh/.test(BASE)) throw new Error("refusing to run against production");
const SECRET = (process.env.HMAC_SECRET ??
  readFileSync(process.env.HMAC_SECRET_FILE ?? ".wrangler/staging-hmac", "utf8")).trim();
const KV_NS = process.env.KV_NAMESPACE_ID ?? "f7b184e88c364ae588d56652bbabe7d9";
const TRIALS = Number(args.trials);

const rand = () => randomBytes(4).toString("hex");
const PRINTER = args["printer-id"] ?? `printer-dq-test-${rand()}`;
if (!PRINTER.startsWith("printer-dq-test-")) throw new Error("printer id must start with printer-dq-test-");
const PASS = randomBytes(16).toString("hex");

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
  return cond;
};
const must = (cond, msg) => {
  if (!check(cond, msg)) throw new Error(`aborting: ${msg}`);
};

// --- admin (HMAC, see src/auth.ts) -----------------------------------------
async function admin(method, path, body = new Uint8Array(0), headers = {}) {
  const buf = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  const ts = String(Date.now());
  const bodyHash = createHash("sha256").update(buf).digest("hex");
  const sig = createHmac("sha256", SECRET).update(`${ts}.${method}.${path}.${bodyHash}`).digest("hex");
  return fetch(BASE + path, {
    method,
    headers: { "X-Timestamp": ts, "X-Signature": sig, ...headers },
    body: method === "GET" || method === "HEAD" ? undefined : buf,
  });
}
const putSecret = (id, pass) =>
  admin("PUT", `/admin/printers/${id}/secret`, JSON.stringify({ secret: pass }), { "Content-Type": "application/json" });
const deletePrinter = (id) => admin("DELETE", `/admin/printers/${id}/secret`);
async function enqueue(id, jobId, bytes) {
  const r = await admin("POST", "/admin/jobs", bytes, {
    "X-Printer-Id": id,
    "X-Job-Id": jobId,
    "Content-Type": "application/vnd.star.starprnt",
  });
  if (r.status !== 201) throw new Error(`enqueue ${jobId}: ${r.status} ${await r.text()}`);
  return r.json();
}

// --- printer (HTTP Basic) ---------------------------------------------------
const basic = (id, pass) => ({ Authorization: "Basic " + Buffer.from(`${id}:${pass}`).toString("base64") });
async function poll(id = PRINTER, pass = PASS) {
  const r = await fetch(`${BASE}/cprnt/${id}`, {
    method: "POST",
    headers: { ...basic(id, pass), "Content-Type": "application/json" },
    body: JSON.stringify({ status: "23 86 00 00 00 00 00 00 00", printerMAC: "00:11:62:00:00:00", statusCode: "200 OK" }),
  });
  if (r.status !== 200) throw new Error(`poll: ${r.status} ${await r.text()}`);
  return r.json();
}
const getBody = (token, id = PRINTER, pass = PASS) =>
  fetch(`${BASE}/cprnt/${id}?token=${encodeURIComponent(token)}`, { headers: basic(id, pass) });
const ack = (token, id = PRINTER, pass = PASS) =>
  fetch(`${BASE}/cprnt/${id}?token=${encodeURIComponent(token)}&code=200%20OK`, { method: "DELETE", headers: basic(id, pass) });

async function until(pred, timeoutMs = 30000) {
  const t0 = performance.now();
  for (;;) {
    const p = await poll();
    if (pred(p)) return { ms: performance.now() - t0, p };
    if (performance.now() - t0 > timeoutMs) throw new Error("timeout waiting for poll condition");
  }
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return `n=${s.length} min=${s[0].toFixed(0)} p50=${q(0.5).toFixed(0)} p90=${q(0.9).toFixed(0)} max=${s.at(-1).toFixed(0)} ms`;
};
// Drain whatever is queued by acking the head until empty (bounded).
async function drainByAck(max = 100) {
  for (let i = 0; i < max; i++) {
    const p = await poll();
    if (!p.jobReady) return;
    await ack(p.jobToken);
  }
  throw new Error("queue did not drain");
}

// Value or "" if absent (wrangler prints a proxy notice + "Value not found").
const kvGet = (key) => {
  try {
    return kv("get", key).split("\n").filter((l) => !/^Proxy environment|Value not found/.test(l)).join("\n").trim();
  } catch {
    return "";
  }
};
// Staging sets LEGACY_KV_WINDOW_SEC short; pass the same value here to test
// the end of the window (omit to skip that check).
const WINDOW_SEC = process.env.LEGACY_KV_WINDOW_SEC ? Number(process.env.LEGACY_KV_WINDOW_SEC) : null;
const kv = (...a) =>
  execFileSync("npx", ["wrangler", "kv", "key", ...a, "--namespace-id", KV_NS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

async function main() {
  console.log(`target ${BASE}\nprinter ${PRINTER}`);

  // 1. provision
  console.log("\n[1] provision Basic secret");
  let r = await putSecret(PRINTER, PASS);
  must(r.status === 200, `PUT secret → ${r.status}`);
  r = await fetch(`${BASE}/cprnt/${PRINTER}`, { method: "POST", headers: basic(PRINTER, "wrong-password-xx") });
  check(r.status === 401, `wrong password → ${r.status} (401)`);
  // KV secret write may take a moment to be visible at this edge.
  let p;
  for (let i = 0; i < 30; i++) {
    try { p = await poll(); break; } catch (e) { await new Promise((s) => setTimeout(s, 1000)); }
  }
  must(p, "printer can poll after secret provisioning");

  // 2. single-job lifecycle + latency
  console.log("\n[2] poll / enqueue / GET / DELETE lifecycle");
  check(p.jobReady === false && p.pollInterval === 2, `empty poll: jobReady=${p.jobReady} pollInterval=${p.pollInterval}`);
  const visible = [], gone = [];
  for (let t = 0; t < TRIALS; t++) {
    const jobId = `dq-${rand()}`;
    const bytes = randomBytes(64 + t);
    const t0 = performance.now();
    await enqueue(PRINTER, jobId, bytes);
    const v = await until((x) => x.jobReady);
    visible.push(performance.now() - t0);
    const okHead = v.p.jobToken === jobId;
    const g = await getBody(jobId);
    const got = Buffer.from(await g.arrayBuffer());
    const okBody = g.status === 200 && got.equals(bytes);
    const t1 = performance.now();
    const d = await ack(jobId);
    await until((x) => !x.jobReady);
    gone.push(performance.now() - t1);
    if (t === 0 || !okHead || !okBody || d.status !== 204) {
      check(okHead, `trial ${t}: poll token = enqueued jobId`);
      check(okBody, `trial ${t}: GET body ${g.status}, ${got.length} bytes match`);
      check(d.status === 204, `trial ${t}: DELETE → ${d.status}`);
    }
  }
  check(true, `enqueue→visible (incl. enqueue RTT + first poll RTT): ${stats(visible)}`);
  check(true, `ack→gone (incl. DELETE RTT + poll RTT): ${stats(gone)}`);
  const rtt = [];
  for (let i = 0; i < TRIALS; i++) { const t0 = performance.now(); await poll(); rtt.push(performance.now() - t0); }
  check(true, `baseline poll RTT: ${stats(rtt)}`);

  // 3. ordering / atomicity / stale token / cap
  console.log("\n[3] concurrency, stale token, cap");
  const batch = Array.from({ length: 5 }, (_, i) => `dq-cc${i}-${rand()}`);
  await Promise.all(batch.map((id) => enqueue(PRINTER, id, Buffer.from(id))));
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const q = await poll();
    if (!q.jobReady) break;
    seen.push(q.jobToken);
    if (i === 0) {
      // stale/foreign tokens must not pop the head
      await ack(batch.find((b) => b !== q.jobToken));
      await ack("dq-nonexistent");
      const q2 = await poll();
      check(q2.jobToken === q.jobToken, `stale-token DELETEs leave head in place (${q2.jobToken})`);
    }
    await ack(q.jobToken);
  }
  check(seen.length === 5 && new Set(seen).size === 5 && seen.every((s) => batch.includes(s)),
    `5 concurrent enqueues → all 5 delivered exactly once (${seen.length} seen)`);
  // Concurrent enqueues have no defined order between them; FIFO is checked
  // with sequential enqueues.
  const seq = Array.from({ length: 5 }, (_, i) => `dq-seq${i}-${rand()}`);
  for (const id of seq) await enqueue(PRINTER, id, Buffer.from(id));
  const seqSeen = [];
  for (let i = 0; i < 10; i++) {
    const q = await poll();
    if (!q.jobReady) break;
    seqSeen.push(q.jobToken);
    await ack(q.jobToken);
  }
  check(JSON.stringify(seqSeen) === JSON.stringify(seq), `sequential enqueues delivered FIFO`);

  // Cap: MAX_QUEUE = 50 → enqueue 52, expect 2 evicted (oldest).
  const capIds = Array.from({ length: 52 }, (_, i) => `dq-cap${String(i).padStart(2, "0")}-${rand()}`);
  const results = [];
  for (const id of capIds) results.push(await enqueue(PRINTER, id, Buffer.from("x")));
  check(results.at(-1).depth === 50, `depth capped at ${results.at(-1).depth} (50)`);
  check(results[50].evicted === capIds[0] && results[51].evicted === capIds[1], "oldest two evicted, reported to caller");
  const capHead = await poll();
  check(capHead.jobToken === capIds[2], "head is the 3rd job after eviction");
  const ev = await getBody(capIds[2]);
  check(ev.status === 200, `head body still retrievable (${ev.status})`);
  // DELETE secret drains the DO (exercises drain + R2 cleanup), then re-provision.
  r = await deletePrinter(PRINTER);
  check(r.status === 204, `admin DELETE printer (drain) → ${r.status}`);
  r = await putSecret(PRINTER, PASS);
  for (let i = 0; i < 30; i++) {
    try { p = await poll(); break; } catch { await new Promise((s) => setTimeout(s, 1000)); }
  }
  check(p && p.jobReady === false, "queue empty after drain");

  // 4. KV → DO migration
  if (!args["skip-migration"]) {
    console.log("\n[4] KV import on first DO access");
    const P2 = `printer-dq-test-${rand()}`;
    const PASS2 = randomBytes(16).toString("hex");
    const legacy = [`dq-mig1-${rand()}`, `dq-mig2-${rand()}`].map((jobId) => ({
      jobId, r2Key: `jobs/${jobId}.bin`, contentType: "application/vnd.star.starprnt", createdAt: Date.now(),
    }));
    kv("put", `printer:${P2}:jobs`, JSON.stringify({ jobs: legacy }));
    r = await putSecret(P2, PASS2); // KV only; does not touch the DO
    must(r.status === 200, `PUT secret for ${P2}`);
    let q;
    for (let i = 0; i < 30; i++) {
      try { q = await poll(P2, PASS2); break; } catch { await new Promise((s) => setTimeout(s, 1000)); }
    }
    must(q, "second printer can poll");
    check(q.jobReady && q.jobToken === legacy[0].jobId, `first poll imports legacy queue (head ${q.jobToken})`);
    await ack(legacy[0].jobId, P2, PASS2);
    const q2 = await poll(P2, PASS2);
    check(q2.jobToken === legacy[1].jobId, "imported order preserved");
    const migratedAt = Date.now();
    check(/"jobs"/.test(kvGet(`printer:${P2}:jobs`)), "KV key kept during the dual-read window");

    // Late write: an old booth still appending to KV after the DO migrated.
    // Its stale read-modify-write puts the already-acked legacy[0] back; that
    // one must not print twice.
    const late = { jobId: `dq-late-${rand()}`, r2Key: "jobs/none.bin", contentType: "application/vnd.star.starprnt", createdAt: Date.now() };
    kv("put", `printer:${P2}:jobs`, JSON.stringify({ jobs: [legacy[0], legacy[1], late] }));
    const delivered = [legacy[0].jobId];
    const t0 = performance.now();
    while (performance.now() - t0 < 120000 && !delivered.includes(late.jobId)) {
      const x = await poll(P2, PASS2);
      if (x.jobReady) {
        delivered.push(x.jobToken);
        await ack(x.jobToken, P2, PASS2);
      } else {
        await new Promise((s) => setTimeout(s, 1000));
      }
    }
    check(delivered.includes(late.jobId),
      `late KV write after migration delivered (${((performance.now() - t0) / 1000).toFixed(1)}s after KV put)`);
    check(new Set(delivered).size === delivered.length, `no job delivered twice (${delivered.length} delivered)`);

    if (WINDOW_SEC !== null) {
      const wait = migratedAt + (WINDOW_SEC + 5) * 1000 - Date.now();
      if (wait > 0) {
        console.log(`  ..   waiting ${(wait / 1000).toFixed(0)}s for the ${WINDOW_SEC}s dual-read window to end`);
        await new Promise((s) => setTimeout(s, wait));
      }
      const end = await poll(P2, PASS2);
      check(!end.jobReady, "queue empty after window");
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) {
        gone = !/"jobs"/.test(kvGet(`printer:${P2}:jobs`));
        if (!gone) await new Promise((s) => setTimeout(s, 3000));
      }
      check(gone, "KV key deleted once the window ends");
    }
    if (!args.keep) {
      await deletePrinter(P2);
      try { kv("delete", `printer:${P2}:jobs`); } catch {}
    }
  }

  // 5. photobooth → DO cross-script binding (optional). Needs a booth Worker
  // whose PRINTER_ID equals --printer-id and whose PRINTER_QUEUE binds this
  // cprnt script via script_name.
  if (process.env.BOOTH_URL) {
    console.log("\n[5] booth /api/print → DO → printer → /api/jobs status");
    const BOOTH = process.env.BOOTH_URL.replace(/\/$/, "");
    const PIN = (process.env.BOOTH_PIN ?? readFileSync(process.env.BOOTH_PIN_FILE ?? ".wrangler/booth-pin", "utf8")).trim();
    const bh = { "x-booth-pin": PIN, "content-type": "application/json" };
    const jobStatus = async (id) => (await (await fetch(`${BOOTH}/api/jobs/${id}`, { headers: bh })).json());
    const h = 8;
    const res = await fetch(`${BOOTH}/api/print`, {
      method: "POST",
      headers: bh,
      body: JSON.stringify({ width: 576, height: h, bits: Buffer.alloc(72 * h, 0x55).toString("base64"), copies: 2 }),
    });
    const pr = await res.json();
    must(res.status === 201 && pr.ids?.length === 2, `POST /api/print copies=2 → ${res.status} ${JSON.stringify(pr)}`);
    const [c1, c2] = pr.ids;
    let s1 = await jobStatus(c1), s2 = await jobStatus(c2);
    check(s1.status === "printing" && s2.status === "pending" && s2.position === 2,
      `immediately: copy1 ${s1.status}, copy2 ${s2.status}@${s2.position}`);
    const q = await poll();
    check(q.jobReady && q.jobToken === c1, `printer poll sees booth copy 1 (${q.jobToken})`);
    const g = await getBody(c1);
    const body = Buffer.from(await g.arrayBuffer());
    check(g.status === 200 && body.length > 72 * h, `printer GET booth StarPRNT body (${g.status}, ${body.length} bytes)`);
    const t0 = performance.now();
    await ack(c1);
    s1 = await jobStatus(c1);
    s2 = await jobStatus(c2);
    const ms = performance.now() - t0;
    check(s1.status === "completed" && s2.status === "printing",
      `after ack: copy1 ${s1.status}, copy2 ${s2.status} (ack + 2 status reads ${ms.toFixed(0)} ms)`);
    await ack(c2);
    s2 = await jobStatus(c2);
    check(s2.status === "completed", `after 2nd ack: copy2 ${s2.status}`);
    const bad = await fetch(`${BOOTH}/api/jobs/${c1}`, { headers: { "x-booth-pin": "nope" } });
    check(bad.status === 401, `booth wrong PIN → ${bad.status}`);
  }

  if (!args.keep) {
    await drainByAck().catch(() => {});
    r = await deletePrinter(PRINTER);
    check(r.status === 204, `cleanup: admin DELETE ${PRINTER} → ${r.status}`);
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
