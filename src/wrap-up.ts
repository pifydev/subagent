/**
 * The last turn before a child's turn cap should be a report, not more
 * exploration. The cap itself is an abrupt stop at message_end: the child
 * never hears it coming, so its final turn is spent on another tool call and
 * the parent gets whatever text it last happened to write, tagged partial.
 * One steer, one turn early, tells it to stop and synthesize; the abort at
 * the cap and the partial tag stay as the fallback when it does not listen.
 * Vendored per package (subagent, swarm), byte-identical; zero dependencies.
 */

/** Below this cap there is no room to warn — the child is already brief. */
export const WRAP_UP_MIN_TURNS = 4;

/** True on the one turn where the notice should go out. */
export function shouldWrapUp(turns: number, maxTurns: number, alreadySent: boolean): boolean {
  return !alreadySent && maxTurns >= WRAP_UP_MIN_TURNS && turns === maxTurns - 1;
}

/** The steering message itself. */
export function wrapUpNotice(maxTurns: number): string {
  return (
    `[turn budget] This is your last turn: you have used ${maxTurns - 1} of ${maxTurns}. ` +
    "Stop exploring now. Do not call more tools unless a single call is essential to finish. " +
    "Write your final report in this message — complete and self-contained, stating what was done, " +
    "what evidence you have, and what remains unverified."
  );
}
