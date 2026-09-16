/**
 * Which of the child's messages is its report.
 *
 * The obvious answer — the last assistant message — is wrong exactly when it
 * matters. A child stopped at its turn cap, or by Esc while a tool was in
 * flight, ends on a message that holds only the tool call or the thinking
 * that preceded it: no text block at all. Read from that message, the report
 * is empty although the child wrote a full account a turn earlier, and the
 * parent is told the run produced nothing.
 *
 * So the two facts come from two places. The stop reason is the last
 * message's, because that is how the run ended. The text is the last message
 * that actually has any, because that is what the child last said.
 *
 * Pure: a list of message-shaped records in, text and stop reason out.
 */

/** The part of a session message this module reads. */
export interface ReportMessage {
  role?: string;
  stopReason?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}

export interface Report {
  /** The child's last words, trimmed; "" when it never wrote any. */
  text: string;
  /** How the last assistant turn ended, e.g. "stop", "aborted", "error". */
  stopReason: string | undefined;
}

function textOf(message: ReportMessage): string {
  return (message.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

export function extractReport(messages: readonly ReportMessage[]): Report {
  const assistant = [...messages].reverse().filter((m) => m.role === "assistant");
  const last = assistant[0];
  const stopReason = typeof last?.stopReason === "string" ? last.stopReason : undefined;
  for (const message of assistant) {
    const text = textOf(message);
    if (text) return { text, stopReason };
  }
  return { text: "", stopReason };
}

export interface ReportMarks {
  /** Why the loop guard stopped the child, when it did. */
  stallReason: string | null;
  /** The child hit its turn cap and was aborted there. */
  cappedAtTurnLimit: boolean;
  maxTurns: number;
  agent: string;
}

/**
 * The report as the parent should read it. A run stopped at its turn cap is
 * not a finished answer, and returning it unmarked reads as complete to
 * whoever asked for it; a run the loop guard stopped is the same. Null when
 * there is nothing to return — an exit status is not an answer.
 */
export function markReport(text: string, marks: ReportMarks): string | null {
  if (marks.stallReason) {
    return `${text ? `${text}\n\n` : ""}[stopped: no progress — the child ${marks.stallReason}]`;
  }
  if (marks.cappedAtTurnLimit && text) {
    return `${text}\n\n[partial: stopped at the ${marks.maxTurns}-turn cap for agent "${marks.agent}" — this answer may be unfinished]`;
  }
  return text || null;
}
