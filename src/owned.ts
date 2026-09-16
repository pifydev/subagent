/**
 * A helper child belongs to the run that asked for it.
 *
 * verify and gate spawn their own children — a reviewer, a revision, a repair
 * pass — each with a fresh record and a fresh id. They were registered with
 * LiveChildren under that fresh id only, so `cancelRun(parent)` aborted
 * nothing: Esc during a repair marked the parent and left the repair child
 * talking to the provider on the user's money.
 *
 * So a child is filed under two names: its own, so it can still be stopped
 * directly, and its owner's, so stopping the parent stops the tree. A
 * top-level run owns itself and is filed once.
 */

import type { Abortable, LiveChildren } from "./cancel.ts";

/** Register `child` under its own run id and its owner's; one release clears both. */
export function registerOwned(live: LiveChildren, runId: string, owner: string, child: Abortable): () => void {
  const releases = [live.register(runId, child)];
  if (owner !== runId) releases.push(live.register(owner, child));
  return () => {
    for (const release of releases) release();
  };
}
