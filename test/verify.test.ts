import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVerdict,
  verifyPrompt,
  revisionPrompt,
  runVerification,
  type VerifyDeps,
  VERDICT_PASS,
  VERDICT_CHANGES,
} from "../src/verify.ts";
import type { AgentDef, RunState } from "../src/types.ts";

function def(name: string): AgentDef {
  return {
    name,
    description: name,
    tools: ["read"],
    model: null,
    thinking: null,
    maxTurns: 10,
    systemPrompt: "",
    systemPromptMode: "append",
    inheritSkills: true,
    source: "builtin",
  };
}

function mkRun(id: string, agent: string, task: string): RunState {
  return {
    id,
    agent,
    task,
    background: false,
    status: "running",
    startedAt: 0,
    finishedAt: null,
    tokens: 0,
    turns: 0,
    result: null,
    error: null,
  };
}

/**
 * A VerifyDeps whose fake runChild records the workDir each child was spawned
 * against and scripts the review verdict, so the orchestration (and which tree
 * the reviewer inspects) can be asserted without a live session.
 */
function harness(verdict: string) {
  let seq = 0;
  const spawnedWith: Record<string, string | undefined> = {};
  const nextId = (agent: string) => `${agent}-${++seq}`;
  const deps: VerifyDeps = {
    reviewerDef: def("reviewer"),
    workerDef: def("worker"),
    mkRun,
    nextId,
    register: () => {},
    async runChild(d, r, workDir) {
      spawnedWith[d.name] = workDir;
      r.status = "done";
      r.result = d.name === "reviewer" ? verdict : "revised deliverable";
    },
  };
  return { deps, spawnedWith };
}

test("PASS verdict is parsed as passed with no feedback", () => {
  const v = parseVerdict(`${VERDICT_PASS}\nLooks correct and complete.`);
  assert.equal(v.passed, true);
  assert.equal(v.feedback, "");
});

test("CHANGES verdict is parsed as failed, feedback is the text after it", () => {
  const v = parseVerdict(`${VERDICT_CHANGES}\n1. Off-by-one in the loop.\n2. Missing null check.`);
  assert.equal(v.passed, false);
  assert.match(v.feedback, /Off-by-one/);
  assert.match(v.feedback, /null check/);
  assert.ok(!v.feedback.toUpperCase().includes("VERDICT"), "the verdict line is stripped from feedback");
});

test("an unclear reply defaults to passed — a mangled review never blocks a good result", () => {
  assert.equal(parseVerdict("the work seems fine to me").passed, true);
  assert.equal(parseVerdict("").passed, true);
  assert.equal(parseVerdict("   ").passed, true);
});

test("verdict matching is case-insensitive and tolerant of spacing", () => {
  assert.equal(parseVerdict("verdict:changes\nfix it").passed, false);
  assert.equal(parseVerdict("Verdict:  CHANGES  \nfix").passed, false);
});

test("the verify prompt carries the task and the work, and asks for the tokens", () => {
  const p = verifyPrompt("Build the parser", "Here is the parser…");
  assert.match(p, /Build the parser/);
  assert.match(p, /Here is the parser/);
  assert.ok(p.includes(VERDICT_PASS) && p.includes(VERDICT_CHANGES));
});

test("the revision prompt carries the task and the required changes", () => {
  const p = revisionPrompt("Build the parser", "1. handle empty input");
  assert.match(p, /Build the parser/);
  assert.match(p, /handle empty input/);
});

test("REGRESSION: an isolated verify reviews the worker's worktree, not the main checkout", async () => {
  // The bug: the reviewer child was spawned with no workDir, so it inspected
  // the untouched main checkout while the worker's changes lived in the
  // worktree — a review of a diff it could not see.
  const workDir = "/home/u/.worktrees/repo/worker-1";
  const { deps, spawnedWith } = harness(VERDICT_PASS);
  const run = mkRun("worker-1", "worker", "edit the parser");
  run.result = "done in the worktree";

  await runVerification(run, workDir, deps);

  assert.equal(spawnedWith.reviewer, workDir, "the reviewer inspects the worktree the worker modified");
  assert.match(run.result, /verified: reviewer passed/);
});

test("REGRESSION: a failed isolated verify revises inside the same worktree", async () => {
  const workDir = "/home/u/.worktrees/repo/worker-1";
  const { deps, spawnedWith } = harness(`${VERDICT_CHANGES}\n1. handle empty input`);
  const run = mkRun("worker-1", "worker", "edit the parser");
  run.result = "first attempt";

  await runVerification(run, workDir, deps);

  assert.equal(spawnedWith.reviewer, workDir, "reviewer runs in the worktree");
  assert.equal(spawnedWith.worker, workDir, "the revision writes back into the same worktree");
  assert.match(run.result, /revised once after review/);
});

test("a non-isolated verify passes no workDir (runs in the main checkout)", async () => {
  const { deps, spawnedWith } = harness(VERDICT_PASS);
  const run = mkRun("worker-1", "worker", "edit the parser");
  run.result = "done";

  await runVerification(run, undefined, deps);

  assert.equal(spawnedWith.reviewer, undefined, "no worktree means the child inherits the session cwd");
});

test("runVerification is a no-op without a reviewer or a result", async () => {
  const noReviewer: VerifyDeps = { ...harness(VERDICT_PASS).deps, reviewerDef: undefined };
  const run = mkRun("worker-1", "worker", "t");
  run.result = "the answer";
  await runVerification(run, undefined, noReviewer);
  assert.equal(run.result, "the answer", "left untouched when no reviewer is configured");

  const { deps } = harness(VERDICT_PASS);
  const empty = mkRun("worker-2", "worker", "t");
  empty.result = null;
  await runVerification(empty, undefined, deps);
  assert.equal(empty.result, null, "nothing to verify when the worker produced no result");
});
