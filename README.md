# @pify/subagent

[![CI](https://github.com/pifydev/subagent/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/subagent/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/subagent)](https://www.npmjs.com/package/@pify/subagent) [![npm downloads](https://img.shields.io/npm/dm/@pify/subagent)](https://www.npmjs.com/package/@pify/subagent)

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
| `verify` | boolean, optional | After the worker finishes, the reviewer checks it and the worker gets one revision if needed |
| `gate` | string, optional | A command that must pass — `bun test`, `tsc --noEmit` — run in the child's own working directory |
| `gateExpect` | string, optional | Regex the gate output must match, for checks that exit 0 without proving anything |
| `gateRepairs` | number, optional | Repair passes after a failed gate, 0–5 (default 1) |

**Gated runs.** `verify` asks another model whether the work is good. A gate asks the shell. The command runs in the tree the child actually worked in — its worktree under `isolation: "worktree"` — after it finishes and after any revision, so it judges what you would merge. It runs asynchronously: pi is not frozen while a two-minute suite runs, other children's streams keep flowing, and Esc still lands. A gate that reaches its deadline is killed as a whole process tree — the shell *and* the runner it started — and reported as `timeout`.

What the gate found is reported as its own fact, and it can say more than pass/fail:

| Verdict | Meaning |
|---|---|
| `success` | exited 0, and matched `gateExpect` if you gave one |
| `failure` | exited nonzero, or matched a failure pattern |
| `result_missing` | exited 0 but never showed the evidence — *a test runner that matched no tests, a `\|\| true` left behind* |
| `timeout` | given its deadline and did not clear it |
| `no_attestation` | never ran at all — a missing runner, a typo, a broken pattern |

A failing gate sends the child back once with the command, the verdict and the output, then re-runs the gate; `gateRepairs: 0` turns that off. A read-only agent is never asked to repair, and a `no_attestation` verdict never triggers one — a gate that proved nothing is a bug in the gate, and sending an agent to "fix" it is how working code gets broken. A child that ended its report with `OUTCOME: blocked` is not sent back either: it has already said the fix is not in its hands, and the test output will not change that. The gate still runs once, so the record says what the tree proves. If other runs were changing the same directory while the gate ran, the report says so: that verdict is true of the tree, not of this agent's work alone — and only runs actually in that directory count, so an isolated run's worktree is never blamed on a sibling working in the main checkout.

**Outcomes.** A run now reports two facts instead of one. The status says whether the *session* finished; the outcome says whether the *task* did.

```
[worker · worker-1 · done · 14 turns]
Added the retry and the regression test.

[gate] failure — gate exited 1 (`bun test`)
  1 fail: retries the wrong error class
[outcome] failed — a gate ran and failed
```

A gate that failed outranks a child that claims success. Without a gate the outcome is the agent's own account, and a child that could not finish can say so in one parseable place by ending its report with `OUTCOME: blocked` or `OUTCOME: failed`. The widget follows the outcome too — a run that completed and failed its gate is a red ✗, not a green ✓.

**Verified runs.** With `verify: true`, a finished result is handed to the `reviewer` agent, which judges it against the task and either passes it or lists the changes it needs; on changes, the worker gets **one** revision pass (in the same worktree if isolated) and the corrected result comes back with a note. It is bounded to a single round so it can never ping-pong, and best-effort — a reviewer that can't run returns the result marked unverified rather than failing the whole thing. This is `ask_supervisor`'s opposite number: escalate a decision to the human, or have a peer check the work.

Foreground blocks and returns the child's report. Background returns an id and drives a live widget with spinners, token counts and elapsed time.

**Verifying is a state.** Between the child finishing and its verify or gate settling, the run is not done yet — the reviewer may send it back, the gate may contradict it, a repair pass may replace its report. During that window the widget shows it as `⟳ … verifying` with the clock still running, `agent_result` answers "not ready" rather than handing out a result that is about to change, and a background run is only delivered once everything has settled.

### `agent_result`

| Parameter | Type | Notes |
|---|---|---|
| `id` | string | The run to collect |
| `wait` | number, optional | Seconds to block for the run to finish before answering, 0–120 (default 0) |

Completed results survive `/reload` — and they are written to the session only once the run has fully settled, so a restored run carries its gate verdict and its outcome, not the clean success it looked like before the gate ran. Failing gate output is kept to its last 4000 characters in the session file.

`wait` exists for headless runs. Interactively, a finished background run is delivered on its own and there is nothing to poll for; under `pi -p` the session ends with the turn, so the only way to collect was to call again — a tight loop. `wait: 30` turns that into one call that returns when the run lands, or after thirty seconds with the not-ready answer. Esc ends the wait early.

### `agent_steer`

| Parameter | Type | Notes |
|---|---|---|
| `id` | string | A running background run |
| `message` | string | The instruction to inject |

Redirect a background child while it runs — add a constraint, correct course, or narrow scope — and it picks the message up at its next step without restarting. A background run is a teammate you can talk to, not a fire-and-forget. Only works while the run is live; a finished one is collected with `agent_result`.

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
- **A failure interrupts; a success waits its turn.** A finished run arrives as a follow-up, politely queued behind the current turn. A *failed* one arrives as a steer — it interrupts now — because a broken intermediate the agent is likely building on should be seen before it goes further, not after.
- **A failure says which kind it is.** A run that died before its first turn is reported as a configuration error (model, agent file, auth, tool set) that will fail the same way on a retry — fix it, don't re-run; a run that failed partway says so and suggests narrowing the task instead.
- **Asking early is answered, not punished.** `agent_result` on a run still in flight returns a normal structured result — not an error, which would invite the model's own retry machinery into a loop over a condition only time resolves. It carries `retryable` and how long it has been going. In an interactive session, where delivery works, it also carries `pollRequired: false` and says plainly to get on with something else. In a headless `pi -p` run, where nothing is delivered after the turn ends, it flips to `pollRequired: true` and tells the model to call `agent_result` again within the same turn — because the promise "it will arrive on its own" is one that mode cannot keep.

## Behaviour

- **Stopping stops the child — and its helpers.** Pressing Esc, or switching away from the session, aborts the child session rather than leaving it talking to the provider on your money. The reviewer, revision and repair children that `verify` and `gate` spawn are owned by the run that asked for them, so a stop during a repair pass reaches the repair too, and no further helper is started for a run that has been stopped. A run cancelled that way keeps that verdict and says why.
- **Honest endings.** A run stopped at its turn cap comes back marked `[partial: stopped at the N-turn cap]` instead of reading like a finished answer, and it keeps the text the child wrote — the last message after a cap or an Esc mid-tool is usually just the tool call, so the report is taken from the last message that actually said something. A child that stopped cleanly and produced no text says exactly that — it used to be recorded as `done` with an empty result, which the report then rendered as *"still running"*, sending the parent to poll a run that had already ended.
- **A broken definition is refused.** A `tools:` line where nothing resolves rejects the definition rather than quietly falling back to read-only: the author asked for a tool set and would otherwise get an agent nobody wrote.
- **Isolated runs clean up after themselves.** With `isolation: "worktree"`, a worktree whose child changed nothing is removed along with its branch — the common case for a review or a search. Anything uncommitted, and any commit the child made, is kept and reported.
- **Concurrent background writers share your checkout.** Without `isolation: "worktree"`, a background run works directly in the session's directory — and up to four run at once. Two that edit the same file will clobber each other, the same shared-tree hazard [`@pify/swarm`](https://github.com/pifydev/swarm) and [`@pify/workflow`](https://github.com/pifydev/workflow) warn about. Background read-only work (review, search) is safe to fan out; give any run that writes its own `isolation: "worktree"`, or keep writers foreground so they take turns.
- **Guardrails.** Tool allowlists are enforced at session creation, children are aborted at their turn cap, and children cannot spawn children — a child session loads no extensions, so the orchestration tools are never registered inside it.

## Command

`/agents` — the available agent types and this session's runs.

## Where this sits in the suite

`@pify/subagent` is deliberately the primitive: one child, one task, one report. Many independent items at once belong to [`@pify/swarm`](https://github.com/pifydev/swarm); deterministic scripted orchestration to [`@pify/workflow`](https://github.com/pifydev/workflow). All three read the same agent catalog.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
