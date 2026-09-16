import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveChildren, cancelNote } from "../src/cancel.ts";
import { registerOwned } from "../src/owned.ts";

const child = () => {
  const state = { aborts: 0 };
  return { state, handle: { abort: () => void state.aborts++ } };
};

test("aborting a run stops exactly its own children", () => {
  const live = new LiveChildren();
  const a = child();
  const b = child();
  const other = child();
  live.register("run-1", a.handle);
  live.register("run-1", b.handle);
  live.register("run-2", other.handle);

  assert.equal(live.count("run-1"), 2);
  assert.equal(live.total(), 3);

  assert.equal(live.abortRun("run-1"), 2);
  assert.equal(a.state.aborts, 1);
  assert.equal(b.state.aborts, 1);
  assert.equal(other.state.aborts, 0, "another run's children keep going");
  assert.equal(live.count("run-1"), 0);
  assert.equal(live.total(), 1);
});

test("a child that finished normally is not aborted afterwards", () => {
  const live = new LiveChildren();
  const done = child();
  const release = live.register("run-1", done.handle);
  release();
  assert.equal(live.abortRun("run-1"), 0);
  assert.equal(done.state.aborts, 0);
  // Releasing twice is what a finally block does after an early return.
  release();
  assert.equal(live.total(), 0);
});

test("one child that throws does not spare the others", () => {
  const live = new LiveChildren();
  const ok = child();
  live.register("run-1", {
    abort() {
      throw new Error("already disposed");
    },
  });
  live.register("run-1", ok.handle);
  assert.equal(live.abortRun("run-1"), 2);
  assert.equal(ok.state.aborts, 1);
});

test("a rejected abort promise does not become an unhandled rejection", async () => {
  const live = new LiveChildren();
  live.register("run-1", { abort: () => Promise.reject(new Error("gone")) });
  assert.equal(live.abortRun("run-1"), 1);
  await new Promise((r) => setTimeout(r, 10));
});

test("abortAll clears every run", () => {
  const live = new LiveChildren();
  const a = child();
  const b = child();
  live.register("run-1", a.handle);
  live.register("run-2", b.handle);
  assert.equal(live.abortAll(), 2);
  assert.equal(live.total(), 0);
  assert.equal(live.abortAll(), 0);
});

test("a helper registered under its own id and its owner's stops on either", () => {
  // The bug: verify/gate helpers (reviewer-N, worker-N) were registered under
  // their own fresh ids only, so Esc on the parent never reached them.
  const live = new LiveChildren();
  const helper = child();
  live.register("reviewer-2", helper.handle);
  live.register("worker-1", helper.handle);
  assert.equal(live.count("worker-1"), 1);

  assert.equal(live.abortRun("worker-1"), 1, "aborting the owner reaches the helper");
  assert.equal(helper.state.aborts, 1);

  const direct = child();
  live.register("reviewer-3", direct.handle);
  live.register("worker-1", direct.handle);
  assert.equal(live.abortRun("reviewer-3"), 1, "aborting the helper directly still works");
  assert.equal(direct.state.aborts, 1);
});

test("registerOwned files a child under both ids and one release clears both", () => {
  const live = new LiveChildren();
  const helper = child();
  const release = registerOwned(live, "reviewer-2", "worker-1", helper.handle);
  assert.equal(live.count("reviewer-2"), 1);
  assert.equal(live.count("worker-1"), 1);
  release();
  assert.equal(live.total(), 0, "a helper that finished leaves no trace under either id");
  assert.equal(live.abortRun("worker-1"), 0);
  assert.equal(helper.state.aborts, 0);

  // A top-level run owns itself: one registration, not two.
  const top = child();
  registerOwned(live, "worker-1", "worker-1", top.handle);
  assert.equal(live.count("worker-1"), 1);
  assert.equal(live.total(), 1);
});

test("the note says who stopped it and what it cost", () => {
  assert.match(cancelNote("user-abort", 2), /Cancelled by the user/);
  assert.match(cancelNote("user-abort", 2), /2 child agents stopped/);
  assert.match(cancelNote("user-abort", 1), /1 child agent stopped/);
  assert.match(cancelNote("user-abort", 0), /no child agents were running/);
  // Session teardown is not recoverable, and the note must not imply it is.
  assert.match(cancelNote("session-switch", 1), /not recoverable/);
  assert.match(cancelNote("session-switch", 1), /start a new run/);
});
