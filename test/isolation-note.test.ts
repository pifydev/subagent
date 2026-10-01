import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolationPromptNote, repoToplevel } from "../src/isolate.ts";

test("the isolation note names the worktree as the only checkout and the base as off-limits", () => {
  const note = isolationPromptNote("/w/repo/run-1", "/home/me/repo");
  assert.match(note, /^<worktree_isolation>/);
  assert.match(note, /isolated git worktree at \/w\/repo\/run-1/);
  assert.match(note, /base checkout at \/home\/me\/repo is off-limits, even if other instructions name it/);
  assert.ok(!isolationPromptNote("/w", null).includes("off-limits"), "no base, no off-limits clause");
  assert.ok(!isolationPromptNote("/w", "/w").includes("off-limits"), "the worktree itself is never off-limits");
});

test("repoToplevel is the repository root inside one and null outside", () => {
  const dir = mkdtempSync(join(tmpdir(), "pify-iso-note-"));
  try {
    assert.equal(repoToplevel(dir), null);
    execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
    const top = repoToplevel(join(dir));
    assert.ok(top && top.replace(/\\/g, "/").toLowerCase().endsWith(dir.replace(/\\/g, "/").toLowerCase().split("/").pop()!), top ?? "null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
