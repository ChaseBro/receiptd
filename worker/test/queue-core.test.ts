// Run: node --test test/   (Node >= 23.6 strips TS types natively)
import test from "node:test";
import assert from "node:assert/strict";
import { ackHead, appendJobs, mergeLegacy, parseKvQueue, statusOf, type JobSignal } from "../src/queue-core.ts";

const sig = (jobId: string): JobSignal => ({
  jobId,
  r2Key: `jobs/${jobId}.bin`,
  contentType: "application/vnd.star.starprnt",
  createdAt: 1,
});
const ids = (js: JobSignal[]) => js.map((j) => j.jobId);

test("appendJobs keeps FIFO order and evicts oldest past the cap", () => {
  let r = appendJobs([], [sig("a"), sig("b")], 3);
  assert.deepEqual(ids(r.jobs), ["a", "b"]);
  assert.deepEqual(r.evicted, []);
  r = appendJobs(r.jobs, [sig("c"), sig("d"), sig("e")], 3);
  assert.deepEqual(ids(r.jobs), ["c", "d", "e"]);
  assert.deepEqual(ids(r.evicted), ["a", "b"]);
});

test("appendJobs does not mutate its input", () => {
  const before = [sig("a")];
  appendJobs(before, [sig("b")]);
  assert.deepEqual(ids(before), ["a"]);
});

test("ackHead pops on matching or missing token, ignores stale tokens", () => {
  const q = [sig("a"), sig("b")];
  assert.deepEqual(ids(ackHead(q, "a").jobs), ["b"]);
  assert.equal(ackHead(q, "a").popped?.jobId, "a");
  assert.equal(ackHead(q, null).popped?.jobId, "a");
  assert.equal(ackHead(q, "").popped?.jobId, "a");
  const stale = ackHead(q, "b");
  assert.equal(stale.popped, null);
  assert.deepEqual(ids(stale.jobs), ["a", "b"]);
  assert.equal(ackHead([], "a").popped, null);
});

test("statusOf: head printing, rest pending with 1-based position, absent completed", () => {
  const q = [sig("a"), sig("b"), sig("c")];
  assert.deepEqual(statusOf(q, "a"), { status: "printing", position: 1 });
  assert.deepEqual(statusOf(q, "c"), { status: "pending", position: 3 });
  assert.deepEqual(statusOf(q, "zz"), { status: "completed" });
});

test("parseKvQueue reads list, legacy single slot, and tolerates junk", () => {
  const list = JSON.stringify({ jobs: [sig("a"), sig("b")] });
  assert.deepEqual(ids(parseKvQueue(list, null)), ["a", "b"]);
  assert.deepEqual(ids(parseKvQueue(null, JSON.stringify(sig("old")))), ["old"]);
  assert.deepEqual(ids(parseKvQueue(list, JSON.stringify(sig("old")))), ["old", "a", "b"]);
  assert.deepEqual(ids(parseKvQueue(list, JSON.stringify(sig("a")))), ["a", "b"]);
  assert.deepEqual(parseKvQueue("not json", "{"), []);
  assert.deepEqual(parseKvQueue(JSON.stringify({ jobs: [{ nope: 1 }] }), null), []);
  assert.deepEqual(parseKvQueue(null, null), []);
});

test("mergeLegacy imports each KV job id once, even after it was acked", () => {
  // First import into an empty DO.
  let r = mergeLegacy([], [], [sig("a"), sig("b")]);
  assert.deepEqual(ids(r.jobs), ["a", "b"]);
  assert.deepEqual(r.importedIds, ["a", "b"]);
  // "a" printed + acked; the booth enqueued "n" via the DO; an old booth's
  // stale read-modify-write puts [a, b, late] back into KV.
  const q = [sig("b"), sig("n")];
  r = mergeLegacy(q, r.importedIds, [sig("a"), sig("b"), sig("late")]);
  assert.deepEqual(ids(r.jobs), ["b", "n", "late"]);
  assert.deepEqual(ids(r.added), ["late"]);
  assert.deepEqual(r.importedIds, ["a", "b", "late"]);
  // Re-reading the same KV value is a no-op.
  const again = mergeLegacy(r.jobs, r.importedIds, [sig("a"), sig("b"), sig("late")]);
  assert.deepEqual(ids(again.jobs), ["b", "n", "late"]);
  assert.deepEqual(again.added, []);
});

test("mergeLegacy respects the cap and does not re-import ids already queued", () => {
  const r = mergeLegacy([sig("x"), sig("y")], [], [sig("y"), sig("z")], 2);
  assert.deepEqual(ids(r.jobs), ["y", "z"]);
  assert.deepEqual(ids(r.evicted), ["x"]);
  assert.deepEqual(ids(r.added), ["z"]);
});
