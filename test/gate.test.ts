import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, normalizeGate, contractProblems, runGate, sharedWith } from "../src/gate.ts";
import { gateVerification, deriveOutcome, parseDeclaredOutcome, stripDeclaration, outcomeLine } from "../src/outcome.ts";
import { repairable, repairPrompt, runGateCycle } from "../src/repair.ts";
import { canWrite, repairAllowed } from "../src/policy.ts";
import type { GateContract, GateSibling, GateVerdict } from "../src/gate.ts";
import type { AgentDef } from "../src/types.ts";

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

test("runGate really runs the command in the given directory", async () => {
  const ok = await runGate({ command: "node -e \"process.stdout.write('7 passing')\"", expect: "\\d+ passing" }, process.cwd());
  assert.equal(ok.outcome, "success", ok.reason);
  const bad = await runGate({ command: "node -e \"process.exit(3)\"" }, process.cwd());
  assert.equal(bad.outcome, "failure");
  assert.match(bad.reason, /exited 3/);
});

test("runGate does not hold the event loop, and a deadline is a timeout verdict", async () => {
  // The first version used spawnSync: a two-minute test suite froze pi for
  // two minutes. A timer must be able to fire while the gate runs.
  let ticked = false;
  const tick = new Promise<void>((resolve) => setTimeout(() => { ticked = true; resolve(); }, 50));
  const slow = runGate(
    { command: "node -e \"setTimeout(() => {}, 5000)\"", timeoutMs: 400 },
    process.cwd(),
  );
  await tick;
  assert.equal(ticked, true, "the event loop ran while the gate was running");
  const verdict = await slow;
  assert.equal(verdict.outcome, "timeout", verdict.reason);
});

test("runGate keeps the tail of a gate that prints past the cap", async () => {
  // 2 MiB is over spawnSync's old 1 MiB default, under the 16 MiB tail cap —
  // a chatty-but-passing gate must still pass on its exit code.
  const ok = await runGate({ command: "node -e \"process.stdout.write('x'.repeat(2 * 1024 * 1024))\"" }, process.cwd());
  assert.equal(ok.outcome, "success", ok.reason);
  const bad = await runGate(
    { command: "node -e \"process.stdout.write('x'.repeat(2 * 1024 * 1024)); process.exit(1)\"" },
    process.cwd(),
  );
  assert.equal(bad.outcome, "failure", bad.reason);
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

test("REGRESSION: an isolated run's gate is not blamed on siblings in the main checkout", () => {
  // The bug: siblings were built with `workDir: r.workDir`, and a non-isolated
  // run has no workDir. sharedWith() reads undefined as "same directory as the
  // subject", so every running non-isolated sibling was counted as sharing an
  // isolated run's worktree.
  const worktree = "/home/u/.worktrees/repo/worker-1";
  const cwd = "/home/u/repo";
  const self: GateSibling = { id: 0, label: "worker-1", status: "done", workDir: worktree };
  const raw: GateSibling[] = [
    { id: 1, label: "scout-1", status: "running", workDir: undefined },
    { id: 2, label: "worker-2", status: "running", workDir: worktree },
  ];
  // The shape the extension used to build: the non-isolated scout is blamed.
  assert.deepEqual(sharedWith(self, worktree, raw), ["scout-1", "worker-2"]);

  // Resolving undefined to the session cwd — what the extension builds now.
  const resolved = raw.map((s) => ({ ...s, workDir: s.workDir ?? cwd }));
  assert.deepEqual(sharedWith(self, worktree, resolved), ["worker-2"]);

  // And the other direction: a non-isolated subject still sees its real sharers.
  const plain: GateSibling = { id: 0, label: "worker-3", status: "done", workDir: cwd };
  assert.deepEqual(sharedWith(plain, cwd, resolved), ["scout-1"]);
});

function agent(tools: AgentDef["tools"]): AgentDef {
  return {
    name: "x",
    description: "x",
    tools,
    model: null,
    thinking: null,
    maxTurns: 5,
    systemPrompt: "",
    systemPromptMode: "append",
    inheritSkills: true,
    source: "builtin",
  };
}

test("a child that declared itself blocked is not sent on repair passes", () => {
  const worker = agent(["read", "edit", "bash"]);
  assert.equal(repairAllowed(worker, "did it"), true);
  assert.equal(repairAllowed(worker, "did it\n\nOUTCOME: failed"), true, "failed means it tried; a repair may still land");
  assert.equal(repairAllowed(worker, "need the API key\n\nOUTCOME: blocked"), false, "blocked means no fix is possible from here");
  assert.equal(repairAllowed(worker, null), true);
  // A read-only agent cannot repair whatever it declared.
  const reviewer = agent(["read", "grep"]);
  assert.equal(canWrite(reviewer), false);
  assert.equal(repairAllowed(reviewer, "fine"), false);
  assert.equal(canWrite(agent(["read", "write"])), true);
  assert.equal(canWrite(agent(["read", "powershell"])), true);
});

test("the repair brief carries the check and its verdict, not the whole world", () => {
  const prompt = repairPrompt("do the thing", { command: "tsc --noEmit" }, { reason: "gate exited 2", output: "" });
  assert.match(prompt, /tsc --noEmit/);
  assert.match(prompt, /gate exited 2/);
  assert.ok(!prompt.includes("== Output =="), "no output section when there was none");
});
