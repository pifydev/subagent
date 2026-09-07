/**
 * Stopping means stopping the children too.
 *
 * A run in this package is not one process: it is a tree of child agent
 * sessions, each with its own provider connection. The tool that started them
 * is handed an AbortSignal and the extension is told when the session goes
 * away — and until now neither reached the children. Pressing Esc, or
 * switching sessions with a run in flight, marked a record "aborted" while the
 * children kept talking to the provider on the user's money, writing into a
 * conversation nobody was reading.
 *
 * So every live child registers here, and the two places that mean "stop"
 * abort all of them. (The rule is FradSer-adjacent prior art: @zhushanwen's
 * subagent-workflow terminates running runs on session switch or shutdown
 * rather than letting them outlive the session that owns them.)
 */

/** The part of a child agent session this module needs. */
export interface Abortable {
  abort(): unknown;
}

export type CancelReason = "user-abort" | "session-switch" | "timeout";

/**
 * Live child sessions, grouped by the run that owns them. Registration
 * returns its own release, so a child that finishes normally leaves no trace
 * and cannot be aborted twice.
 */
export class LiveChildren {
  private byRun = new Map<string, Set<Abortable>>();

  register(runId: string, child: Abortable): () => void {
    let set = this.byRun.get(runId);
    if (!set) {
      set = new Set();
      this.byRun.set(runId, set);
    }
    set.add(child);
    return () => {
      const current = this.byRun.get(runId);
      if (!current) return;
      current.delete(child);
      if (current.size === 0) this.byRun.delete(runId);
    };
  }

  /** How many children of this run are still live. */
  count(runId: string): number {
    return this.byRun.get(runId)?.size ?? 0;
  }

  /** Total live children across every run. */
  total(): number {
    let sum = 0;
    for (const set of this.byRun.values()) sum += set.size;
    return sum;
  }

  /**
   * Abort every live child of one run and return how many were stopped. A
   * child that throws from abort() is still counted and still dropped: the
   * point is that nothing is left holding a connection, and one stubborn
   * child must not spare the others.
   */
  abortRun(runId: string): number {
    const set = this.byRun.get(runId);
    if (!set) return 0;
    let stopped = 0;
    for (const child of [...set]) {
      try {
        const result = child.abort();
        // abort() is async in pi; a rejection here is not ours to surface.
        void Promise.resolve(result).catch(() => {});
      } catch {
        // already gone
      }
      stopped++;
    }
    this.byRun.delete(runId);
    return stopped;
  }

  /** Abort every live child of every run. */
  abortAll(): number {
    let stopped = 0;
    for (const runId of [...this.byRun.keys()]) stopped += this.abortRun(runId);
    return stopped;
  }
}

/** One line for the run log, naming who stopped it and what that cost. */
export function cancelNote(reason: CancelReason, stopped: number): string {
  const children =
    stopped === 0 ? "no child agents were running" : `${stopped} child agent${stopped === 1 ? "" : "s"} stopped`;
  switch (reason) {
    case "user-abort":
      return `Cancelled by the user — ${children}. Work already finished is kept; the run itself did not complete.`;
    case "session-switch":
      return `The session went away, so the run was terminated — ${children}. Tokens already spent are not recoverable; start a new run for a result.`;
    case "timeout":
      return `The run exceeded its time limit — ${children}.`;
  }
}
