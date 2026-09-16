/**
 * Who may be sent back to fix a failed gate.
 *
 * A repair pass costs a full child run, so it is only worth spawning when the
 * child could plausibly land a fix. Two things rule that out before the gate
 * has even said anything: an agent without a writing tool can only re-report
 * the failure, and a child that ended its report with `OUTCOME: blocked` has
 * already said the fix is not in its hands — a decision, access or
 * information it does not have. Sending that child back with the test output
 * is asking it to guess at what it just told us it cannot know.
 *
 * `failed` is different: it tried and it does not work, and a gate's output
 * is exactly the information that might make a second attempt land.
 */

import { parseDeclaredOutcome } from "./outcome.ts";
import type { AgentDef } from "./types.ts";

/** An agent that can write is one that can fix what a gate complained about. */
export function canWrite(def: AgentDef): boolean {
  return def.tools.some((t) => t === "edit" || t === "write" || t === "bash" || t === "powershell");
}

/**
 * May this agent be sent on repair passes for the result it produced? Read
 * BEFORE the outcome settles: settleOutcome strips the declaration line, and
 * after that the report no longer says it was blocked.
 */
export function repairAllowed(def: AgentDef, result: string | null): boolean {
  return canWrite(def) && parseDeclaredOutcome(result) !== "blocked";
}
