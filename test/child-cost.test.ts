import { test } from "node:test";
import assert from "node:assert/strict";
import { addChildSpend, childSpendTotal, onChildSpend, resetChildSpend } from "../src/child-cost.ts";

test("child spend is tallied per source, summed in the total, and reset on demand", () => {
  resetChildSpend();
  assert.deepEqual(childSpendTotal(), { cost: 0, tokens: 0, sources: [] });
  addChildSpend("subagent", { cost: 0.1, tokens: 1_000 });
  addChildSpend("swarm", { cost: 0.25, tokens: 2_500 });
  addChildSpend("subagent", { cost: 0.05, tokens: 500 });
  const total = childSpendTotal();
  assert.ok(Math.abs(total.cost - 0.4) < 1e-9);
  assert.equal(total.tokens, 4_000);
  assert.deepEqual(total.sources, ["subagent", "swarm"]);
  resetChildSpend();
  assert.deepEqual(childSpendTotal(), { cost: 0, tokens: 0, sources: [] });
});

test("non-finite, negative and empty additions are ignored", () => {
  resetChildSpend();
  addChildSpend("x", { cost: Number.NaN, tokens: -5 });
  addChildSpend("x", {});
  addChildSpend("x", { cost: -1 });
  assert.deepEqual(childSpendTotal(), { cost: 0, tokens: 0, sources: [] });
});

test("listeners hear every addition, a throwing listener does not stop the others, and unsubscribe works", () => {
  resetChildSpend();
  let heard = 0;
  const off = onChildSpend(() => heard++);
  const offBad = onChildSpend(() => {
    throw new Error("footer gone");
  });
  addChildSpend("subagent", { tokens: 10 });
  addChildSpend("subagent", { tokens: 10 });
  assert.equal(heard, 2);
  off();
  offBad();
  addChildSpend("subagent", { tokens: 10 });
  assert.equal(heard, 2);
  resetChildSpend();
});

test("the tally lives on globalThis under a Symbol.for key, so every package's copy shares it", () => {
  resetChildSpend();
  addChildSpend("workflow", { cost: 0.01 });
  const g = globalThis as unknown as Record<symbol, { bySource: Map<string, unknown> }>;
  const shared = g[Symbol.for("pify.child-cost")];
  assert.ok(shared, "state is process-global");
  assert.ok(shared.bySource.has("workflow"));
  resetChildSpend();
});
