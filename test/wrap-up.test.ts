import { test } from "node:test";
import assert from "node:assert/strict";
import { WRAP_UP_MIN_TURNS, shouldWrapUp, wrapUpNotice } from "../src/wrap-up.ts";

test("the wrap-up goes out exactly once, one turn before the cap, and only when the cap leaves room", () => {
  assert.equal(shouldWrapUp(29, 30, false), true);
  assert.equal(shouldWrapUp(29, 30, true), false, "never twice");
  assert.equal(shouldWrapUp(28, 30, false), false, "not earlier");
  assert.equal(shouldWrapUp(30, 30, false), false, "not at the cap itself");
  assert.equal(shouldWrapUp(2, 3, false), false, `a cap under ${WRAP_UP_MIN_TURNS} is too short to warn`);
  assert.equal(shouldWrapUp(3, 4, false), true);
});

test("the notice names the budget and asks for the report now", () => {
  const text = wrapUpNotice(30);
  assert.match(text, /used 29 of 30/);
  assert.match(text, /last turn/i);
  assert.match(text, /final report/i);
});
