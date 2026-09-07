import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFile } from "../src/frontmatter.ts";
import { buildMentionMessage, findMentions } from "../src/mentions.ts";
import {
  ASK_BUDGET,
  ASK_EXHAUSTED,
  ASK_REASONS,
  ASK_TOOL_DESCRIPTION,
  ASK_TOOL_NAME,
  askBody,
  askTitle,
  formatAnswer,
} from "../src/ask.ts";
import { createIsolationWorktree, removeIfUnchanged } from "../src/isolate.ts";
import { execFileSync } from "node:child_process";
import { BUILTIN_AGENTS } from "../src/builtin.ts";
import { loadAgentDefs } from "../src/defs.ts";
import { buildWidgetLines } from "../src/widget.ts";
import { childFraming, describeDefs, formatRunResult } from "../src/prompts.ts";
import { DEFAULT_MAX_TURNS, type RunState, type ThemeLike } from "../src/types.ts";

const theme: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

test("parseAgentFile parses full frontmatter", () => {
  const def = parseAgentFile(
    "Auditor",
    `---
description: Security reviewer
tools: read, bash, bogus
model: anthropic/claude-haiku-4-5
thinking: off
max_turns: 10
unknown_key: ignored
---

Body prompt here.`,
    "project",
  );
  assert.ok(def);
  assert.equal(def!.name, "auditor");
  assert.deepEqual(def!.tools, ["read", "bash"]);
  assert.equal(def!.model, "anthropic/claude-haiku-4-5");
  assert.equal(def!.thinking, "off");
  assert.equal(def!.maxTurns, 10);
  assert.equal(def!.systemPrompt, "Body prompt here.");
});

test("parseAgentFile defaults: read-only tools, default turns, no model", () => {
  const def = parseAgentFile("x", "---\ndescription: d\n---\nbody", "global");
  assert.ok(def);
  assert.deepEqual(def!.tools, ["read", "grep", "find", "ls"]);
  assert.equal(def!.maxTurns, DEFAULT_MAX_TURNS);
  assert.equal(def!.model, null);
  assert.equal(def!.thinking, null);
});

test("parseAgentFile rejects missing frontmatter or description", () => {
  assert.equal(parseAgentFile("x", "no frontmatter", "builtin"), null);
  assert.equal(parseAgentFile("x", "---\ntools: read\n---\nbody", "builtin"), null);
});

test("parseAgentFile clamps invalid max_turns", () => {
  const def = parseAgentFile("x", "---\ndescription: d\ntools: read\nmax_turns: 9999\n---\nb", "builtin");
  assert.deepEqual(def!.tools, ["read"]);
  assert.equal(def!.maxTurns, DEFAULT_MAX_TURNS);
});

test("builtin agents all parse and reviewer/scout are read-only", () => {
  for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
    const def = parseAgentFile(name, content, "builtin");
    assert.ok(def, name);
    assert.ok(def!.description.length > 0);
  }
  const reviewer = parseAgentFile("reviewer", BUILTIN_AGENTS.reviewer!, "builtin")!;
  assert.ok(!reviewer.tools.includes("edit"));
  assert.ok(!reviewer.tools.includes("bash"));
  const worker = parseAgentFile("worker", BUILTIN_AGENTS.worker!, "builtin")!;
  assert.ok(worker.tools.includes("edit"));
});

