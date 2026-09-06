/**
 * Local structural types for @pify/subagent.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

export const VALID_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type ValidTool = (typeof VALID_TOOLS)[number];

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevelName[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** A parsed agent definition (from builtin constants or *.md files). */
export interface AgentDef {
  name: string;
  description: string;
  tools: ValidTool[];
  /** "provider/model-id" or null to inherit the session model. */
  model: string | null;
  thinking: ThinkingLevelName | null;
  /** Assistant round-trips before the child is aborted. */
  maxTurns: number;
  /** Markdown body appended to the child's system prompt. */
  systemPrompt: string;
  /**
   * "append" (default) puts the body after the session's own system prompt;
   * "replace" drops the parent's prompt so a specialist is not also told to
   * be this project's coding assistant.
   */
  systemPromptMode: "append" | "replace";
  /** Whether the child loads the project's skills (default true). */
  inheritSkills: boolean;
  source: "builtin" | "global" | "project";
}

export const DEFAULT_MAX_TURNS = 30;
export const MAX_CONCURRENT_BACKGROUND = 4;

export type RunStatus = "running" | "done" | "error" | "aborted";

export interface RunState {
  id: string;
  agent: string;
  task: string;
  background: boolean;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  tokens: number;
  turns: number;
  result: string | null;
  error: string | null;
}

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
