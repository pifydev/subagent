import {
  DEFAULT_MAX_TURNS,
  THINKING_LEVELS,
  VALID_TOOLS,
  type AgentDef,
  type ThinkingLevelName,
  type ValidTool,
} from "./types.ts";

/**
 * Parse a Claude Code-compatible agent definition file:
 * `---` frontmatter with description / tools / model / thinking / max_turns,
 * body = system prompt. Line-based parser — no YAML dependency; unknown keys
 * are ignored, invalid values fall back to safe defaults.
 */
export function parseAgentFile(
  name: string,
  content: string,
  source: AgentDef["source"],
): AgentDef | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return null;

  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) fields.set(kv[1]!.toLowerCase(), kv[2]!.trim());
  }

  const description = fields.get("description") ?? "";
  if (!description) return null;

  const tools = parseTools(fields.get("tools"));
  const thinkingRaw = fields.get("thinking")?.toLowerCase();
  const thinking = (THINKING_LEVELS as readonly string[]).includes(thinkingRaw ?? "")
    ? (thinkingRaw as ThinkingLevelName)
    : null;

  const maxTurnsRaw = Number.parseInt(fields.get("max_turns") ?? "", 10);
  const maxTurns =
    Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0 && maxTurnsRaw <= 200
      ? maxTurnsRaw
      : DEFAULT_MAX_TURNS;

  const model = fields.get("model") || null;

  return {
    name: name.toLowerCase(),
    description,
    tools,
    model,
    thinking,
    maxTurns,
    systemPrompt: match[2]!.trim(),
    source,
  };
}

/** Read-only default keeps a def missing `tools:` from mutating anything. */
function parseTools(raw: string | undefined): ValidTool[] {
  if (!raw) return ["read", "grep", "find", "ls"];
  const requested = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const valid = requested.filter((t): t is ValidTool =>
    (VALID_TOOLS as readonly string[]).includes(t),
  );
  return valid.length > 0 ? valid : ["read", "grep", "find", "ls"];
}
