import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReport, markReport, type ReportMessage } from "../src/report.ts";

const assistant = (content: ReportMessage["content"], stopReason?: string): ReportMessage => ({
  role: "assistant",
  content,
  ...(stopReason ? { stopReason } : {}),
});

test("a turn-cap abort keeps the text the child wrote a turn earlier", () => {
  // The bug: the report was read from the LAST assistant message, which after
  // a turn-cap abort or an Esc mid-tool is usually text-free (only toolCall or
  // thinking blocks) — the child had written plenty and the parent got "".
  const report = extractReport([
    { role: "user", content: [{ type: "text", text: "do the thing" }] },
    assistant([{ type: "text", text: "Half done: added the parser." }, { type: "toolCall" }], "toolUse"),
    assistant([], "aborted"),
  ]);
  assert.equal(report.text, "Half done: added the parser.");
  assert.equal(report.stopReason, "aborted", "the stop reason is still the last message's");
});

test("the plain case is unchanged: the last message carries the report", () => {
  const report = extractReport([
    assistant([{ type: "text", text: "thinking out loud" }], "toolUse"),
    assistant([{ type: "text", text: "Final report." }], "stop"),
  ]);
  assert.equal(report.text, "Final report.");
  assert.equal(report.stopReason, "stop");
});

test("a message with only thinking blocks is skipped, and no text at all is empty", () => {
  const report = extractReport([
    assistant([{ type: "text", text: "Earlier words." }], "toolUse"),
    assistant([{ type: "thinking", text: "hmm" }], "aborted"),
  ]);
  assert.equal(report.text, "Earlier words.");
  assert.equal(report.stopReason, "aborted");

  const nothing = extractReport([assistant([{ type: "thinking", text: "hmm" }], "stop")]);
  assert.equal(nothing.text, "");
  assert.equal(nothing.stopReason, "stop");

  const empty = extractReport([]);
  assert.equal(empty.text, "");
  assert.equal(empty.stopReason, undefined);
});

test("whitespace-only text blocks do not count as a report", () => {
  const report = extractReport([
    assistant([{ type: "text", text: "Real words." }], "toolUse"),
    assistant([{ type: "text", text: "   \n" }], "aborted"),
  ]);
  assert.equal(report.text, "Real words.");
});

test("the cap and stall markers land on the text that was kept", () => {
  const capped = markReport("Half done.", { stallReason: null, cappedAtTurnLimit: true, maxTurns: 5, agent: "worker" });
  assert.match(capped!, /^Half done\./);
  assert.match(capped!, /partial: stopped at the 5-turn cap for agent "worker"/);

  const stalled = markReport("", { stallReason: "repeated itself", cappedAtTurnLimit: false, maxTurns: 5, agent: "worker" });
  assert.equal(stalled, "[stopped: no progress — the child repeated itself]");
  const stalledWithText = markReport("So far.", { stallReason: "repeated itself", cappedAtTurnLimit: false, maxTurns: 5, agent: "worker" });
  assert.match(stalledWithText!, /^So far\.\n\n\[stopped: no progress/);

  assert.equal(markReport("Done.", { stallReason: null, cappedAtTurnLimit: false, maxTurns: 5, agent: "worker" }), "Done.");
  assert.equal(markReport("", { stallReason: null, cappedAtTurnLimit: false, maxTurns: 5, agent: "worker" }), null);
  // Capped with nothing to show is still nothing: an exit status is not an answer.
  assert.equal(markReport("", { stallReason: null, cappedAtTurnLimit: true, maxTurns: 5, agent: "worker" }), null);
});
