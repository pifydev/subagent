import { test } from "node:test";
import assert from "node:assert/strict";
import { GRACE_TURNS, WRAP_UP_MIN_TURNS, shouldAbort, shouldWrapUp, wrapUpNotice } from "../src/wrap-up.ts";

test("the wrap-up goes out exactly once, one turn before the cap, and only when the cap leaves room", () => {
  assert.equal(shouldWrapUp(29, 30, false), true);
  assert.equal(shouldWrapUp(29, 30, true), false, "never twice");
  assert.equal(shouldWrapUp(28, 30, false), false, "not earlier");
  assert.equal(shouldWrapUp(30, 30, false), false, "not at the cap itself");
  assert.equal(shouldWrapUp(2, 3, false), false, `a cap under ${WRAP_UP_MIN_TURNS} is too short to warn`);
  assert.equal(shouldWrapUp(3, 4, false), true);
});

test("the notice names the budget, the grace, and asks for the report now", () => {
  const text = wrapUpNotice(30);
  assert.match(text, /used 29 of 30/);
  assert.match(text, new RegExp(`at most ${GRACE_TURNS} turns after the cap`));
  assert.match(text, /final report/i);
});

test("the hard stop waits for the grace window after the cap", () => {
  assert.equal(shouldAbort(30, 30), false, "at the cap the child still has its grace");
  assert.equal(shouldAbort(30 + GRACE_TURNS - 1, 30), false);
  assert.equal(shouldAbort(30 + GRACE_TURNS, 30), true);
  assert.equal(shouldAbort(5, 3, 0), true, "no grace means the old behaviour");
});
