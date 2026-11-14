#!/usr/bin/env node
// Pull archived booth photos to this Mac.
//
//   BOOTH_PIN=… npm run photos:pull -- --day 2026-11-14 --out ~/Pictures/Cheese
//   BOOTH_PIN=… npm run photos:pull -- --all --out ~/Pictures/Cheese
//
// Options: --day YYYY-MM-DD (repeatable; default: today in New York), --all,
// --out DIR (default ./photos), --api URL (default https://booth.receiptd.sh;
// env BOOTH_API). Writes OUT/<day>/<HHMMSS>-<id>/{orig-N.jpg,strip.png,meta.json};
// files already present with the same size are skipped, so re-runs are cheap.
// The PIN is only ever sent as the x-booth-pin header, never printed.

import { mkdir, stat, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const days = [];
let all = false, out = "photos", api = process.env.BOOTH_API || "https://booth.receiptd.sh";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--day") days.push(args[++i]);
  else if (a === "--all") all = true;
  else if (a === "--out") out = args[++i];
  else if (a === "--api") api = args[++i];
  else if (a === "-h" || a === "--help") { console.log("usage: pull-photos.mjs [--day YYYY-MM-DD]… [--all] [--out DIR] [--api URL]"); process.exit(0); }
  else { console.error("unknown argument:", a); process.exit(2); }
}
const pin = process.env.BOOTH_PIN;
if (!pin) { console.error("Set BOOTH_PIN (the booth's PIN)."); process.exit(2); }
out = resolve(out.replace(/^~(?=$|\/)/, homedir()));
api = api.replace(/\/$/, "");

async function get(path) {
  const res = await fetch(api + path, { headers: { "x-booth-pin": pin } });
  if (res.status === 401) throw new Error("PIN rejected (401)");
  if (!res.ok) throw new Error(`${path.split("?")[0]} → HTTP ${res.status}`);
  return res;
}
const exists = async (p, size) => { try { return (await stat(p)).size === size; } catch { return false; } };
const nyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

if (all) days.push(...(await (await get("/api/photos/days")).json()).days.map((d) => d.day));
if (!days.length) days.push(nyToday());

let got = 0, skipped = 0, bytes = 0;
for (const day of days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) { console.error("bad --day:", day); process.exit(2); }
  const { sessions } = await (await get("/api/photos?day=" + day)).json();
  console.log(`${day}: ${sessions.length} session(s)`);
  for (const s of sessions) {
    const t = s.meta?.capturedAt ? new Date(s.meta.capturedAt) : null;
    const hhmmss = t ? new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .format(t).replaceAll(":", "") : "000000";
    const dir = join(out, day, `${hhmmss}-${s.id}`);
    await mkdir(dir, { recursive: true });
    for (const [name, key] of Object.entries(s.files)) {
      const dest = join(dir, name);
      if (name !== "meta.json" && await exists(dest, s.sizes?.[name])) { skipped++; continue; }
      const buf = Buffer.from(await (await get("/api/photos/file?key=" + encodeURIComponent(key))).arrayBuffer());
      await writeFile(dest + ".part", buf);
      await rename(dest + ".part", dest);
      got++; bytes += buf.length;
    }
  }
}
console.log(`done: ${got} downloaded (${(bytes / 1048576).toFixed(1)} MB), ${skipped} already here → ${out}`);
