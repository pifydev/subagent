import { clampRows, clampWidth, MAX_WIDGET_ROWS } from "./widget-clamp.ts";
import type { RunState, ThemeLike } from "./types.ts";

const WIDTH = 54;

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function elapsed(run: RunState, now: number): string {
  // A settling run's child has finished, but the run has not: its clock keeps
  // going through the verify/gate that is still deciding what it came to.
  const end = run.settling ? now : (run.finishedAt ?? now);
  const s = Math.max(0, Math.round((end - run.startedAt) / 1000));
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** A run the widget should show: live, settling, or finished within the window. */
export function isVisible(run: RunState, now: number): boolean {
  return run.status === "running" || run.settling === true || (run.finishedAt ?? 0) > now - 15_000;
}

/**
 * The row reports the *task*, not the session. A child that ran to the end and
 * failed its gate used to sit in the widget as a green ✓, which is precisely
 * the confusion the outcome field exists to remove — and a run whose gate is
 * still running is not a ✓ either, yet.
 */
function icon(run: RunState): string {
  if (run.settling) return "⟳";
  switch (run.status) {
    case "running":
      return "⟳";
    case "done":
      return run.outcome === "failed" ? "✗" : run.outcome === "blocked" ? "⚠" : "✓";
    case "error":
      return "✗";
    case "aborted":
      return "◼";
  }
}

type Tone = "warning" | "success" | "error";

function tone(run: RunState): Tone {
  if (run.status === "running" || run.settling) return "warning";
  if (run.status !== "done") return "error";
  if (run.outcome === "failed") return "error";
  if (run.outcome === "blocked") return "warning";
  return "success";
}

/**
 * Widget above the editor listing active + recently finished runs.
 * Empty when there is nothing to show.
 */
export function buildWidgetLines(runs: RunState[], theme: ThemeLike, now: number): string[] {
  const visible = runs.filter((r) => isVisible(r, now));
  if (visible.length === 0) return [];

  const dim = (s: string) => theme.fg("dim", s);
  const lines: string[] = [];
  const title = " 🤖 subagents ";
  const hint = " /agents ";
  const pad = Math.max(1, WIDTH - title.length - hint.length);
  lines.push(dim(`╭${title}${"─".repeat(pad)}${hint}╮`));

  const rows = visible.map((run) => {
    const color = tone(run);
    const paint = (s: string) => theme.fg(color, s);
    const head = paint(`${icon(run)} ${clampWidth(run.id, 16)}`);
    const stats = dim(` · ${tokens(run.tokens)} tok · ${elapsed(run, now)}${run.settling ? " · verifying" : ""}`);
    return `${dim("│ ")}${head}${stats} ${dim(clampWidth(run.task, 30))}`;
  });
  for (const row of clampRows(rows, MAX_WIDGET_ROWS, (hidden) => dim(`│ … +${hidden} more`))) {
    lines.push(row);
  }

  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}
