/**
 * Waiting for a run without teaching the model to spin.
 *
 * A headless caller of agent_result has no delivery to fall back on: the
 * session ends with its turn, so the only way to get a background result is
 * to ask again, and "call again in this same turn" is a tight loop — a
 * request per check while the thing it is waiting on has not moved. Letting
 * the tool call itself wait turns that into one request that returns when
 * there is something to return.
 *
 * Pure: a predicate, a budget, a polling interval, and the tool's own
 * AbortSignal so Esc is not held hostage by the budget.
 */

/**
 * Poll `check` every `intervalMs` for up to `ms`. Resolves true as soon as it
 * passes, false at the deadline or on abort. A zero budget is one check.
 */
export function waitUntil(
  check: () => boolean,
  ms: number,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (check()) return Promise.resolve(true);
  if (ms <= 0 || signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(false);
    const tick = (): void => {
      if (check()) return finish(true);
      if (Date.now() >= deadline) return finish(false);
      timer = setTimeout(tick, Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(tick, Math.min(intervalMs, ms));
  });
}
