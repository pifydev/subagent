import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFile } from "../src/frontmatter.ts";
import { buildMentionMessage, findMentions } from "../src/mentions.ts";
import { BUILTIN_AGENTS } from "../src/builtin.ts";
import { loadAgentDefs } from "../src/defs.ts";
import { buildWidgetLines } from "../src/widget.ts";
import { describeDefs, formatRunResult } from "../src/prompts.ts";
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

test("parseAgentFile clamps invalid max_turns and all-invalid tools", () => {
  const def = parseAgentFile(
    "x",
    "---\ndescription: d\ntools: nope, nada\nmax_turns: 9999\n---\nb",
    "builtin",
  );
  assert.deepEqual(def!.tools, ["read", "grep", "find", "ls"]);
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

    const defs = loadAgentDefs(cwd, agentDir);
    assert.equal(defs.get("reviewer")!.description, "project reviewer override");
    assert.equal(defs.get("reviewer")!.source, "project");
    assert.equal(defs.get("custom")!.source, "project");
    assert.ok(defs.get("scout"));
    assert.ok(defs.get("worker"));
    assert.equal(defs.get("broken"), undefined);
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
