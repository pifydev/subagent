/**
 * The model a child session can actually run on.
 *
 * pi 0.99 virtual models (`pi.registerVirtualModel`) route each request to a
 * physical model, and `ctx.model` names the VIRTUAL selection. The routing
 * table lives on the host's ModelRuntime; `createAgentSession()` without a
 * `modelRuntime` builds a fresh runtime that knows no virtual model, and the
 * child's first request is rejected as an unrouted virtual selection
 * (virtual-models.ts unroutedStream). The extension API exposes no router,
 * so the child takes the physical model the host last routed to: assistant
 * messages always record the physical provider/model that answered. Direct
 * `modelRegistry.streamSimple` calls are unaffected — the host routes them.
 *
 * Pure; the caller supplies the branch and the registry lookup. Vendored per
 * package, byte-identical, zero dependencies.
 */

export const VIRTUAL_MODEL_API = "pi-virtual";

export interface ModelLike {
  api?: string;
  provider?: string;
  id?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when the selection is a virtual model that only the host can route. */
export function isVirtualSelection(model: ModelLike | null | undefined): boolean {
  return Boolean(model && model.api === VIRTUAL_MODEL_API);
}

/** The physical provider/model of the latest successful assistant response on the branch, newest first. */
export function latestPhysicalResponse(entries: readonly unknown[]): { provider: string; model: string } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isRecord(entry)) continue;
    const message = isRecord(entry.message) ? entry.message : null;
    if (!message || message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    if (message.api === VIRTUAL_MODEL_API) continue; // failed routing leaves the virtual model on the message
    if (typeof message.provider === "string" && typeof message.model === "string") {
      return { provider: message.provider, model: message.model };
    }
  }
  return null;
}

export type ChildModelResolution<M extends ModelLike> =
  | { ok: true; model: M; routedFrom?: string }
  | { ok: false; reason: string };

/**
 * A physical model for a child, or a reason there is none. A physical
 * selection passes through; a virtual one is replaced by the physical model
 * of the latest response, looked up in the registry.
 */
export function resolveChildModel<M extends ModelLike>(
  model: M | null | undefined,
  entries: readonly unknown[],
  find: (provider: string, id: string) => M | undefined,
): ChildModelResolution<M> {
  if (!model) return { ok: false, reason: "No model available" };
  if (!isVirtualSelection(model)) return { ok: true, model };
  const virtual = `${model.provider ?? "?"}/${model.id ?? "?"}`;
  const last = latestPhysicalResponse(entries);
  if (!last) {
    return {
      ok: false,
      reason: `${virtual} is a virtual model and the session has no response to learn its physical model from yet — send one message first, or select a physical model for child agents.`,
    };
  }
  const physical = find(last.provider, last.model);
  if (!physical) {
    return {
      ok: false,
      reason: `${virtual} is a virtual model; its last physical model ${last.provider}/${last.model} is not in the registry — select a physical model for child agents.`,
    };
  }
  return { ok: true, model: physical, routedFrom: virtual };
}
