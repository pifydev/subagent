import { test } from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_TYPE, deliveryMessage, pendingResult } from "../src/pending.ts";

test("a not-ready answer is a result, and says the wait resolves itself", () => {
  const r = pendingResult({
    id: "reviewer-1",
    kind: "running",
    startedAt: 1000,
    now: 46_000,
    collectWith: "agent_result",
  });
  assert.equal(r.details.retryable, true, "this is a wait, not a failure");
  assert.equal(r.details.status, "running");
  assert.equal(r.details.elapsedMs, 45_000);
  assert.match(r.text, /45s so far/);
  // The whole point: close the polling loop the question came from.
  assert.equal(r.details.pollRequired, false);
  assert.match(r.text, /Do not poll/);
  assert.match(r.text, /delivered to you automatically/);
});

test("queued and running are different facts and read differently", () => {
  const queued = pendingResult({ id: "a", kind: "queued", startedAt: 0, now: 0, collectWith: "agent_result" });
  assert.match(queued.text, /queued behind the concurrency cap/);
  assert.equal(queued.details.status, "queued");

  const running = pendingResult({ id: "a", kind: "running", startedAt: 0, now: 0, collectWith: "agent_result" });
  assert.match(running.text, /still running/);
});

test("elapsed time reads as a person would say it", () => {
  const at = (ms: number) =>
    pendingResult({ id: "a", kind: "running", startedAt: 0, now: ms, collectWith: "x" }).text;
  assert.match(at(300), /just started/);
  assert.match(at(9_000), /9s so far/);
  assert.match(at(125_000), /2m 5s so far/);
  // A clock that went backwards must not produce a negative age.
  const back = pendingResult({ id: "a", kind: "running", startedAt: 5000, now: 0, collectWith: "x" });
  assert.equal(back.details.elapsedMs, 0);
});

test("the tool to collect early is named, but framed as optional", () => {
  const r = pendingResult({ id: "s1", kind: "running", startedAt: 0, now: 0, collectWith: "swarm_status" });
  assert.match(r.text, /swarm_status is only needed if you want it early/);
});

test("a delivered result explains why it arrived unasked", () => {
  const message = deliveryMessage("reviewer-1", "subagent", "  Found two issues in auth.ts  ");
  assert.match(message, /<subagent_result id="reviewer-1">/);
  assert.match(message, /<\/subagent_result>/);
  assert.match(message, /Found two issues in auth\.ts/);
  assert.ok(!message.includes("  Found"), "the body is trimmed, not pasted with its whitespace");
  // Arriving mid-task, it has to say what it is and what to do with it.
  assert.match(message, /you started in the background/);
  assert.match(message, /already moved on/);
});

test("the delivery type is stable, since renderers and tests key on it", () => {
  assert.equal(DELIVERY_TYPE, "pify-background-result");
});
