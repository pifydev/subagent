import { test } from "node:test";
import assert from "node:assert/strict";
import { waitUntil } from "../src/wait.ts";

test("waitUntil resolves true as soon as the check passes", async () => {
  let ready = false;
  setTimeout(() => {
    ready = true;
  }, 30);
  const started = Date.now();
  assert.equal(await waitUntil(() => ready, 2000, 5), true);
  assert.ok(Date.now() - started < 1500, "it did not sit out the whole budget");
});

test("waitUntil answers without a timer when the check already passes, and false at the deadline", async () => {
  assert.equal(await waitUntil(() => true, 1000, 5), true);
  assert.equal(await waitUntil(() => false, 0, 5), false, "a zero budget is one check, not a wait");
  const started = Date.now();
  assert.equal(await waitUntil(() => false, 60, 5), false);
  assert.ok(Date.now() - started >= 50, "it waited its budget out");
});

test("waitUntil stops waiting when the tool's signal aborts", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  assert.equal(await waitUntil(() => false, 5000, 5, controller.signal), false);
  assert.ok(Date.now() - started < 1000, "Esc must not be held hostage by the budget");

  // Already aborted: no wait at all.
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await waitUntil(() => false, 5000, 5, aborted.signal), false);
});
