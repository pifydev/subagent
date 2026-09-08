/**
 * Telling an agent to wait, without teaching it to poll.
 *
 * A background run gave the model exactly one way to find out it had
 * finished: call the status tool again. "Still running — call agent_result
 * later" is an instruction to spin, and models follow it, burning a turn and a
 * request per check while the thing they are waiting for has not moved.
 *
 * Two halves fix that, and only together:
 *
 *   - a not-ready answer that is a normal structured result rather than an
 *     error, carrying `retryable` and saying what to do *instead* of waiting.
 *     Throwing would be worse than useless — a tool error invites the model's
 *     own retry machinery into a loop over a condition that time, not
 *     retrying, resolves;
 *   - a push when the run actually finishes, so waiting is never the only
 *     option on the table.
 *
 * Pure: the shapes and the words. The extension owns the clock and the host.
 */

export type PendingKind = "queued" | "running";

export interface PendingInput {
  /** The id the caller would poll with. */
  id: string;
  kind: PendingKind;
  startedAt: number;
  now: number;
  /** What the caller asks for to collect it, e.g. `agent_result`. */
  collectWith: string;
}

export interface PendingResult {
  text: string;
  details: {
    id: string;
    status: PendingKind;
    /** True: this will resolve on its own. It is a wait, not a failure. */
    retryable: boolean;
    elapsedMs: number;
    /** False, and load-bearing: there is nothing to poll for. */
    pollRequired: false;
  };
}

function elapsed(ms: number): string {
  if (ms < 1000) return "just started";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s so far`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s so far`;
}

/**
 * The answer to "is it done yet". It says no, says why that is fine, and
 * closes the loop the question came from.
 */
export function pendingResult(input: PendingInput): PendingResult {
  const ms = Math.max(0, input.now - input.startedAt);
  const state = input.kind === "queued" ? "queued behind the concurrency cap" : "still running";
  return {
    text: [
      `${input.id} is ${state} (${elapsed(ms)}).`,
      "",
      "Do not poll for it. The result is delivered to you automatically the moment it lands,",
      `so there is nothing to wait for here — carry on with other work, or finish your turn and`,
      `you will be picked back up. ${input.collectWith} is only needed if you want it early.`,
    ].join("\n"),
    details: { id: input.id, status: input.kind, retryable: true, elapsedMs: ms, pollRequired: false },
  };
}

/** How a finished run introduces itself when it arrives unasked. */
export function deliveryMessage(id: string, label: string, body: string): string {
  return [
    `<${label}_result id="${id}">`,
    body.trim(),
    `</${label}_result>`,
    "",
    `This is ${id}, which you started in the background; it has just finished and this is its report.`,
    "Fold it into what you are doing. If you had already moved on, say what it changes — or that it changes nothing.",
  ].join("\n");
}

/** The custom-message type a delivered result travels under. */
export const DELIVERY_TYPE = "pify-background-result";
