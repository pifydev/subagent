import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuard } from "../src/loop-guard.ts";

const talk = (text: string) => ({ text, usedTool: false });
const act = (text = "doing work") => ({ text, usedTool: true });

test("three identical tool-free turns is a stall", () => {
  const g = new LoopGuard();
  assert.equal(g.observe(talk("I will now fix the bug.")).stalled, false);
  assert.equal(g.observe(talk("I will now fix the bug.")).stalled, false);
  const v = g.observe(talk("I will now fix the bug."));
  assert.equal(v.stalled, true);
  assert.match(v.reason ?? "", /repeated the same output/);
});

test("cosmetic differences still count as the same turn", () => {
  const g = new LoopGuard();
  g.observe(talk("Let me check the file."));
  g.observe(talk("let me   check the FILE.")); // case + whitespace folded
  assert.equal(g.observe(talk("LET ME CHECK THE FILE.")).stalled, true);
});

test("a tool call is progress and clears the stall history", () => {
  const g = new LoopGuard();
  g.observe(talk("same"));
  g.observe(talk("same"));
  g.observe(act()); // progress
  assert.equal(g.observe(talk("same")).stalled, false, "history was reset by the tool call");
  assert.equal(g.observe(talk("same")).stalled, false);
  assert.equal(g.observe(talk("same")).stalled, true, "three-in-a-row after the reset");
});

test("A-B-A-B oscillation is caught", () => {
  const g = new LoopGuard({ cycle: 3 });
  const seq = ["A", "B", "A", "B", "A", "B"];
  let last;
  for (const s of seq) last = g.observe(talk(s));
  assert.equal(last?.stalled, true);
  assert.match(last?.reason ?? "", /oscillated/);
});

test("genuine progress across different turns never flags", () => {
  const g = new LoopGuard();
  for (const s of ["step one", "step two", "step three", "step four", "step five"]) {
    assert.equal(g.observe(talk(s)).stalled, false, s);
  }
});

test("empty turns are not evidence of a loop", () => {
  const g = new LoopGuard();
  assert.equal(g.observe(talk("")).stalled, false);
  assert.equal(g.observe(talk("   ")).stalled, false);
  assert.equal(g.observe(talk("")).stalled, false);
});

test("repeat threshold is configurable and floored at 2", () => {
  const g = new LoopGuard({ repeat: 2 });
  g.observe(talk("x"));
  assert.equal(g.observe(talk("x")).stalled, true);
  const floored = new LoopGuard({ repeat: 1 });
  floored.observe(talk("y"));
  assert.equal(floored.observe(talk("y")).stalled, true, "floored to 2, so the 2nd trips it");
});
