# @pify/subagent

Spawn scoped subagents from within a [pi](https://github.com/earendil-works/pi) session. One tool call, one focused child agent — with its own tool allowlist, model, thinking level, and turn cap.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install subagent`](https://github.com/pifydev/cli) or `pi install npm:@pify/subagent`.

## What it does

- **`agent_run`** — delegate a task to a child pi session (in-process, isolated in-memory transcript). Foreground blocks and returns the child's report; `background: true` returns an id immediately (up to 4 concurrent) with a live widget showing spinners, token counts, and elapsed time.
- **`agent_result`** — collect a background run's report; completed results survive `/reload`.
- **Three builtin agent types**: `reviewer` (read-only, thinking high — findings with evidence), `scout` (read-only exploration — paths + excerpts), `worker` (full tools — scoped implementation, verifies before finishing).
- **A repository's agents need trust** (v0.5): `.pi/agents/*.md` carries a tool allowlist and a system prompt, and a project definition *overrides* a builtin of the same name — so a repo you just cloned could become your `reviewer` the first time you ran it. Project definitions now load only once pi's project trust is granted; until then they are listed as refused rather than silently ignored. Global and builtin agents are unaffected. (The trust posture is from [`pi-code`](https://github.com/ilovepixelart/pi-code), which treats everything a repository ships as untrusted until approved.)
- **An exit status is not an answer** (v0.6): a child that stopped cleanly and produced no text used to be recorded as `done` with an empty result — which the report then rendered as *"still running"*, sending the parent to poll a run that had already ended. A finished run with nothing in it now says exactly that, and says what to do instead. (The principle is from [`pi-background-tasks`](https://github.com/ismailsaleekh/pi-background-tasks): a task whose result file is absent has no accepted answer even when the child exited 0.)
- **Honest endings** (v0.5): a run stopped at its turn cap comes back marked `[partial: stopped at the N-turn cap]` instead of reading like a finished answer, and a `tools:` line where nothing resolves rejects the definition instead of quietly falling back to read-only — the author asked for a tool set and would otherwise get an agent nobody wrote.
- **Isolated runs clean up after themselves** (v0.5): `isolation: "worktree"` removes the worktree and its branch when the child changed nothing — the common case for a review or a search. Anything uncommitted, or any commit the child made, is kept and reported.
- **`@agent` at the prompt** (v0.4): "`@reviewer` check the diff while `@scout` maps the callers" delegates to both, one `agent_run` each — no describing the roster to the model first. The instruction rides with the turn as a hidden message rather than a system-prompt edit, so the request prefix stays byte-identical and the **prompt cache survives** the turn that is about to fan out. `@` inside an email or a path is not a mention. (Idea from [`pi-cc-extensions`](https://github.com/minuque/pi-cc-extensions); the cache-stable delivery is this suite's rule.)
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
