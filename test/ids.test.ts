import { test } from "node:test";
import assert from "node:assert/strict";
import { mintRunId, seedCounters } from "../src/ids.ts";

test("a fresh counter mints sequential per-agent ids", () => {
  const c = new Map<string, number>();
  assert.equal(mintRunId(c, "reviewer"), "reviewer-1");
  assert.equal(mintRunId(c, "reviewer"), "reviewer-2");
  assert.equal(mintRunId(c, "worker"), "worker-1");
  assert.equal(mintRunId(c, "reviewer"), "reviewer-3");
});

test("REGRESSION: after /reload the first mint does not reuse a replayed id", () => {
  // The bug: a /reload replays completed runs into the runs map but leaves the
  // counter empty, so the next mint is "reviewer-1"/"worker-1" again — the id a
  // replayed run already holds — and runs.set() overwrites the live record.
  const replayed = ["reviewer-1", "reviewer-2", "worker-1"];

  // Without the re-seed the counter starts at zero and collides.
  const unseeded = new Map<string, number>();
  assert.equal(mintRunId(unseeded, "reviewer"), "reviewer-1", "unseeded reuses reviewer-1 (the bug)");
  assert.ok(replayed.includes("reviewer-1"), "and reviewer-1 is a live replayed id");

  // With the fix the counter is seeded past the highest replayed id first.
  const seeded = new Map<string, number>();
  seedCounters(seeded, replayed);
  const reviewerId = mintRunId(seeded, "reviewer");
  const workerId = mintRunId(seeded, "worker");
  assert.equal(reviewerId, "reviewer-3", "next reviewer id clears reviewer-1 and reviewer-2");
  assert.equal(workerId, "worker-2", "next worker id clears worker-1");
  assert.ok(!replayed.includes(reviewerId), "no collision with any replayed id");
  assert.ok(!replayed.includes(workerId), "no collision with any replayed id");
});

test("seedCounters takes the highest numeric suffix, not the last-seen or lexical one", () => {
  const c = new Map<string, number>();
  seedCounters(c, ["worker-2", "worker-10", "worker-1"]);
  // A lexical or last-seen seed would let "worker-10" be re-minted.
  assert.equal(mintRunId(c, "worker"), "worker-11");
});

test("seedCounters never lowers an already-advanced counter", () => {
  const c = new Map<string, number>();
  mintRunId(c, "reviewer"); // -1
  mintRunId(c, "reviewer"); // -2
  mintRunId(c, "reviewer"); // -3, counter now at 3
  seedCounters(c, ["reviewer-1"]); // a lower id must not roll it back
  assert.equal(mintRunId(c, "reviewer"), "reviewer-4");
});

test("seedCounters ignores ids without a trailing integer", () => {
  const c = new Map<string, number>();
  seedCounters(c, ["scout", "fix-the-parser", "reviewer-", "worker-1x", ""]);
  // None of these feed a counter, so minting starts clean.
  assert.equal(mintRunId(c, "scout"), "scout-1");
  assert.equal(mintRunId(c, "worker"), "worker-1");
});

test("an isolation slug suffix keeps its own key and never advances the base agent", () => {
  // Isolation run ids can carry a worktree collision suffix ("worker-1-2"); the
  // greedy prefix keeps that on "worker-1", so nextId("worker") is unaffected.
  const c = new Map<string, number>();
  seedCounters(c, ["worker-1-2"]);
  assert.equal(mintRunId(c, "worker"), "worker-1");
});
