import type { AgentDef, RunState } from "./types.ts";

/** Framing appended to every child's system prompt after the def body. */
const CHILD_BASE = [
  "You are a subagent running a single delegated task inside another agent's session.",
  "Your final assistant message IS the deliverable returned to the caller —",
  "make it a complete, self-contained report. Do not end your report with questions:",
  "the caller cannot reply to it.",
].join(" ");

/**
 * Framing for the child. `canAsk` adds the one exception to "do not ask":
 * a decision that is genuinely the supervisor's. Without this line the
 * ask_supervisor tool is unreachable in practice: the base framing forbids
 * asking, and a model follows the prompt over a tool description.
 *
 * Measured across qwen3-235b, gpt-5.5 and claude-sonnet-4.5 on two framings
 * of an underspecified task: with the tool registered and this line present,
 * six runs out of six asked instead of inventing the answer.
 */
export function childFraming(canAsk: boolean): string {
  if (!canAsk) return CHILD_BASE;
  return [
    CHILD_BASE,
    "The one exception: if continuing would mean inventing a decision that belongs to the",
    "supervisor — an unstated product/API/scope choice, or missing access — call ask_supervisor",
    "and wait for the answer instead of guessing. Ask the smallest question that unblocks you.",
  ].join(" ");
}

/** @deprecated use childFraming(); kept so an older import still resolves. */
export const CHILD_FRAMING = CHILD_BASE;

/** The task prompt sent to the child session. */
export function buildTaskPrompt(task: string): string {
  return task.trim();
}

/** Tool-result text returned to the parent model for a finished run. */
export function formatRunResult(run: RunState): string {
  const header = `[${run.agent} · ${run.id} · ${run.status} · ${run.turns} turns]`;
  if (run.status === "done") {
    // Only a run that is genuinely still running may be reported as such.
    return run.result
      ? `${header}\n${run.result}`
      : `${header}\nThe child finished without producing an answer. Do not wait for it — re-run with a narrower task, or do the work here.`;
  }
  if (run.status === "error") return `${header}\nError: ${run.error ?? "unknown failure"}`;
  if (run.status === "aborted") {
    return `${header}\nAborted (turn limit or user stop). Partial output:\n${run.result ?? "(none)"}`;
  }
  return `${header}\nStill running — call agent_result with id "${run.id}" later.`;
}

/** Summary for /agents. */
export function describeDefs(defs: AgentDef[]): string {
  return defs
    .map((d) => `${d.name} (${d.source}) — ${d.description} [${d.tools.join(", ")}]`)
    .join("\n");
}
