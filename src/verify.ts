/**
 * Automatic peer-review of a subagent's output.
 *
 * ask_supervisor escalates a decision to the human; this is the other half — a
 * worker's result is checked by a reviewer child before the caller accepts it,
 * and a failed review sends the worker back for one revision. The suite is built
 * on adversarial verification; this makes it available on a single agent_run.
 *
 * Pure here: the prompts and the verdict parse. runVerification orchestrates
 * the round — reviewer, then at most one revision — through injected callbacks,
 * so the ordering and the workDir each child inspects are testable without a
 * live session. The extension supplies the real spawn.
 */

import type { AgentDef, RunState } from "./types.ts";

export const VERDICT_PASS = "VERDICT: PASS";
export const VERDICT_CHANGES = "VERDICT: CHANGES";

export function verifyPrompt(task: string, result: string): string {
  return [
    "You are reviewing another agent's work. Judge only whether it fully and correctly satisfies the task below —",
    "provable defects with real impact, never style or taste.",
    "",
    "== Task ==",
    task.trim(),
    "",
    "== Work produced ==",
    result.trim(),
    "",
    `Begin your reply with exactly "${VERDICT_PASS}" if it is correct and complete, or "${VERDICT_CHANGES}" if it needs`,
    "fixing. For CHANGES, follow it with a short numbered list of the specific problems to fix.",
  ].join("\n");
}

export interface Verdict {
  passed: boolean;
  /** The reviewer's required changes, when it did not pass. */
  feedback: string;
}

/**
 * Parse the reviewer's reply. Defaults to passed on an unclear reply — a
 * mangled review must never block a good result, and the reviewer had to opt
 * IN to changes by saying so.
 */
export function parseVerdict(text: string): Verdict {
  const t = (text ?? "").trim();
  if (/verdict:\s*changes/i.test(t)) {
    const feedback = t.replace(/^[\s\S]*?verdict:\s*changes\s*/i, "").trim();
    return { passed: false, feedback: feedback || t };
  }
  return { passed: true, feedback: "" };
}

export function revisionPrompt(task: string, feedback: string): string {
  return [
    "A reviewer found problems with your previous attempt. Fix exactly these, then produce the corrected,",
    "complete deliverable (not a diff or a description of the change).",
    "",
    "== Original task ==",
    task.trim(),
    "",
    "== Required changes ==",
    feedback.trim(),
  ].join("\n");
}

/** The seams runVerification needs from the extension, all injectable. */
export interface VerifyDeps {
  /** The reviewer agent, or undefined when no reviewer is configured. */
  reviewerDef: AgentDef | undefined;
  /** The worker that produced the result — reused for the revision pass. */
  workerDef: AgentDef;
  /** Build a fresh run record (mkRun in the extension). */
  mkRun(id: string, agent: string, task: string): RunState;
  /** Mint the next id for an agent (nextId in the extension). */
  nextId(agent: string): string;
  /** Register a new run so it shows in the widget and agent_result. */
  register(run: RunState): void;
  /** Spawn a child against workDir (runChild in the extension). */
  runChild(def: AgentDef, run: RunState, workDir?: string): Promise<void>;
}

/**
 * Auto peer-review of a settled worker result. A reviewer child judges it; a
 * failed review sends the worker back for one revision. Bounded to a single
 * round so it can never ping-pong, and best-effort — a reviewer that cannot run
 * leaves the result returned-but-unverified rather than failing the whole run.
 *
 * When the worker ran isolated, workDir is its worktree: the reviewer MUST
 * inspect that same tree, not the untouched main checkout, or it reviews work
 * it cannot see. The revision, likewise, must write back into it.
 */
export async function runVerification(
  run: RunState,
  workDir: string | undefined,
  deps: VerifyDeps,
): Promise<void> {
  const { reviewerDef, workerDef, mkRun, nextId, register, runChild } = deps;
  if (!reviewerDef || !run.result) return;

  const review = mkRun(nextId("reviewer"), "reviewer", verifyPrompt(run.task, run.result));
  register(review);
  await runChild(reviewerDef, review, workDir);
  if (review.status !== "done" || !review.result) {
    run.result = `${run.result}\n\n[verify: the reviewer did not complete — returning this result unverified]`;
    return;
  }
  const verdict = parseVerdict(review.result);
  if (verdict.passed) {
    run.result = `${run.result}\n\n[verified: reviewer passed]`;
    return;
  }

  const revision = mkRun(nextId(workerDef.name), workerDef.name, revisionPrompt(run.task, verdict.feedback));
  register(revision);
  await runChild(workerDef, revision, workDir);
  const notes = verdict.feedback.slice(0, 800);
  run.result =
    revision.status === "done" && revision.result
      ? `${revision.result}\n\n[verified: revised once after review]\nReviewer had required:\n${notes}`
      : `${run.result}\n\n[verify: the revision did not complete; returning the original with the review]\nReviewer had required:\n${notes}`;
}
