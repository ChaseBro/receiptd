// Random/grid search over compensator params. Shardable:
//   node search.mjs <shard> <nShards> <nSamples> > out/search-<shard>.jsonl
import { evaluate, score } from "./evaluate.mjs";
import { sampleTruths } from "./model.mjs";

const [shard = 0, nShards = 1, N = 200, nTruth = 4] = process.argv.slice(2).map(Number);
const truths = sampleTruths(nTruth, 11); // different seed from the report set (7)
const SPACE = {
  ref: ["tone", "abs"], neg: [true, false],
  gain: [0.15, 0.25, 0.35, 0.45, 0.6], fastDecay: [0.5, 0.7, 0.85], slowDecay: [0.97, 0.985, 0.993],
  slowWeight: [0.4, 0.6, 0.8], spread: [0.08, 0.15, 0.22], bleed: [0, 0.2, 0.4], maxGain: [0.5, 0.8],
  serpentine: [false, true], jitter: [0, 0.1, 0.2],
};
let s = 12345;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
for (let n = 0; n < N; n++) {
  const o = {};
  for (const [k, v] of Object.entries(SPACE)) o[k] = v[Math.floor(rnd() * v.length)];
  if (n % nShards !== shard) continue;
  const m = evaluate(o, truths);
  process.stdout.write(JSON.stringify({ o, score: score(m), avg: m.avg }) + "\n");
}
