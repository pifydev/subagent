import { test } from "node:test";
import assert from "node:assert/strict";
import { isVirtualSelection, latestPhysicalResponse, resolveChildModel } from "../src/child-model.ts";

const physical = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5" };
const virtual = { api: "pi-virtual", provider: "router", id: "auto" };
const registry = new Map([["anthropic/claude-sonnet-5", physical], ["openai/gpt-6", { api: "openai-responses", provider: "openai", id: "gpt-6" }]]);
const find = (p: string, i: string) => registry.get(`${p}/${i}`);
const reply = (provider: string, model: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: { role: "assistant", provider, model, api: "x", stopReason: "stop", content: [], ...extra },
});

test("a physical selection passes through untouched", () => {
  assert.deepEqual(resolveChildModel(physical, [], find), { ok: true, model: physical });
  assert.equal(isVirtualSelection(physical), false);
  assert.equal(isVirtualSelection(virtual), true);
});

test("a virtual selection becomes the physical model of the latest successful response", () => {
  const entries = [reply("openai", "gpt-6"), { type: "message", message: { role: "user", content: "hi" } }, reply("anthropic", "claude-sonnet-5")];
  const r = resolveChildModel(virtual, entries, find);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.model, physical);
    assert.equal(r.routedFrom, "router/auto");
  }
});

test("errored, aborted and unrouted responses are skipped; no response means a clear refusal", () => {
  const entries = [
    reply("anthropic", "claude-sonnet-5"),
    reply("openai", "gpt-6", { stopReason: "error" }),
    reply("openai", "gpt-6", { stopReason: "aborted" }),
    reply("router", "auto", { api: "pi-virtual" }),
  ];
  assert.deepEqual(latestPhysicalResponse(entries), { provider: "anthropic", model: "claude-sonnet-5" });
  const none = resolveChildModel(virtual, [], find);
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.reason, /virtual model.*send one message first/);
  const gone = resolveChildModel(virtual, [reply("acme", "retired")], find);
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.match(gone.reason, /not in the registry/);
  assert.deepEqual(resolveChildModel(null, [], find), { ok: false, reason: "No model available" });
});
