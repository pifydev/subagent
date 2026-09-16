/**
 * "It finished" and "it worked" are different facts.
 *
 * RunStatus answers the first one: did the child session run to the end, error
 * out, or get stopped. It says nothing about whether the task was actually
 * accomplished, so a child that hits its brief's wall at turn three and writes
 * a polite report explaining why is recorded exactly like one that shipped the
 * feature — `done`. The caller then has to read prose to find out which.
 *
 * So record the task outcome separately, and record *how well it is known*
 * separately again. A gate that ran and failed is evidence and overrides a
 * child's claim of success. A gate that could not run, or that exited 0 without
 * proving anything, is not evidence of failure either — reporting it as one
 * would blame the work for a typo in the gate. That case leaves the outcome
 * alone and says the verification was inconclusive.
 *
 * Pure and dependency-free: every rule here is a function of facts the
 * extension already has.
 */

import type { GateOutcome } from "./gate.ts";

/** What the delegated task actually came to. */
export type TaskOutcome = "succeeded" | "blocked" | "failed";

/** How well that outcome is known. Orthogonal to the outcome itself. */
export type Verification = "not-requested" | "passed" | "failed" | "inconclusive";

/** The marker a child may end its report with to declare its own outcome. */
const DECLARATION = /^\s*outcome:\s*(succeeded|blocked|failed)\s*$/gim;

/**
 * Read a child's self-declared outcome, if it made one. Last declaration wins:
 * a report that revises itself means the later line.
 *
 * This is a *claim*, not evidence — the value is that it is parseable, and that
 * a blocked child can say so in one place instead of burying it in prose.
 * Absent or unparseable means "no claim", never a failure.
 */
export function parseDeclaredOutcome(text: string | null | undefined): TaskOutcome | undefined {
  if (!text) return undefined;
  let found: TaskOutcome | undefined;
  DECLARATION.lastIndex = 0;
  for (const m of text.matchAll(DECLARATION)) found = m[1]!.toLowerCase() as TaskOutcome;
  return found;
}

/** Strip the declaration line so it does not also show up in the report body. */
export function stripDeclaration(text: string): string {
  return text.replace(DECLARATION, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** What a finished gate proved about the work, in verification terms. */
export function gateVerification(outcome: GateOutcome): Verification {
  if (outcome === "success") return "passed";
  if (outcome === "failure" || outcome === "timeout") return "failed";
  // result_missing and no_attestation both mean the gate settled without
  // establishing anything — not a verdict against the work.
  return "inconclusive";
}

export interface OutcomeInput {
  /** Lifecycle: did the session itself run to the end? */
  status: "running" | "done" | "error" | "aborted";
  /** The child's own claim, when it made one. */
  declared?: TaskOutcome;
  /** What the gate proved, when one ran. */
  verification?: Verification;
}

/**
 * Settle the task outcome from the facts, most authoritative first:
 * a session that did not finish cannot have succeeded; a gate that failed
 * outranks any claim; then the child's own claim; then success by default.
 */
export function deriveOutcome(input: OutcomeInput): TaskOutcome {
  if (input.status !== "done") return "failed";
  if (input.verification === "failed") return "failed";
  if (input.declared) return input.declared;
  return "succeeded";
}

/** One line for the report, naming both facts. */
export function outcomeLine(outcome: TaskOutcome, verification: Verification): string {
  const how =
    verification === "not-requested"
      ? "no gate was requested, so this is the agent's own account"
      : verification === "passed"
        ? "a gate ran and passed"
        : verification === "failed"
          ? "a gate ran and failed"
          : "a gate ran but proved nothing either way";
  return `[outcome] ${outcome} — ${how}`;
}
