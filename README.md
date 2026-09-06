# @pify/subagent

Spawn scoped subagents from within a [pi](https://github.com/earendil-works/pi) session. One tool call, one focused child agent — with its own tool allowlist, model, thinking level, and turn cap.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install subagent`](https://github.com/pifydev/cli) or `pi install npm:@pify/subagent`.

## What it does

- **`agent_run`** — delegate a task to a child pi session (in-process, isolated in-memory transcript). Foreground blocks and returns the child's report; `background: true` returns an id immediately (up to 4 concurrent) with a live widget showing spinners, token counts, and elapsed time.
- **`agent_result`** — collect a background run's report; completed results survive `/reload`.
- **Three builtin agent types**: `reviewer` (read-only, thinking high — findings with evidence), `scout` (read-only exploration — paths + excerpts), `worker` (full tools — scoped implementation, verifies before finishing).
- **Custom agent types**, Claude Code-compatible: drop `.pi/agents/<name>.md` (project) or `<agentDir>/agents/<name>.md` (global) with frontmatter — `description`, `tools`, `model` (`provider/id`), `thinking`, `max_turns`, and (v0.3) `system_prompt_mode` / `inherit_skills` — and a system-prompt body. Project overrides global overrides builtin; a def without `tools:` defaults to read-only.
- **Guardrails**: tool allowlists are enforced at session creation; children are aborted at their turn cap; children cannot spawn children.
- `/agents` lists types and this session's runs.

## Where this sits in the suite

`@pify/subagent` is deliberately the primitive: one child, one task, one report. Multi-agent coordination belongs to `@pify/swarm`; deterministic scripted orchestration to `@pify/workflow`.

## Custom agent example

```markdown
---
description: Security auditor for diffs
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5-20251001
thinking: low
max_turns: 15
system_prompt_mode: replace
inherit_skills: false
---

You are a security auditor. Scan for hardcoded secrets, injection flaws,
and overly broad permissions. Report file:line with remediation notes.
```

`system_prompt_mode: replace` (default `append`) drops the session's own system prompt, so a specialist is not also told to be this project's coding assistant. `inherit_skills: false` (default `true`) keeps a narrow child out of the project's whole skill surface. Both are unset in the builtins, which behave exactly as before.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
