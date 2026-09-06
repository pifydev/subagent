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
  if (tools === null) return null;
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
  const promptMode = fields.get("system_prompt_mode")?.toLowerCase();
  const systemPromptMode = promptMode === "replace" ? "replace" : "append";
  const inheritSkills = !isFalse(fields.get("inherit_skills"));

  return {
    name: name.toLowerCase(),
    description,
    tools,
    model,
    thinking,
    maxTurns,
    systemPrompt: match[2]!.trim(),
    systemPromptMode,
    inheritSkills,
    source,
  };
}

/** Frontmatter booleans, written the handful of ways people write them. */
function isFalse(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["false", "no", "off", "0"].includes(raw.trim().toLowerCase());
}

/**
 * Read-only default keeps a def missing `tools:` from mutating anything.
 * A `tools:` line where NOTHING resolves is different: the author asked for
 * a specific tool set and got the read-only default instead, so the agent
 * runs with a contract nobody wrote. That is rejected — the file is named,
 * rather than quietly running as something else.
 */
function parseTools(raw: string | undefined): ValidTool[] | null {
  if (!raw) return ["read", "grep", "find", "ls"];
  const requested = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) return ["read", "grep", "find", "ls"];
  const valid = requested.filter((t): t is ValidTool =>
    (VALID_TOOLS as readonly string[]).includes(t),
  );
  return valid.length > 0 ? valid : null;
}
