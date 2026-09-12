/**
 * Keep a widget from overrunning the screen.
 *
 * pi caps string-array widgets at ten lines, but a Text-factory widget — the
 * pattern every @pify widget uses because it caches and renders efficiently —
 * bypasses that guard entirely (measured in pi's interactive-mode source). So
 * the bound is ours to keep: an unbounded row count pushes the editor off
 * screen, and a single line wider than the terminal can crash the renderer.
 *
 * Two rules, applied before any colour escape is added (slicing a coloured
 * string would cut through an escape sequence):
 *  - `clampWidth` truncates one segment's *visible* text.
 *  - `clampRows` caps the row list and, per the suite's no-silent-caps rule,
 *    replaces the overflow with a visible "+N more" line rather than dropping
 *    it in silence.
 */

/** A widget line's variable segment never exceeds this many characters. */
export const MAX_SEGMENT = 44;
/** A widget never shows more than this many item rows. */
export const MAX_WIDGET_ROWS = 8;

export function clampWidth(text: string, max = MAX_SEGMENT): string {
  const t = text.replace(/[\r\n]+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Return at most `max` rows; when more were supplied, `more(hidden)` renders
 * the summary line that stands in for the rest.
 */
export function clampRows(rows: string[], max: number, more: (hidden: number) => string): string[] {
  if (rows.length <= max) return rows;
  return [...rows.slice(0, max), more(rows.length - max)];
}
