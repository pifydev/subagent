/**
 * Verification a model cannot talk its way past.
 *
 * `verify` asks a reviewer agent whether the work is good; that is a second
 * opinion, and it defaults to PASS when the reply is unclear because a mangled
 * review must not block a good result. A gate is the other kind of check: a
 * command runs in the tree the child actually worked in, and its exit status
 * and output are facts. The suite already had this — in @pify/workflow, where
 * only a workflow script could reach it — while agent_run, the tool where
 * children actually edit code, had nothing but the reviewer.
 *
 * A failed gate then gets one thing a workflow step does not: the child is
 * still there, so it can be sent back with the failure and the gate re-run.
 * Bounded, because an agent that cannot fix a build in two tries will not fix
 * it in ten, and each attempt costs a full child run.
 *
 * Pure orchestration with injected seams, like verify.ts: the gate runner and
 * the repair spawn are both parameters, so the whole cycle is testable without
 * a shell or a live session.
 */

import type { GateContract, GateOutcome, GateVerdict } from "./gate.ts";
import { gateVerification, type Verification } from "./outcome.ts";
import type { GateRecord } from "./types.ts";

/** The brief for a repair pass: the check, what it said, nothing else. */
export function repairPrompt(
  task: string,
  contract: GateContract,
  verdict: { reason: string; output: string },
): string {
  const output = verdict.output.trim();
  return [
    "Your work did not pass its verification check. Fix the cause and stop — do not change anything the",
    "check did not complain about, and do not modify the check itself to make it pass.",
    "",
    "== Original task ==",
    task.trim(),
    "",
    `== Check ==\n${contract.command}`,
    "",
    `== Verdict ==\n${verdict.reason}`,
    ...(output ? ["", `== Output ==\n${output.length > 4000 ? `…\n${output.slice(-4000)}` : output}`] : []),
    "",
    "When you are done, report exactly what you changed and why it fixes the check.",
  ].join("\n");
}

export interface GateCycleDeps {
  /** Run the gate in `cwd` and judge it (src/gate.ts runGate); a stub may answer synchronously. */
  runGate(contract: GateContract, cwd: string): (GateVerdict & { output: string }) | Promise<GateVerdict & { output: string }>;
  /** Send the child back with a repair brief; resolves when that pass settles. */
  repair(prompt: string): Promise<void>;
  /**
   * Can this agent change anything? A read-only agent handed a failing gate can
   * only re-report it, so asking it to repair burns a child run to no purpose.
   */
  canRepair: boolean;
  /** Repair passes allowed before the failure stands (0 disables). */
  maxAttempts: number;
  /** Other runs live in the same directory while the gate ran. */
  sharedWith?: string[];
}

/**
 * A repair is only worth spawning when the gate actually judged the work.
 * `no_attestation` means the gate never produced a verdict — a missing runner,
 * a typo, an unparseable pattern — and sending a child to fix a defect that was
 * never demonstrated is how an agent ends up "fixing" working code.
 */
export function repairable(outcome: GateOutcome): boolean {
  return outcome === "failure" || outcome === "result_missing" || outcome === "timeout";
}

/** Run the gate, repair once (or `maxAttempts` times) if it failed, re-run. */
export async function runGateCycle(
  task: string,
  contract: GateContract,
  cwd: string,
  deps: GateCycleDeps,
): Promise<{ record: GateRecord; verification: Verification }> {
  let verdict = await deps.runGate(contract, cwd);
  let repairs = 0;
  const limit = Math.max(0, Math.min(5, deps.maxAttempts));

  while (!verdict.ok && deps.canRepair && repairs < limit && repairable(verdict.outcome)) {
    await deps.repair(repairPrompt(task, contract, verdict));
    repairs++;
    verdict = await deps.runGate(contract, cwd);
  }

  const record: GateRecord = {
    command: contract.command,
    outcome: verdict.outcome,
    ok: verdict.ok,
    reason: verdict.reason,
    // A passing gate's output is noise in the caller's context; a failing one's
    // is the whole point.
    ...(verdict.ok ? {} : { output: verdict.output }),
    ...(deps.sharedWith?.length ? { sharedWith: [...deps.sharedWith] } : {}),
    ...(repairs > 0 ? { repairs } : {}),
  };
  return { record, verification: gateVerification(verdict.outcome) };
}
