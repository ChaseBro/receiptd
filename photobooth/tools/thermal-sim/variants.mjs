import { evaluate, score } from "./evaluate.mjs";
import { sampleTruths } from "./model.mjs";
const truths = sampleTruths(+(process.argv[2] ?? 6));
export const VARIANTS = {
  plain: { gain: 0 },
  "raster.js 0.3/0.35": {},
  "live 0.15/bleed0": { gain: 0.15, bleed: 0 },
  "tone-ref 0.3": { gain: 0.3, bleed: 0, ref: "tone" },
  "tone-ref 0.3 neg": { gain: 0.3, bleed: 0, ref: "tone", neg: true },
  "plain serp": { gain: 0, serpentine: true },
  "plain fs serp": { gain: 0, kernel: "fs", serpentine: true },
  "plain sierra serp": { gain: 0, kernel: "sierra-lite", serpentine: true },
};
const keys = ["ghost10", "ghost40", "ghost50band", "gZig", "gBlock", "gOffset", "smearWhite", "smearGrey", "blackP1", "bias", "contrast", "localC", "mseT", "tex", "tone200", "score"];
const f = (v) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3));
console.log(["variant".padEnd(22), ...keys.map((k) => k.slice(0, 8).padStart(8))].join(" "));
for (const [name, o] of Object.entries(VARIANTS)) {
  const m = evaluate(o, truths);
  m.avg.score = score(m);
  console.log([name.padEnd(22), ...keys.map((k) => f(m.avg[k]).padStart(8))].join(" "));
}
