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

/** Where isolation worktrees live by default: ~/.worktrees. */
export function defaultWorktreeRoot(): string {
  return join(homedir(), ".worktrees");
}

export function createIsolationWorktree(cwd: string, rawSlug: string, root: string = defaultWorktreeRoot()): Isolation {
  let toplevel: string;
  try {
    toplevel = git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error("Worktree isolation requires a git repository.");
  }
  const repo = basename(toplevel);
  const slug = sanitizeSlug(rawSlug);

  let branch = `agent/${slug}`;
  let path = join(root, repo, slug);
  let counter = 2;
  while (existsSync(path) || branchExists(cwd, branch)) {
    branch = `agent/${slug}-${counter}`;
    path = join(root, repo, `${slug}-${counter}`);
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

/**
 * Note appended to a child's report when it ran isolated and left work
 * behind. That work is UNCOMMITTED unless the child chose to commit — the
 * builtin worker never does — and @pify/worktree's worktree_merge refuses a
 * dirty tree, so the old note ("merge with worktree_merge") sent the model to
 * a tool that would turn it away. Say what state the tree is in and what to
 * do about it.
 */
export function isolationNote(isolation: Isolation): string {
  const at = `git -C "${isolation.path}"`;
  return [
    `Ran isolated in worktree ${isolation.path} (branch ${isolation.branch}); the main checkout is untouched.`,
    `Its changes are in that worktree, uncommitted unless the child committed them. To bring them back:`,
    `  review:  ${at} status && ${at} diff`,
    `  commit:  ${at} add -A && ${at} commit -m "<what changed>"`,
    `  merge:   @pify/worktree's worktree_merge branch="${isolation.branch}" (refuses an uncommitted tree)`,
    `or discard it: git worktree remove --force "${isolation.path}".`,
  ].join("\n");
}

/** Note when an isolated run changed nothing and its worktree was removed. */
export const CLEAN_WORKTREE_NOTE =
  "Ran isolated in a temporary worktree; it changed nothing, so the worktree was removed.";

/**
 * The fields the isolation epilogue writes onto a call record. Kept structural
 * so isolate.ts stays free of any dependency on the extension's types — the
 * run's AgentCallState satisfies it by shape.
 */
export interface IsolationSink {
  worktree?: string;
  branch?: string;
}

/**
 * Close out an isolated child's worktree exactly once, whatever its outcome.
 *
 * This is the epilogue EVERY terminal path of a child call must reach —
 * success, schema mismatch, gate failure, abort, or a thrown error. Before,
 * only the prose success path ran it, so a `schema:` step (or any failure or
 * abort) left its worktree and branch behind forever. It runs
 * removeIfUnchanged — a read-only step's worktree is deleted, a step that did
 * work is kept — and when the worktree is kept it records where the edits live
 * on the call so a non-prose result (a schema object, a null from an error)
 * can still name the location instead of orphaning it.
 *
 * Returns the human note for callers that render prose; callers on non-prose
 * paths rely on the pointer written to `sink`. Never throws (removeIfUnchanged
 * already swallows its own failures): the cleanup must not sink a run.
 */
export function settleWorktree(
  cwd: string,
  isolation: Isolation,
  sink: IsolationSink,
): { removed: boolean; note: string } {
  const removed = removeIfUnchanged(cwd, isolation);
  if (removed) return { removed: true, note: CLEAN_WORKTREE_NOTE };
  // Kept: there is work to merge. Record the pointer so the location survives
  // on the call record even when the returned value is data or null.
  sink.worktree = isolation.path;
  sink.branch = isolation.branch;
  return { removed: false, note: isolationNote(isolation) };
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
