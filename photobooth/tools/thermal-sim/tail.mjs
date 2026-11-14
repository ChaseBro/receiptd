// Can thinning the bottom rows of solid blacks cut the smear on white paper
// without visibly greying the black? (pills + calibration block, all truths)
import { evaluate } from "./evaluate.mjs";
import { sampleTruths } from "./model.mjs";
const truths = sampleTruths(6);
const base = { gain: 0.35, bleed: 0, ref: "tone", neg: true };
for (const [rows, keep] of [[0, 1], [4, 0.75], [8, 0.75], [8, 0.5], [16, 0.5], [16, 0.25]]) {
  const m = evaluate({ ...base, tailRows: rows, tailKeep: keep }, truths, { photosToo: false }).avg;
  console.log(`tail ${rows}r keep ${keep}: smearWhite ${m.smearWhite.toFixed(4)} smearGrey ${m.smearGrey.toFixed(4)} ghost10 ${m.ghost10.toFixed(3)} gBlock ${m.gBlock.toFixed(3)} blackP1 ${m.blackP1.toFixed(3)} pillBlackP1 ${m.pillBlackP1.toFixed(3)}`);
}
