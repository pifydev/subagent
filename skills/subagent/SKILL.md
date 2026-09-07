---
name: subagent
description: Use when a task benefits from delegation to a focused child agent - code review by fresh eyes, parallel read-only research, or a scoped implementation task - explains agent_run/agent_result and how to write good task briefs
---

# Subagents

This project has the `@pify/subagent` extension installed: `agent_run` spawns
one child pi session per call, `agent_result` collects background runs.

## When to delegate

- **reviewer** — a diff, plan, or module needs fresh eyes; read-only, reports
  findings with evidence. Great right after you finish a change.
- **scout** — you need facts from elsewhere in the codebase without spending
  your own context reading files; read-only, returns paths + excerpts.
- **worker** — a well-scoped implementation task can proceed independently;
  full tools. Only delegate what you can specify completely.

Do not delegate trivial lookups (read the file yourself) or tasks whose
requirements you cannot state precisely.

## Writing the task brief

The child sees NONE of this conversation. The brief must be self-contained:
- the goal and its boundaries (what NOT to touch),
- relevant file paths you already know,
- the expected deliverable shape ("report findings as file:line + why").

## Foreground vs background

- Default (foreground) blocks and returns the report — use when you need the
  answer to continue.
- `background: true` returns an id immediately — use for work that can run
  while you continue; collect with `agent_result` before relying on it. At
  most 4 background runs at once.

Custom agent types: `.pi/agents/<name>.md` (description/tools/model/thinking/
max_turns frontmatter + system-prompt body) — project overrides global
overrides builtin.

## Reading a child's report

- A report marked `[partial: stopped at the N-turn cap]` is an unfinished
  answer. Say so, or re-run with a narrower task — never present it as the
  child's conclusion.
- An `error` or `aborted` run produced no result. A non-zero exit can never
  be described as success, and neither can a child that died: state what did
  not happen instead of filling the gap yourself.
