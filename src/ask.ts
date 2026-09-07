/**
 * `ask_supervisor`: the child's way out of a decision it should not be making
 * alone (nicobailon/pi-intercom's `contact_supervisor`, reshaped).
 *
 * A scoped child that hits an ambiguity has exactly two options today: guess,
 * or return early with nothing useful. Guessing is worse, because the guess
 * arrives wrapped in a confident report and the parent has no way to see that
 * a decision was made at all.
 *
 * Intercom routes such a question to the supervising *agent* through a local
 * broker, because its sessions are separate processes. Here the child runs
 * in-process while the parent is blocked inside the tool call that spawned
 * it, so the parent agent cannot answer — but the person can, and they are
 * the one who owns the decision anyway. The question goes to the same dialog
 * surface the rest of the suite uses.
 *
 * `progress_update` deliberately does not exist. It would let a child
 * interrupt a human with something nobody asked for; a child's progress
 * belongs in its report.
 */

export const ASK_REASONS = ["need_decision", "clarify_scope", "missing_access"] as const;
export type AskReason = (typeof ASK_REASONS)[number];

export const ASK_TOOL_NAME = "ask_supervisor";

export const ASK_TOOL_DESCRIPTION = [
  "Ask the person supervising this delegated task, and wait for their answer.",
  "Use it when continuing would mean inventing a decision that is theirs:",
  "need_decision (a product, API, or scope choice with no defensible default),",
  "clarify_scope (the brief admits two readings that lead to different work),",
  "missing_access (a file, credential, or permission the task needs is not available).",
  "Do not use it to report progress, to confirm something you can verify yourself,",
  "or to ask permission for work the brief already authorised. Each question costs",
  "the user an interruption, so ask the smallest question that unblocks you.",
].join(" ");

/** How the question is shown, and what the child gets back. */
export function askTitle(agent: string, reason: AskReason): string {
  const label: Record<AskReason, string> = {
    need_decision: "needs a decision",
    clarify_scope: "needs the scope clarified",
    missing_access: "is missing access",
  };
  return `Subagent ${agent} ${label[reason]}`;
}

export function askBody(question: string, context: string | undefined): string {
  return context?.trim() ? `${question.trim()}\n\n${context.trim()}` : question.trim();
}

/** The answer handed back to the child, including a declined one. */
export function formatAnswer(answer: string | null): string {
  if (answer === null || !answer.trim()) {
    return [
      "The supervisor did not answer.",
      "Do not invent the decision. Finish what the brief already authorises, and state in your",
      "report exactly what you could not decide and why it blocked you.",
    ].join(" ");
  }
  return `Supervisor's answer: ${answer.trim()}`;
}

export const ASK_BUDGET = 3;

/** What the child is told once it has used its questions up. */
export const ASK_EXHAUSTED = [
  `This task has already asked the supervisor ${ASK_BUDGET} times, which is the limit.`,
  "Proceed with what the brief authorises and report what remained undecided.",
].join(" ");
