/**
 * Resolving a pinned model id.
 *
 * An agent file pins `provider/id`. The registry is exact: `claude-haiku-4.5`
 * is not `claude-haiku-4-5`, and a dated snapshot is not its undated alias.
 * A miss used to be silent in two of the three packages — the child ran on
 * the parent session's model, defeating the cost intent and any "must run
 * on X" guarantee. This matcher tries the exact id, then a NORMALIZED exact
 * match (lowercase, `.` → `-`, an optional trailing 8-digit date stamp
 * ignored) within the SAME provider only; it never guesses across providers
 * or by substring, so a hard pin can never land on a different model. A
 * miss comes back as a reason the caller must surface. Vendored per package,
 * byte-identical; zero dependencies.
 */

export interface ModelRef {
  provider: string;
  id: string;
}

export interface RegistryLike<M extends ModelRef> {
  find(provider: string, id: string): M | undefined;
  getAll(): M[];
}

/** `claude-haiku-4.5` and `claude-haiku-4-5-20251001` both become `claude-haiku-4-5`. */
export function normalizeModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/-\d{8}$/, "");
}

export type PinResolution<M extends ModelRef> = { model: M; normalized?: true } | { model: null; reason: string };

/** The model a `provider/id` pin names, exactly or under normalization, or why it names none. */
export function findPinnedModel<M extends ModelRef>(registry: RegistryLike<M>, pin: string): PinResolution<M> {
  const [provider, ...rest] = pin.trim().split("/");
  const id = rest.join("/");
  if (!provider || !id) return { model: null, reason: `model "${pin}" is not provider/id` };
  const exact = registry.find(provider, id);
  if (exact) return { model: exact };
  const wanted = normalizeModelId(id);
  let all: M[] = [];
  try {
    all = registry.getAll();
  } catch {
    all = [];
  }
  const candidates = all.filter((m) => m.provider === provider && normalizeModelId(m.id) === wanted);
  if (candidates.length === 1) return { model: candidates[0]!, normalized: true };
  if (candidates.length > 1) {
    return { model: null, reason: `model ${pin} is ambiguous (${candidates.map((m) => m.id).join(", ")})` };
  }
  return { model: null, reason: `model ${pin} not found` };
}