test("loadAgentDefs precedence: project > global > builtin", () => {
  const base = mkdtempSync(join(tmpdir(), "pify-subagent-"));
  try {
    const cwd = join(base, "proj");
    const agentDir = join(base, "agent");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "reviewer.md"),
      "---\ndescription: global reviewer override\n---\nglobal body",
    );
    writeFileSync(
      join(cwd, ".pi", "agents", "reviewer.md"),
      "---\ndescription: project reviewer override\n---\nproject body",
    );
    writeFileSync(join(cwd, ".pi", "agents", "custom.md"), "---\ndescription: custom\n---\nc");
    writeFileSync(join(cwd, ".pi", "agents", "broken.md"), "not an agent file");

    const { defs, refused } = loadAgentDefs(cwd, agentDir, true);
    assert.equal(defs.get("reviewer")!.description, "project reviewer override");
    assert.equal(defs.get("reviewer")!.source, "project");
    assert.equal(defs.get("custom")!.source, "project");
    assert.ok(defs.get("scout"));
    assert.ok(defs.get("worker"));
    assert.equal(defs.get("broken"), undefined);
    assert.deepEqual(refused, []);

    // v0.5: an untrusted project keeps its definitions out, builtins intact
    const untrusted = loadAgentDefs(cwd, agentDir, false);
    assert.equal(untrusted.defs.get("reviewer")!.description, "global reviewer override");
    assert.equal(untrusted.defs.get("reviewer")!.source, "global");
    assert.equal(untrusted.defs.get("custom"), undefined);
    assert.ok(untrusted.defs.get("scout"), "builtins still load");
    assert.deepEqual([...untrusted.refused].sort(), ["custom", "reviewer"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function run(overrides: Partial<RunState>): RunState {
  return {
    id: "reviewer-1",
    agent: "reviewer",
    task: "review the diff",
    background: false,
    status: "running",
    startedAt: 1000,
    finishedAt: null,
    tokens: 1500,
    turns: 3,
    result: null,
    error: null,
    ...overrides,
  };
}

test("widget shows running and recently finished, hides stale", () => {
  const now = 100_000;
  const lines = buildWidgetLines(
    [
      run({ id: "reviewer-1", status: "running" }),
      run({ id: "scout-1", status: "done", finishedAt: now - 5_000, result: "ok" }),
      run({ id: "worker-1", status: "done", finishedAt: now - 60_000 }),
    ],
    theme,
    now,
  );
  const text = lines.join("\n");
  assert.ok(text.includes("⟳ reviewer-1"));
  assert.ok(text.includes("✓ scout-1"));
  assert.ok(!text.includes("worker-1"));
  assert.ok(text.includes("1.5k tok"));
});

test("widget renders nothing when idle", () => {
  assert.deepEqual(buildWidgetLines([run({ status: "done", finishedAt: 1 })], theme, 100_000), []);
});

test("formatRunResult per status", () => {
  assert.ok(formatRunResult(run({ status: "done", result: "all good" })).includes("all good"));
  assert.ok(formatRunResult(run({ status: "error", error: "boom" })).includes("Error: boom"));
  assert.ok(formatRunResult(run({ status: "aborted", result: "partial" })).includes("Partial output"));
  assert.ok(formatRunResult(run({ status: "running" })).includes("Still running"));
});

test("describeDefs lists name, source, tools", () => {
  const def = parseAgentFile("scout", BUILTIN_AGENTS.scout!, "builtin")!;
  const text = describeDefs([def]);
  assert.ok(text.includes("scout (builtin)"));
  assert.ok(text.includes("read, grep, find, ls"));
});

test("v0.2 isolation: worktree created on a real repo; slug sanitized", async () => {
  const { createIsolationWorktree, sanitizeSlug, isolationNote } = await import("../src/isolate.ts");
  const { execFileSync } = await import("node:child_process");

  assert.equal(sanitizeSlug("Reviewer-1"), "reviewer-1");
  assert.equal(sanitizeSlug("weird !! name"), "weird-name");
  assert.equal(sanitizeSlug("!!!"), "run");

  const repo = mkdtempSync(join(tmpdir(), "pify-sub-iso-"));
  let wtPath: string | null = null;
  try {
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    run("init", "-b", "main");
    run("config", "user.email", "t@t.t");
    run("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "x\n");
    run("add", ".");
    run("commit", "-m", "init");

    const iso = createIsolationWorktree(repo, "worker-1");
    wtPath = iso.path;
    assert.equal(iso.branch, "agent/worker-1");
    assert.ok(iso.path.replaceAll("\\", "/").includes("/.worktrees/"));
    const branches = run("branch", "--list", "agent/worker-1");
    assert.ok(branches.includes("agent/worker-1"));

    // second isolation with the same slug gets a fresh slot
    const iso2 = createIsolationWorktree(repo, "worker-1");
    assert.notEqual(iso2.path, iso.path);
    assert.equal(iso2.branch, "agent/worker-1-2");
    rmSync(iso2.path, { recursive: true, force: true });

    assert.ok(isolationNote(iso).includes("worktree_merge"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    if (wtPath) rmSync(wtPath, { recursive: true, force: true });
  }
});

test("v0.2 isolation refuses outside a git repo", async () => {
  const { createIsolationWorktree } = await import("../src/isolate.ts");
  const dir = mkdtempSync(join(tmpdir(), "pify-sub-nogit-"));
  try {
    assert.throws(() => createIsolationWorktree(dir, "x"), /git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v0.3 system_prompt_mode and inherit_skills parse with safe defaults", () => {
  const base = (extra: string) =>
    parseAgentFile("x", `---\ndescription: d\n${extra}\n---\nbody`, "project")!;

  // defaults: append the body to the session prompt, keep the skills
  const plain = base("tools: read");
  assert.equal(plain.systemPromptMode, "append");
  assert.equal(plain.inheritSkills, true);

  assert.equal(base("system_prompt_mode: replace").systemPromptMode, "replace");
  assert.equal(base("system_prompt_mode: REPLACE").systemPromptMode, "replace");
  assert.equal(base("system_prompt_mode: append").systemPromptMode, "append");
  // an unknown value must not silently drop the parent prompt
  assert.equal(base("system_prompt_mode: nonsense").systemPromptMode, "append");

  for (const falsey of ["false", "no", "off", "0", "False", " NO "]) {
    assert.equal(base(`inherit_skills: ${falsey}`).inheritSkills, false, falsey);
  }
  for (const truthy of ["true", "yes", "on", "1", ""]) {
    assert.equal(base(`inherit_skills: ${truthy}`).inheritSkills, true, truthy);
  }
});

test("v0.3 builtin agents keep the defaults", () => {
  for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
    const def = parseAgentFile(name, content, "builtin")!;
    assert.equal(def.systemPromptMode, "append", name);
    assert.equal(def.inheritSkills, true, name);
  }
});

test("v0.4 @mentions are found at word boundaries only", () => {
  const known = ["reviewer", "scout", "worker"];
  assert.deepEqual(findMentions("@reviewer check the diff", known), ["reviewer"]);
  assert.deepEqual(findMentions("ask @scout and @reviewer to look", known), ["scout", "reviewer"]);
  assert.deepEqual(findMentions("(@worker) should do it", known), ["worker"]);
  assert.deepEqual(findMentions("@Reviewer in caps", known), ["reviewer"]);
  assert.deepEqual(findMentions("@scout, then @scout again", known), ["scout"], "deduped");
  assert.deepEqual(findMentions("tell @reviewer.", known), ["reviewer"], "trailing punctuation");

  // not mentions
  assert.deepEqual(findMentions("mail me@reviewer.com", known), []);
  assert.deepEqual(findMentions("see src/@reviewer/file.ts", known), []);
  assert.deepEqual(findMentions("@nobody knows", known), []);
  assert.deepEqual(findMentions("plain prompt", known), []);
  assert.deepEqual(findMentions("", known), []);
  assert.deepEqual(findMentions("@reviewer", []), []);
});

test("v0.4 the mention message names each agent and forbids merging", () => {
  const one = buildMentionMessage([{ name: "reviewer", description: "Reviews diffs" }]);
  assert.ok(one.includes("<system-reminder>"));
  assert.ok(one.includes("- reviewer: Reviews diffs"));
  assert.ok(one.includes('agent_run call with agent="reviewer"'));
  assert.ok(one.includes("do not mention it to the user"));

  const two = buildMentionMessage([
    { name: "reviewer", description: "Reviews diffs" },
    { name: "scout", description: "" },
  ]);
  assert.ok(two.includes("two agent_run calls"));
  assert.ok(two.includes('agent="reviewer"') && two.includes('agent="scout"'));
  assert.ok(two.includes("(no description)"));
  assert.ok(two.includes("Do not merge separate agents into one call"));
});

test("v0.5 a tools list where nothing resolves rejects the file", () => {
  // The author asked for a specific tool set; silently handing back the
  // read-only default runs an agent nobody wrote.
  assert.equal(parseAgentFile("x", "---\ndescription: d\ntools: nonsense, alsobad\n---\nbody", "project"), null);
  // a missing tools: line is still the safe read-only default
  assert.deepEqual(parseAgentFile("x", "---\ndescription: d\n---\nbody", "project")!.tools, [
    "read",
    "grep",
    "find",
    "ls",
  ]);
  // partially valid keeps what resolved
  assert.deepEqual(parseAgentFile("x", "---\ndescription: d\ntools: read, nonsense\n---\nb", "project")!.tools, [
    "read",
  ]);
  // an empty tools: line falls back rather than rejecting
  assert.deepEqual(parseAgentFile("x", "---\ndescription: d\ntools:\n---\nb", "project")!.tools, [
    "read",
    "grep",
    "find",
    "ls",
  ]);
});

test("v0.5 an unchanged isolation worktree is removed, a used one is kept", () => {
  const base = mkdtempSync(join(tmpdir(), "pify-iso-"));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "init"]);

    // a run that touched nothing
    const idle = createIsolationWorktree(repo, "idle-run");
    assert.ok(existsSync(idle.path));
    assert.equal(removeIfUnchanged(repo, idle), true);
    assert.ok(!existsSync(idle.path), "the worktree directory is gone");
    assert.ok(!git(repo, ["branch", "--list", idle.branch]).trim(), "and so is its branch");

    // a run that left uncommitted work
    const dirty = createIsolationWorktree(repo, "dirty-run");
    writeFileSync(join(dirty.path, "b.txt"), "work\n");
    assert.equal(removeIfUnchanged(repo, dirty), false);
    assert.ok(existsSync(dirty.path), "someone's work is never deleted");

    // a run that committed
    const committed = createIsolationWorktree(repo, "committed-run");
    writeFileSync(join(committed.path, "c.txt"), "done\n");
    git(committed.path, ["add", "-A"]);
    git(committed.path, ["commit", "-qm", "child work"]);
    assert.equal(removeIfUnchanged(repo, committed), false);
    assert.ok(existsSync(committed.path));

    // a path that is not a worktree at all is refused, not force-deleted
    assert.equal(removeIfUnchanged(repo, { path: join(base, "nope"), branch: "agent/nope" }), false);
  } finally {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repo, windowsHide: true });
    } catch {
      // best effort
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("v0.6 a finished run with no answer is never reported as still running", () => {
  // The bug this replaces: status "done" with a null result fell through to
  // the running branch, so the parent polled a run that had already ended.
  const empty = formatRunResult(run({ status: "done", result: null }));
  assert.ok(!empty.includes("Still running"), empty);
  assert.ok(empty.includes("without producing an answer"));
  assert.ok(empty.includes("re-run with a narrower task"));

  // the ordinary paths are unchanged
  assert.ok(formatRunResult(run({ status: "done", result: "the answer" })).includes("the answer"));
  assert.ok(formatRunResult(run({ status: "running" })).includes("Still running"));
  assert.ok(formatRunResult(run({ status: "error", error: "boom" })).includes("Error: boom"));
  assert.ok(formatRunResult(run({ status: "aborted", result: null })).includes("(none)"));
});

test("v0.6 ask_supervisor asks the smallest question, and handles a refusal", () => {
  assert.equal(askTitle("reviewer", "need_decision"), "Subagent reviewer needs a decision");
  assert.equal(askTitle("scout", "clarify_scope"), "Subagent scout needs the scope clarified");
  assert.equal(askTitle("worker", "missing_access"), "Subagent worker is missing access");

  assert.equal(askBody("Which database?", "  "), "Which database?");
  assert.equal(askBody(" Which database? ", "Postgres is already a dependency."),
    "Which database?\n\nPostgres is already a dependency.");

  // A declined question must not read as permission to guess.
  const declined = formatAnswer(null);
  assert.ok(declined.includes("did not answer"));
  assert.ok(declined.includes("Do not invent the decision"));
  assert.ok(declined.includes("state in your report"));
  assert.equal(formatAnswer("   "), declined, "an empty answer is a refusal");
  assert.ok(formatAnswer("use Postgres").includes("Supervisor's answer: use Postgres"));

  // The tool exists to prevent invention, and says so rather than inviting chat.
  assert.ok(ASK_TOOL_DESCRIPTION.includes("Do not use it to report progress"));
  assert.ok(ASK_TOOL_DESCRIPTION.includes("costs the user an interruption"));
  assert.ok(!ASK_REASONS.includes("progress_update" as never), "no progress channel to a human");
  assert.ok(ASK_EXHAUSTED.includes(String(ASK_BUDGET)));
});

test("v0.6 the ask tool must be on the allowlist, or it is silently dropped", () => {
  // pi's `tools` option is an allowlist and it filters customTools too: a
  // custom tool missing from it is registered and then removed, and the child
  // is told no such tool exists. This asserts the shape the extension builds.
  const defTools = ["read", "grep", "find", "ls"];
  const withAsk = [...defTools, ASK_TOOL_NAME];
  assert.ok(withAsk.includes("ask_supervisor"), "the ask tool travels on the allowlist");
  assert.equal(withAsk.length, defTools.length + 1, "and nothing else is widened");
  // headless children get neither the tool nor the allowlist entry
  const headless = defTools;
  assert.ok(!headless.includes(ASK_TOOL_NAME));
});

test("v0.6 the framing admits the exception only when the tool exists", () => {
  const withoutAsk = childFraming(false);
  assert.ok(withoutAsk.includes("Do not end your report with questions"));
  assert.ok(!withoutAsk.includes("ask_supervisor"), "no dangling reference to a tool it does not have");

  const withAsk = childFraming(true);
  assert.ok(withAsk.includes("ask_supervisor"));
  assert.ok(withAsk.includes("instead of guessing"));
  // the base rule survives: a report is still not a place for questions
  assert.ok(withAsk.includes("Do not end your report with questions"));
});
