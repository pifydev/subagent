import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSISTED_GATE_OUTPUT, RESULT_ENTRY, persistable, replayRuns, type ReplayEntry } from "../src/persist.ts";
import type { RunState } from "../src/types.ts";

function run(overrides: Partial<RunState>): RunState {
  return {
    id: "worker-1",
    agent: "worker",
    task: "add the endpoint",
    background: true,
    status: "done",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: 10,
    turns: 2,
    result: "added it",
    error: null,
    ...overrides,
  };
}

/** What pi's session file hands back on session_start: the entry, JSON-round-tripped. */
function entry(data: unknown, customType = RESULT_ENTRY): ReplayEntry {
  return JSON.parse(JSON.stringify({ type: "custom", customType, data }));
}

test("REGRESSION: a restored run keeps its outcome, verification and gate", () => {
  // The bug: the run was persisted the moment its child session ended —
  // before verify, gate and settleOutcome — so after /reload it replayed as a
  // clean success with no gate and no outcome.
  const settled = run({
    outcome: "failed",
    verification: "failed",
    gate: { command: "bun test", outcome: "failure", ok: false, reason: "gate exited 1", output: "1 fail", repairs: 1 },
  });
  const [restored] = replayRuns([entry(persistable(settled))]);
  assert.ok(restored);
  assert.equal(restored.id, "worker-1");
  assert.equal(restored.outcome, "failed");
  assert.equal(restored.verification, "failed");
  assert.deepEqual(restored.gate, settled.gate);
});

test("replay skips running runs, other entry types and malformed data", () => {
  const runs = replayRuns([
    entry(run({ id: "worker-1", status: "running", finishedAt: null })),
    entry(run({ id: "scout-1" }), "some-other-entry"),
    entry("not a record"),
    entry({ status: "done" }), // no id
    { type: "message" },
    entry(run({ id: "reviewer-2", status: "aborted" })),
  ]);
  assert.deepEqual(runs.map((r) => r.id), ["reviewer-2"]);
});

test("the persisted record never carries the settling flag", () => {
  const settling = run({ settling: true });
  const stored = persistable(settling);
  assert.equal("settling" in stored, false);
  assert.equal(settling.settling, true, "the live record is not mutated");
});

test("gate output is capped before it goes into the session file, tail kept", () => {
  const output = `${"x".repeat(PERSISTED_GATE_OUTPUT)}TAIL`;
  const stored = persistable(run({ gate: { command: "bun test", outcome: "failure", ok: false, reason: "r", output } }));
  assert.ok(stored.gate);
  assert.equal(stored.gate.output!.length <= PERSISTED_GATE_OUTPUT + 2, true, "…\\n prefix plus the tail");
  assert.ok(stored.gate.output!.endsWith("TAIL"), "the verdict is at the end of a suite's output");
  assert.ok(stored.gate.output!.startsWith("…"));

  const short = persistable(run({ gate: { command: "bun test", outcome: "failure", ok: false, reason: "r", output: "1 fail" } }));
  assert.equal(short.gate!.output, "1 fail");
  const passed = persistable(run({ gate: { command: "bun test", outcome: "success", ok: true, reason: "r" } }));
  assert.equal("output" in passed.gate!, false);
  assert.equal(persistable(run({})).gate, undefined);
});
