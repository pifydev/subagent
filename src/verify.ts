/**
 * Automatic peer-review of a subagent's output.
 *
 * ask_supervisor escalates a decision to the human; this is the other half — a
 * worker's result is checked by a reviewer child before the caller accepts it,
 * and a failed review sends the worker back for one revision. The suite is built
 * on adversarial verification; this makes it available on a single agent_run.
 *
 * Pure here: the prompts and the verdict parse. The extension spawns the
 * reviewer and the revision run, bounded to one round so it can never ping-pong.
 */

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
