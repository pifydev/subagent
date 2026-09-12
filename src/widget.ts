import { clampRows, clampWidth, MAX_WIDGET_ROWS } from "./widget-clamp.ts";
import type { RunState, ThemeLike } from "./types.ts";

const WIDTH = 54;

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function elapsed(run: RunState, now: number): string {
  const s = Math.max(0, Math.round(((run.finishedAt ?? now) - run.startedAt) / 1000));
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function icon(status: RunState["status"]): string {
  switch (status) {
    case "running":
      return "⟳";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "aborted":
      return "◼";
  }
}

/**
 * Widget above the editor listing active + recently finished runs.
 * Empty when there is nothing to show.
 */
export function buildWidgetLines(runs: RunState[], theme: ThemeLike, now: number): string[] {
  const visible = runs.filter((r) => r.status === "running" || (r.finishedAt ?? 0) > now - 15_000);
  if (visible.length === 0) return [];

  const dim = (s: string) => theme.fg("dim", s);
  const lines: string[] = [];
  const title = " 🤖 subagents ";
  const hint = " /agents ";
  const pad = Math.max(1, WIDTH - title.length - hint.length);
  lines.push(dim(`╭${title}${"─".repeat(pad)}${hint}╮`));

  const rows = visible.map((run) => {
    const paint =
      run.status === "running"
        ? (s: string) => theme.fg("warning", s)
        : run.status === "done"
          ? (s: string) => theme.fg("success", s)
          : (s: string) => theme.fg("error", s);
    const head = paint(`${icon(run.status)} ${clampWidth(run.id, 16)}`);
    const stats = dim(` · ${tokens(run.tokens)} tok · ${elapsed(run, now)}`);
    return `${dim("│ ")}${head}${stats} ${dim(clampWidth(run.task, 30))}`;
  });
  for (const row of clampRows(rows, MAX_WIDGET_ROWS, (hidden) => dim(`│ … +${hidden} more`))) {
    lines.push(row);
  }

  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}
