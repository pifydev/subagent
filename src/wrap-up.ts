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

/**
 * Turns a child may still take after the cap before the hard stop. The
 * notice goes out one turn before the cap and invites one essential tool
 * call; spending that turn on the call used to forfeit the report, because
 * the abort fired at the next message_end before the child saw the tool
 * result. Two more turns let it land the answer; the loop guard and the
 * run deadline remain the backstops. A child that finishes inside the
 * window is not a capped run — it stopped cleanly and is reported as such.
 */
export const GRACE_TURNS = 2;

/** True once the child has used its cap AND its grace. */
export function shouldAbort(turns: number, maxTurns: number, grace: number = GRACE_TURNS): boolean {
  return turns >= maxTurns + grace;
}

/** True on the one turn where the notice should go out. */
export function shouldWrapUp(turns: number, maxTurns: number, alreadySent: boolean): boolean {
  return !alreadySent && maxTurns >= WRAP_UP_MIN_TURNS && turns === maxTurns - 1;
}

/** The steering message itself. */
export function wrapUpNotice(maxTurns: number, grace: number = GRACE_TURNS): string {
  return (
    `[turn budget] You have used ${maxTurns - 1} of ${maxTurns} turns; a hard stop follows at most ${grace} turns after the cap. ` +
    "Stop exploring now. Do not call more tools unless a single call is essential to finish. " +
    "Write your final report as soon as you can — complete and self-contained, stating what was done, " +
    "what evidence you have, and what remains unverified."
  );
}
