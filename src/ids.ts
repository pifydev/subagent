/**
 * Run ids are "<agent>-<n>" — "reviewer-1", "worker-2". The counter that mints
 * them lives only in memory.
 *
 * A /reload replays this session's completed runs back into the runs map (so
 * agent_result keeps working), but the counter starts from nothing, so the next
 * mint is "reviewer-1" again — the id a replayed run already holds. runs.set()
 * then overwrites that live record with a new run under the same id. Re-seed the
 * counter from the ids already present so the next mint is always past the
 * highest one seen, and the collision cannot happen.
 *
 * Pure and pi-free: seedCounters/mintRunId operate on a plain Map so the
 * re-seed logic is testable without a session.
 */

/** Mint the next id for an agent ("reviewer" → "reviewer-1", then "-2", …). */
export function mintRunId(counters: Map<string, number>, agent: string): string {
  const n = (counters.get(agent) ?? 0) + 1;
  counters.set(agent, n);
  return `${agent}-${n}`;
}

/**
 * Raise each agent's counter past the highest id already in use, so a mint
 * after a /reload never collides with a replayed run. Only ids of the exact
 * "<name>-<n>" shape feed a counter (the greedy prefix keeps a slug suffix like
 * "worker-1-2" on its own key, never touching "worker"); anything without a
 * trailing integer is ignored. Never lowers a counter.
 */
export function seedCounters(counters: Map<string, number>, ids: Iterable<string>): void {
  for (const id of ids) {
    const m = /^(.+)-(\d+)$/.exec(id);
    if (!m) continue;
    const prefix = m[1];
    const digits = m[2];
    if (prefix === undefined || digits === undefined) continue;
    const n = Number(digits);
    if (!Number.isSafeInteger(n)) continue;
    if (n > (counters.get(prefix) ?? 0)) counters.set(prefix, n);
  }
}
