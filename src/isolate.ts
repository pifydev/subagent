import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Worktree isolation for child agents (v0.2 integration with the suite's
 * worktree conventions): a mutating child gets its own git worktree on an
 * agent/<slug> branch under ~/.worktrees/<repo>/, so parallel edits can
 * never collide with the main checkout. All git calls are execFile argv —
 * no shell, no interpolation. The worktree is NOT auto-removed: the result
 * reports it so the user merges (worktree_merge from @pify/worktree, or
 * plain git) or discards deliberately.
 */

export interface Isolation {
  path: string;
  branch: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function sanitizeSlug(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "run";
}

export function createIsolationWorktree(cwd: string, rawSlug: string): Isolation {
  let toplevel: string;
  try {
    toplevel = git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error("Worktree isolation requires a git repository.");
  }
  const repo = basename(toplevel);
  const slug = sanitizeSlug(rawSlug);

  let branch = `agent/${slug}`;
  let path = join(homedir(), ".worktrees", repo, slug);
  let counter = 2;
  while (existsSync(path) || branchExists(cwd, branch)) {
    branch = `agent/${slug}-${counter}`;
    path = join(homedir(), ".worktrees", repo, `${slug}-${counter}`);
    counter++;
    if (counter > 50) throw new Error("Could not find a free worktree slot.");
  }

  try {
    git(cwd, ["worktree", "add", "-b", branch, path, "HEAD"]);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`git worktree add failed: ${(e.stderr ?? e.message ?? "unknown").toString().trim()}`);
  }
  return { path, branch };
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Note appended to a child's report when it ran isolated. */
export function isolationNote(isolation: Isolation): string {
  return [
    `Ran isolated in worktree ${isolation.path} (branch ${isolation.branch}).`,
    `The main checkout is untouched. Merge with @pify/worktree's worktree_merge branch="${isolation.branch}",`,
    `or inspect: cd "${isolation.path}" && git log --stat`,
  ].join("\n");
}

/**
 * Remove a worktree the child left untouched. An isolated run that changed
 * nothing is the common case — a review, a search, a question — and keeping
 * its worktree means a directory and a branch per run accumulate under
 * ~/.worktrees for as long as the machine runs. A worktree with any change,
 * staged or not, committed or not, is kept: that is someone's work.
 *
 * Returns true when it was removed. Never throws: failing to clean up must
 * not fail the run that already succeeded.
 */
export function removeIfUnchanged(cwd: string, isolation: Isolation): boolean {
  try {
    // Uncommitted work, tracked or not.
    if (git(isolation.path, ["status", "--porcelain"]).trim()) return false;
    // Commits made inside the worktree: the branch moved off the commit it
    // was cut from. (A fresh agent/<slug> branch has no upstream, so asking
    // git for "ahead of upstream" would throw here rather than answer.)
    const head = git(isolation.path, ["rev-parse", "HEAD"]).trim();
    const base = git(cwd, ["rev-parse", "HEAD"]).trim();
    if (!head || head !== base) return false;
  } catch {
    // A worktree we cannot inspect is one we must not delete.
    return false;
  }
  try {
    git(cwd, ["worktree", "remove", "--force", isolation.path]);
    git(cwd, ["branch", "-D", isolation.branch]);
    return true;
  } catch {
    return false;
  }
}
