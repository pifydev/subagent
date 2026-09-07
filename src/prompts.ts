import type { AgentDef, RunState } from "./types.ts";

/** Framing appended to every child's system prompt after the def body. */
export const CHILD_FRAMING = [
  "You are a subagent running a single delegated task inside another agent's session.",
  "Your final assistant message IS the deliverable returned to the caller —",
  "make it a complete, self-contained report; do not ask follow-up questions.",
].join(" ");

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
