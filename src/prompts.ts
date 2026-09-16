import type { AgentDef, RunState } from "./types.ts";
import { outcomeLine } from "./outcome.ts";

/** Longest gate output kept in the report; a failing suite prints books. */
const GATE_TAIL = 1200;

/**
 * What the gate proved, in the report. Shown whenever a gate ran — a pass is
 * as much a fact as a failure, and silence would make "verified" and "never
 * checked" look identical.
 */
function gateBlock(run: RunState): string[] {
  const gate = run.gate;
  if (!gate) return [];
  const lines = [`[gate] ${gate.outcome} — ${gate.reason} (\`${gate.command}\`)`];
  if (gate.repairs) {
    lines.push(`  repaired ${gate.repairs} time${gate.repairs === 1 ? "" : "s"} and re-run.`);
  }
  if (gate.sharedWith?.length) {
    lines.push(
      `  ${gate.sharedWith.join(", ")} ${gate.sharedWith.length === 1 ? "was" : "were"} also changing this directory — the verdict is true of the tree, not of this agent's work alone.`,
    );
  }
  if (!gate.ok && gate.output) {
    const tail = gate.output.length > GATE_TAIL ? `…\n${gate.output.slice(-GATE_TAIL)}` : gate.output;
    lines.push(tail.replace(/^/gm, "  "));
  }
  return lines;
}

/** The gate block plus the outcome line, for a run that has settled. */
function verdict(run: RunState): string {
  const parts = gateBlock(run);
  if (run.outcome) parts.push(outcomeLine(run.outcome, run.verification ?? "not-requested"));
  return parts.length > 0 ? `\n\n${parts.join("\n")}` : "";
}

/** Framing appended to every child's system prompt after the def body. */
const CHILD_BASE = [
  "You are a subagent running a single delegated task inside another agent's session.",
  "Your final assistant message IS the deliverable returned to the caller —",
  "make it a complete, self-contained report. Do not end your report with questions:",
  "the caller cannot reply to it.",
  "Close by stating each requirement from your brief and the concrete evidence it is met",
  "(the command you ran and what it showed); mark anything you could not verify as unverified",
  "rather than done. If you find yourself about to repeat what you just said without taking an",
  "action, stop and report where you are stuck instead — an idle turn is wasted.",
  "Finishing your turn is not the same as finishing the task: if you could not do it,",
  "end the report with a line reading exactly `OUTCOME: blocked` (a decision, access or",
  "information you do not have) or `OUTCOME: failed` (you tried and it does not work),",
  "so the caller does not have to infer it from your prose. Say nothing if it went fine.",
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
      ? `${header}\n${run.result}${verdict(run)}`
      : `${header}\nThe child finished without producing an answer. Do not wait for it — re-run with a narrower task, or do the work here.${verdict(run)}`;
  }
  if (run.status === "error") {
    const detail = run.error ?? "unknown failure";
    // A failure before the child produced a single turn is almost always a
    // config-level error (model, agent file, auth, an empty tool set) that
    // will fail identically on every respawn — so say "fix it", not "retry".
    // A failure mid-work means the child got partway and the brief, not the
    // config, is the thing to change (arhen/pi-core-subagent's classification).
    if (run.turns === 0) {
      return `${header}\nFailed before the child started: ${detail}\nThis is a configuration error (model, agent definition, auth, or tool set) — it will fail the same way if re-run. Fix the configuration rather than retrying.`;
    }
    return `${header}\nFailed after ${run.turns} turn${run.turns === 1 ? "" : "s"}: ${detail}\nThe child got partway; narrow the task or do it here rather than re-running the same brief.`;
  }
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
