/**
 * What a gate actually proved.
 *
 * A gate exists so a step is verified by running something rather than by a
 * model saying it went well. Judging that run by its exit code alone leaves a
 * hole big enough to drive a workflow through: a command that never ran the
 * check still exits 0. A mistyped script name under `sh -c`, a test runner
 * that matched no tests, a `|| true` someone left in — each one reports
 * success while proving nothing.
 *
 * So a gate may state what success looks like. When it does, exiting 0
 * without that evidence is its own outcome (`result_missing`) rather than a
 * pass. The vocabulary is FradSer/pi-monitor's result contract.
 *
 * The same distinction runs one step further. A check that ran and said no is
 * evidence; a check that could not run at all is *not evidence of anything*.
 * A misspelled command, a runner that is not installed, a gate whose own regex
 * does not compile — none of those are the code failing, and reporting them as
 * `failure` sends the reader looking for a bug in the work instead of a typo
 * in the gate. That case is `no_attestation`: still not a pass, but honest
 * about having proved nothing either way.
 */

import { spawnSync } from "node:child_process";

export type GateOutcome =
  | "success"
  | "failure"
  | "result_missing"
  | "timeout"
  | "no_attestation";

export interface GateContract {
  /** The command to run. */
  command: string;
  /** Regex source: success requires a match in the combined output. */
  expect?: string;
  /** Regex source: a match means failure even when the command exits 0. */
  failure?: string;
  timeoutMs?: number;
}

export interface GateRun {
  /** Exit status, or null when the process was killed (timeout/signal). */
  status: number | null;
  /** Signal that killed it, when one did. */
  signal?: string | null;
  output: string;
  /** True when the runner stopped it at the timeout. */
  timedOut?: boolean;
  /**
   * The command never became a process — it could not be spawned, the shell
   * was missing, the working directory was gone. Not a verdict on the work.
   */
  spawnError?: string;
}

export interface GateVerdict {
  outcome: GateOutcome;
  ok: boolean;
  /** One line for the run log, in this package's words. */
  reason: string;
}

/** Accept a bare command string or a full contract. */
export function normalizeGate(gate: string | GateContract): GateContract {
  return typeof gate === "string" ? { command: gate } : gate;
}

function compile(source: string | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, "m");
  } catch {
    return null;
  }
}

/**
 * Judge a finished gate run. Order matters: a timeout is a timeout whatever
 * else happened, an explicit failure pattern beats a zero exit, and a missing
 * success pattern is never a pass.
 */
export function evaluateGate(contract: GateContract, run: GateRun): GateVerdict {
  if (run.spawnError) {
    return {
      outcome: "no_attestation",
      ok: false,
      reason: `gate never ran (${run.spawnError}) — nothing was proved either way`,
    };
  }

  // A timeout is a real verdict: the check was given its deadline and did not
  // clear it. That is different from the case below.
  if (run.timedOut || (run.status === null && run.signal)) {
    return {
      outcome: "timeout",
      ok: false,
      reason: `gate timed out after ${contract.timeoutMs ?? "the default"}ms`,
    };
  }

  // Neither an exit code nor a signal: the process did not run to a verdict
  // and nothing killed it, so there is no result to report as one.
  if (run.status === null) {
    return {
      outcome: "no_attestation",
      ok: false,
      reason: "gate produced no exit status — nothing was proved either way",
    };
  }

  const failurePattern = compile(contract.failure);
  if (failurePattern && failurePattern.test(run.output)) {
    return {
      outcome: "failure",
      ok: false,
      reason: `gate output matched its failure pattern /${contract.failure}/`,
    };
  }

  if (run.status !== 0) {
    return { outcome: "failure", ok: false, reason: `gate exited ${run.status}` };
  }

  const expectPattern = compile(contract.expect);
  if (expectPattern && !expectPattern.test(run.output)) {
    // The hole this closes: the command ran, said nothing that proves the
    // check happened, and exited 0.
    return {
      outcome: "result_missing",
      ok: false,
      reason: `gate exited 0 but its output never matched /${contract.expect}/ — nothing was verified`,
    };
  }

  return {
    outcome: "success",
    ok: true,
    reason: expectPattern ? `gate passed and matched /${contract.expect}/` : "gate exited 0",
  };
}

