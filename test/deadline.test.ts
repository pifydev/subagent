import { test } from "node:test";
import assert from "node:assert/strict";
import { outlasts, settleWithin } from "../src/deadline.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("outlasts is false when the work settles first, true when the clock wins", async () => {
  assert.equal(await outlasts(sleep(10), 500), false);
  assert.equal(await outlasts(sleep(500), 10), true);
});

test("outlasts propagates a rejection of the work", async () => {
  await assert.rejects(() => outlasts(Promise.reject(new Error("boom")), 500), /boom/);
});

test("settleWithin returns when the work settles, or at the deadline, and never throws", async () => {
  const t0 = Date.now();
  await settleWithin(Promise.reject(new Error("ignored")), 500);
  await settleWithin(sleep(1_000), 20);
  assert.ok(Date.now() - t0 < 900, "did not wait for the slow work");
});
