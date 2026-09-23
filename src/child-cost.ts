/**
 * What the children cost, across every @pify extension in the process.
 *
 * subagent, swarm and workflow run their children as separate in-memory pi
 * sessions, so a child's spend never reaches the parent session's branch —
 * and the usage footer, which folds the branch, under-reports every session
 * that delegates. This is the one place they all add to and the footer reads.
 *
 * The state lives on `globalThis` under a cross-realm `Symbol.for` key, not
 * in a module variable: pi's loader gives each extension its own module realm
 * (jiti, `moduleCache: false`), so a module singleton would be a different
 * object in every package that vendors this file. Same reasoning as
 * ui-lock.ts. Vendored per package, byte-identical, zero dependencies; every
 * function is safe to call whether or not any other package is installed.
 */

const KEY = Symbol.for("pify.child-cost");

export interface ChildSpend {
  /** USD, as pi priced each child message (usage.cost.total). */
  cost: number;
  /** usage.totalTokens summed over child messages. */
  tokens: number;
}

interface Store {
  bySource: Map<string, ChildSpend>;
  listeners: Set<() => void>;
}

function store(): Store {
  const g = globalThis as unknown as { [KEY]?: Store };
  return (g[KEY] ??= { bySource: new Map(), listeners: new Set() });
}

/** Record one child message's spend under its package ("subagent", "swarm", "workflow"). Non-finite or negative parts are ignored. */
export function addChildSpend(source: string, spend: { cost?: number; tokens?: number }): void {
  const cost = typeof spend.cost === "number" && Number.isFinite(spend.cost) && spend.cost > 0 ? spend.cost : 0;
  const tokens =
    typeof spend.tokens === "number" && Number.isFinite(spend.tokens) && spend.tokens > 0 ? Math.round(spend.tokens) : 0;
  if (cost === 0 && tokens === 0) return;
  const s = store();
  const prev = s.bySource.get(source) ?? { cost: 0, tokens: 0 };
  s.bySource.set(source, { cost: prev.cost + cost, tokens: prev.tokens + tokens });
  for (const listener of s.listeners) {
    try {
      listener();
    } catch {
      // A footer that cannot redraw is not the child's problem.
    }
  }
}

/** Everything the children have spent this session, and which packages spent it. */
export function childSpendTotal(): ChildSpend & { sources: string[] } {
  const s = store();
  let cost = 0;
  let tokens = 0;
  for (const spend of s.bySource.values()) {
    cost += spend.cost;
    tokens += spend.tokens;
  }
  return { cost, tokens, sources: [...s.bySource.keys()].sort() };
}

/** Start a new tally — a new session's children, not the last one's. */
export function resetChildSpend(): void {
  store().bySource.clear();
}

/** Be told after every addition; returns the unsubscribe. */
export function onChildSpend(listener: () => void): () => void {
  const s = store();
  s.listeners.add(listener);
  return () => {
    s.listeners.delete(listener);
  };
}
