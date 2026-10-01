import { test } from "node:test";
import assert from "node:assert/strict";
import { childTokens } from "../src/tokens.ts";

test("childTokens leaves the cached prefix out, so a long child is not charged its prompt once per turn", () => {
  // Turn 2 of a child whose 20k system prompt is cached: pi's totalTokens is 20k+ the real work.
  const turn = { input: 300, output: 450, cacheRead: 20_000, cacheWrite: 0, totalTokens: 20_750 };
  assert.equal(childTokens(turn), 750);
  // A cache write is new work the provider did for this child; it counts once.
  assert.equal(childTokens({ input: 100, output: 50, cacheRead: 0, cacheWrite: 1_200, totalTokens: 1_350 }), 1_350);
  // Negative/NaN parts are ignored; absent usage is zero.
  assert.equal(childTokens({ input: -5, output: Number.NaN, cacheWrite: 10 }), 10);
  assert.equal(childTokens(undefined), 0);
  // A provider that reports only a total still counts something rather than nothing.
  assert.equal(childTokens({ totalTokens: 900 }), 900);
});
