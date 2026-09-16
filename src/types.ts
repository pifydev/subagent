/**
 * Local structural types for @pify/subagent.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

import type { GateOutcome } from "./gate.ts";
import type { TaskOutcome, Verification } from "./outcome.ts";

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

/** What a gate proved about one run, kept alongside the run it judged. */
export interface GateRecord {
  command: string;
  outcome: GateOutcome;
  ok: boolean;
  /** One line in this package's words. */
  reason: string;
  /** Trimmed output, kept only when the gate did not pass. */
  output?: string;
  /** Other runs that were live in the same directory while it ran. */
  sharedWith?: string[];
  /** Repair passes spent trying to make it pass. */
  repairs?: number;
}

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
  /**
   * The directory the child worked in — its worktree when isolated, otherwise
   * undefined for the session's own cwd. A gate has to run where the work
   * happened, and concurrent runs sharing one directory make each other's
   * verdicts unattributable.
   */
  workDir?: string;
  /**
   * The child has finished but verify/gate is still running on its work, so
   * the status is "done" and the caller has not been handed anything yet.
   * Set by the extension, cleared when the outcome settles; never persisted.
   * Not the same as a missing outcome: helper runs and runs restored on
   * session_start never settle at all.
   */
  settling?: boolean;
  /** Set once the run settles: what the task came to, apart from whether the session finished. */
  outcome?: TaskOutcome;
  /** How well that outcome is known. "not-requested" when no gate ran. */
  verification?: Verification;
  gate?: GateRecord;
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