/** The part of a call a gate needs in order to know who else was in the room. */
export interface GateSibling {
  id: number;
  label: string;
  status: string;
  workDir?: string;
}

/**
 * Which other calls were live in the same working directory while this gate
 * ran — the ones that make its verdict unattributable.
 *
 * Only concurrency in the *same* directory counts. Two agents under
 * `isolation: "worktree"` have their own checkouts and cannot disturb each
 * other, which is exactly why isolation is the fix rather than a warning.
 */
export function sharedWith(
  self: GateSibling,
  subject: string,
  siblings: readonly GateSibling[],
): string[] {
  return siblings
    .filter((s) => s.id !== self.id && s.status === "running" && (s.workDir ?? subject) === subject)
    .map((s) => s.label);
}

/**
 * One line saying what a verdict is worth, given who else was editing.
 * A pass earned over a tree two other agents were changing is reported as what
 * it is: true of the tree, not of this agent's work.
 */
export function attributionNote(record: {
  ok: boolean;
  sharedWith: readonly string[];
}): string | null {
  if (record.sharedWith.length === 0) return null;
  const others = record.sharedWith.join(", ");
  return record.ok
    ? `judged a directory ${others} ${record.sharedWith.length === 1 ? "was" : "were"} also changing — true of the tree, not of this agent's work alone`
    : `judged a directory ${others} ${record.sharedWith.length === 1 ? "was" : "were"} also changing — the cause may not be this agent's work`;
}

/** An unparseable pattern is a broken contract, not a passing one. */
export function contractProblems(contract: GateContract): string[] {
  const problems: string[] = [];
  if (!contract.command.trim()) problems.push("gate has no command");
  for (const [field, source] of [
    ["expect", contract.expect],
    ["failure", contract.failure],
  ] as const) {
    if (source && !compile(source)) problems.push(`gate ${field} is not a valid regular expression`);
  }
  if (contract.timeoutMs !== undefined && !(contract.timeoutMs > 0)) {
    problems.push("gate timeoutMs must be positive");
  }
  return problems;
}

/** How long a gate may run before the deadline is its verdict. */
export const GATE_TIMEOUT_MS = 120_000;

/**
 * Run a gate and judge it against its contract, with the shell in the subject
 * working directory. A bare string keeps the exit-code meaning; a contract can
 * also say what success has to look like, which is what stops a command that
 * never ran the check from passing.
 *
 * The command comes from the caller — the same trust level as the bash tool in
 * this session — so this adds no capability the caller did not already have.
 */
export function runGate(gate: string | GateContract, cwd: string): GateVerdict & { output: string } {
  const contract = normalizeGate(gate);
  const problems = contractProblems(contract);
  if (problems.length > 0) {
    // A gate that cannot be run is not a verdict on the work. Calling this a
    // failure would report a typo in the gate as a defect in the code.
    return { outcome: "no_attestation", ok: false, reason: problems.join("; "), output: "" };
  }
  const timeoutMs = contract.timeoutMs ?? GATE_TIMEOUT_MS;
  try {
    const result = spawnSync(contract.command, {
      shell: true,
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      // A real test suite or build easily prints past spawnSync's 1 MiB
      // default; overflow surfaces as an ENOBUFS `error`, which this code
      // would otherwise read as spawnError → no_attestation, rejecting work
      // that in fact passed. Give the gate room to actually report.
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const verdict = evaluateGate(
      { ...contract, timeoutMs },
      {
        status: result.status,
        signal: result.signal,
        output,
        timedOut: result.error?.message?.includes("ETIMEDOUT") || result.signal === "SIGTERM",
        // spawnSync reports a failure to start in `error` rather than by
        // throwing, and a timeout arrives the same way — so the timeout has to
        // be ruled out first or every deadline would read as "never ran".
        spawnError:
          result.error && !result.error.message?.includes("ETIMEDOUT")
            ? result.error.message
            : undefined,
      },
    );
    return { ...verdict, output };
  } catch (err) {
    return {
      outcome: "no_attestation",
      ok: false,
      reason: `gate could not be started: ${err instanceof Error ? err.message : String(err)}`,
      output: "",
    };
  }
}
