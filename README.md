# @pify/subagent

Spawn scoped subagents from within a [pi](https://github.com/earendil-works/pi) session. One tool call, one focused child agent — with its own tool allowlist, model, thinking level, and turn cap.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install subagent`](https://github.com/pifydev/cli) or `pi install npm:@pify/subagent`.

## Why

Some work does not belong in the main conversation. Reading forty files to find three call sites, auditing a diff, exploring an unfamiliar package — the *answer* is worth keeping and the search that produced it is not. A child agent does the search in its own transcript and hands back only the report.

The other half is scope. A child with four read-only tools and a fifteen-turn cap cannot wander into refactoring your build config, however plausible that seemed to it at the time.

## Tools

### `agent_run`

| Parameter | Type | Notes |
|---|---|---|
| `agent` | string | Agent type: a builtin, or one of yours |
| `task` | string | A self-contained brief — the child cannot see your conversation |
| `background` | boolean, optional | Return an id immediately instead of blocking; up to 4 concurrent |
| `isolation` | `"worktree"`, optional | Run the child in its own git worktree |

Foreground blocks and returns the child's report. Background returns an id and drives a live widget with spinners, token counts and elapsed time.

### `agent_result`

| Parameter | Type | Notes |
|---|---|---|
| `id` | string | The run to collect |

Completed results survive `/reload`.

## Builtin agent types

| Type | Tools | For |
|---|---|---|
| `reviewer` | read-only, thinking high | Findings with evidence, file:line |
| `scout` | read-only | Exploration — paths and excerpts, breadth over depth |
| `worker` | full | Scoped implementation, verified before it reports |

## Custom agent types

Drop `.pi/agents/<name>.md` (project) or `<agentDir>/agents/<name>.md` (global):

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

Project overrides global overrides builtin. A definition without a `tools:` line defaults to read-only.

`system_prompt_mode: replace` (default `append`) drops the session's own system prompt, so a specialist is not also told to be this project's coding assistant. `inherit_skills: false` (default `true`) keeps a narrow child out of the project's whole skill surface. Both are unset in the builtins, which behave as they always have.

## A repository's agents need your consent

`.pi/agents/*.md` carries a tool allowlist and a system prompt, and a project definition *overrides* a builtin of the same name — so a repository you had just cloned could decide what your `reviewer` is, the first time you ran pi in it.

pi's own project trust turned out to be necessary but not sufficient. pi asks about trust only when the repository ships one of the resources **pi itself** loads — `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`. A repo carrying only `.pi/agents/` triggers no prompt at all, and `isProjectTrusted()` then returns true by default. That is measured, not assumed: a repository whose only pi file was `.pi/agents/reviewer.md` reported `isProjectTrusted=true`, while the same repository with a `.pi/skills` directory reported false.

So a file this extension invented needs a question this extension asks. The first time a project's agent definitions would be loaded, you are asked once and the answer is remembered per project. pi refusing the project is still final — this can only ever be a second gate, never a way around the first — and a headless run with no answer on record refuses, like every other fail-closed path here.

Until they are approved, project definitions are listed as **refused** rather than silently ignored, so a missing agent has a visible reason. Global and builtin definitions are unaffected.

For CI, set `PIFY_TRUST_PROJECT=1`. It is an environment variable rather than a file precisely because the repository being read cannot set it for itself.

## A child can ask instead of guessing

A scoped child that hits a decision it should not be making — an unstated product, API or scope choice, or missing access — calls `ask_supervisor`, and the question reaches **you** through the usual dialog. Only when there is a UI to ask through: a headless run has nobody to answer, so the tool is deliberately not offered there — measured in `test/live/ask-wire.mjs` (the tool absent headless, `agent_run` still present). The offered-when-interactive half needs a TUI, which a scripted `-p` probe cannot see into; it is exercised by using it, not by a test that fakes it.

It reaches you rather than the parent agent for a structural reason: the parent is blocked inside the tool call that spawned the child, so it could not answer anyway. And the decision is yours regardless.

A declined question is not permission to guess. The child is told to finish what the brief authorises and report what it could not decide. Three questions per run, and there is deliberately no progress channel — a child's progress belongs in its report, not in an interruption.

Measured across qwen3-235b, gpt-5.5 and claude-sonnet-4.5: six runs out of six asked rather than inventing an answer.

## `@agent` at the prompt

> `@reviewer` check the diff while `@scout` maps the callers

delegates to both, one `agent_run` each, with no need to describe the roster to the model first. The instruction rides with the turn as a hidden message rather than a system-prompt edit, so the request prefix stays byte-identical and the **prompt cache survives** the turn that is about to fan out. An `@` inside an email address or a path is not a mention.

## A background run comes back to you

A background run used to give the model one way to learn it had finished: call `agent_result` again. "Still running — call agent_result later" is an instruction to spin, and models follow it, burning a turn and a request per check while the thing they are waiting on has not moved.

Two changes close that loop, and only together:

- **The report is delivered.** When a background run finishes it is pushed into the conversation as the agent's next turn, wrapped so it explains why it arrived unasked and what to do if the agent had already moved on. Verified against pi's real provider payloads (`test/live/delivery-wire.mjs`, 3/3): the child finishes while the session lives, and the report reaches the model on its own. One honest caveat the first version of this test taught: the session has to still be alive when the child finishes. A `pi -p` run tears the session down the moment the prompt resolves — cancelling children with it — so the test holds the last turn open to stand in for a real interactive session; delivery is a property of sessions that outlive their children, which interactive ones do and print-mode ones do not.
- **Asking early is answered, not punished.** `agent_result` on a run still in flight returns a normal structured result — not an error, which would invite the model's own retry machinery into a loop over a condition only time resolves. It carries `retryable`, how long it has been going, `pollRequired: false`, and says plainly to get on with something else.

## Behaviour

- **Stopping stops the child.** Pressing Esc, or switching away from the session, aborts the child session rather than leaving it talking to the provider on your money. A run cancelled that way keeps that verdict and says why.
- **Honest endings.** A run stopped at its turn cap comes back marked `[partial: stopped at the N-turn cap]` instead of reading like a finished answer. A child that stopped cleanly and produced no text says exactly that — it used to be recorded as `done` with an empty result, which the report then rendered as *"still running"*, sending the parent to poll a run that had already ended.
- **A broken definition is refused.** A `tools:` line where nothing resolves rejects the definition rather than quietly falling back to read-only: the author asked for a tool set and would otherwise get an agent nobody wrote.
- **Isolated runs clean up after themselves.** With `isolation: "worktree"`, a worktree whose child changed nothing is removed along with its branch — the common case for a review or a search. Anything uncommitted, and any commit the child made, is kept and reported.
- **Guardrails.** Tool allowlists are enforced at session creation, children are aborted at their turn cap, and children cannot spawn children.

## Command

`/agents` — the available agent types and this session's runs.

## Where this sits in the suite

`@pify/subagent` is deliberately the primitive: one child, one task, one report. Many independent items at once belong to [`@pify/swarm`](https://github.com/pifydev/swarm); deterministic scripted orchestration to [`@pify/workflow`](https://github.com/pifydev/workflow). All three read the same agent catalog.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
