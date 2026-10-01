/**
 * What a child "spent", in tokens, without counting the cache twice.
 *
 * pi's per-message `usage.totalTokens` is input + output + cacheRead +
 * cacheWrite (anthropic-messages.ts computes it from the components; other
 * adapters report the provider's total, which has the same shape). cacheRead
 * on each turn is the whole cached prefix read back on that one call, so
 * summing totalTokens across a child's turns counts the prefix once per
 * turn: a 30-turn child with a 20k cached prefix reports ~600k tokens of
 * "work" it never did. Cost is unaffected (cacheRead is priced separately),
 * but the widget count, the suite-wide child tally, and a workflow budget
 * all read the inflated number. (signalridge pi-subagents usage.ts, #38.)
 *
 * This sums input + output + cacheWrite: the tokens the child actually
 * produced or newly cached. Vendored per package, byte-identical.
 */

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Tokens the child produced or newly cached on one message: never the cached prefix re-read. */
export function childTokens(usage: UsageLike | null | undefined): number {
  if (!usage) return 0;
  const parts = num(usage.input) + num(usage.output) + num(usage.cacheWrite);
  // A provider that reports only a total (no split) still counts something.
  if (parts === 0 && usage.input === undefined && usage.output === undefined) return num(usage.totalTokens);
  return parts;
}
