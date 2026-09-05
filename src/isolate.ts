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
