import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, normalizeGate, contractProblems, runGate } from "../src/gate.ts";
import { gateVerification, deriveOutcome, parseDeclaredOutcome, stripDeclaration, outcomeLine } from "../src/outcome.ts";
import { repairable, repairPrompt, runGateCycle } from "../src/repair.ts";
import type { GateContract, GateVerdict } from "../src/gate.ts";

test("a gate that exits 0 without its evidence has verified nothing", () => {
  const contract: GateContract = { command: "npm test", expect: "\\d+ passing" };
  const verdict = evaluateGate(contract, { status: 0, output: "no test files found", signal: null });
  assert.equal(verdict.outcome, "result_missing");
  assert.equal(verdict.ok, false);
});

test("a gate that could not run is not a verdict on the work", () => {
  const verdict = evaluateGate({ command: "buhn test" }, {
    status: null,
    signal: null,
    output: "",
    spawnError: "spawn buhn ENOENT",
  });
  assert.equal(verdict.outcome, "no_attestation");
  assert.equal(gateVerification(verdict.outcome), "inconclusive");
  assert.equal(repairable(verdict.outcome), false, "never send a child to fix a phantom defect");
});

test("runGate really runs the command in the given directory", () => {
  const ok = runGate({ command: "node -e \"process.stdout.write('7 passing')\"", expect: "\\d+ passing" }, process.cwd());
  assert.equal(ok.outcome, "success", ok.reason);
  const bad = runGate({ command: "node -e \"process.exit(3)\"" }, process.cwd());
  assert.equal(bad.outcome, "failure");
  assert.match(bad.reason, /exited 3/);
});

test("an unparseable pattern is a broken gate, never a pass", () => {
  assert.deepEqual(contractProblems({ command: "x", expect: "(" }), [
    "gate expect is not a valid regular expression",
  ]);
  assert.equal(normalizeGate("bun test").command, "bun test");
});

// ── outcome ─────────────────────────────────────────────────────────────

test("a child may declare its own outcome; the last word wins", () => {
  assert.equal(parseDeclaredOutcome("all done\n\nOUTCOME: blocked"), "blocked");
  assert.equal(parseDeclaredOutcome("outcome: FAILED"), "failed");
  assert.equal(parseDeclaredOutcome("OUTCOME: blocked\nthen I retried\nOUTCOME: succeeded"), "succeeded");
  assert.equal(parseDeclaredOutcome("I think the outcome: blocked us"), undefined, "prose is not a declaration");
  assert.equal(parseDeclaredOutcome(null), undefined);
});

test("the declaration is removed from the report body", () => {
  assert.equal(stripDeclaration("the report\n\nOUTCOME: blocked"), "the report");
  assert.equal(stripDeclaration("kept"), "kept");
});

test("a failed gate outranks a child claiming success", () => {
  assert.equal(
    deriveOutcome({ status: "done", declared: "succeeded", verification: "failed" }),
    "failed",
  );
});

test("a gate that proved nothing does not turn a good run into a failure", () => {
  assert.equal(deriveOutcome({ status: "done", verification: "inconclusive" }), "succeeded");
  assert.equal(deriveOutcome({ status: "done", declared: "blocked", verification: "passed" }), "blocked");
});

test("a session that did not finish cannot have succeeded", () => {
  for (const status of ["error", "aborted", "running"] as const) {
    assert.equal(deriveOutcome({ status, declared: "succeeded" }), "failed", status);
  }
});

test("the outcome line names both facts", () => {
  assert.match(outcomeLine("succeeded", "not-requested"), /agent's own account/);
  assert.match(outcomeLine("failed", "failed"), /gate ran and failed/);
});

// ── the repair cycle ────────────────────────────────────────────────────

function verdict(outcome: GateVerdict["outcome"], output = ""): GateVerdict & { output: string } {
  return { outcome, ok: outcome === "success", reason: `gate ${outcome}`, output };
}

test("a failing gate sends the child back once, then re-runs the gate", async () => {
  const seen: string[] = [];
  let call = 0;
  const { record, verification } = await runGateCycle(
    "add the endpoint",
    { command: "bun test" },
    "/w",
    {
      runGate: () => (++call === 1 ? verdict("failure", "2 fail") : verdict("success")),
      repair: async (p) => void seen.push(p),
      canRepair: true,
      maxAttempts: 1,
    },
  );
  assert.equal(call, 2);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /add the endpoint/);
  assert.match(seen[0]!, /2 fail/);
  assert.match(seen[0]!, /do not modify the check itself/);
  assert.equal(record.ok, true);
  assert.equal(record.repairs, 1);
  assert.equal(record.output, undefined, "a passing gate's output is noise");
  assert.equal(verification, "passed");
});

test("a read-only agent is never asked to repair", async () => {
  let repairs = 0;
  const { record } = await runGateCycle("review it", { command: "bun test" }, "/w", {
    runGate: () => verdict("failure", "boom"),
    repair: async () => void repairs++,
    canRepair: false,
    maxAttempts: 3,
  });
  assert.equal(repairs, 0);
  assert.equal(record.ok, false);
  assert.equal(record.output, "boom");
  assert.equal(record.repairs, undefined);
});

test("repair attempts are bounded and a broken gate is not repaired at all", async () => {
  let runs = 0;
  let repairs = 0;
  await runGateCycle("fix it", { command: "bun test" }, "/w", {
    runGate: () => (runs++, verdict("failure")),
    repair: async () => void repairs++,
    canRepair: true,
    maxAttempts: 9, // clamped to 5
  });
  assert.equal(repairs, 5);
  assert.equal(runs, 6);

  repairs = 0;
  await runGateCycle("fix it", { command: "nope" }, "/w", {
    runGate: () => verdict("no_attestation"),
    repair: async () => void repairs++,
    canRepair: true,
    maxAttempts: 2,
  });
  assert.equal(repairs, 0);
});

test("a shared working directory is recorded with the verdict", async () => {
  const { record } = await runGateCycle("x", { command: "bun test" }, "/w", {
    runGate: () => verdict("success"),
    repair: async () => {},
    canRepair: true,
    maxAttempts: 1,
    sharedWith: ["worker-2"],
  });
  assert.deepEqual(record.sharedWith, ["worker-2"]);
});

test("the repair brief carries the check and its verdict, not the whole world", () => {
  const prompt = repairPrompt("do the thing", { command: "tsc --noEmit" }, { reason: "gate exited 2", output: "" });
  assert.match(prompt, /tsc --noEmit/);
  assert.match(prompt, /gate exited 2/);
  assert.ok(!prompt.includes("== Output =="), "no output section when there was none");
});
