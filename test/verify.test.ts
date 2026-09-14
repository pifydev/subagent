import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, verifyPrompt, revisionPrompt, VERDICT_PASS, VERDICT_CHANGES } from "../src/verify.ts";

test("PASS verdict is parsed as passed with no feedback", () => {
  const v = parseVerdict(`${VERDICT_PASS}\nLooks correct and complete.`);
  assert.equal(v.passed, true);
  assert.equal(v.feedback, "");
});

test("CHANGES verdict is parsed as failed, feedback is the text after it", () => {
  const v = parseVerdict(`${VERDICT_CHANGES}\n1. Off-by-one in the loop.\n2. Missing null check.`);
  assert.equal(v.passed, false);
  assert.match(v.feedback, /Off-by-one/);
  assert.match(v.feedback, /null check/);
  assert.ok(!v.feedback.toUpperCase().includes("VERDICT"), "the verdict line is stripped from feedback");
});

test("an unclear reply defaults to passed — a mangled review never blocks a good result", () => {
  assert.equal(parseVerdict("the work seems fine to me").passed, true);
  assert.equal(parseVerdict("").passed, true);
  assert.equal(parseVerdict("   ").passed, true);
});

test("verdict matching is case-insensitive and tolerant of spacing", () => {
  assert.equal(parseVerdict("verdict:changes\nfix it").passed, false);
  assert.equal(parseVerdict("Verdict:  CHANGES  \nfix").passed, false);
});

test("the verify prompt carries the task and the work, and asks for the tokens", () => {
  const p = verifyPrompt("Build the parser", "Here is the parser…");
  assert.match(p, /Build the parser/);
  assert.match(p, /Here is the parser/);
  assert.ok(p.includes(VERDICT_PASS) && p.includes(VERDICT_CHANGES));
});

test("the revision prompt carries the task and the required changes", () => {
  const p = revisionPrompt("Build the parser", "1. handle empty input");
  assert.match(p, /Build the parser/);
  assert.match(p, /handle empty input/);
});
