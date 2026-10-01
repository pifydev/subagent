import { test } from "node:test";
import assert from "node:assert/strict";
import { findPinnedModel, normalizeModelId } from "../src/model-match.ts";

const models = [
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "anthropic", id: "claude-sonnet-5-20260901" },
  { provider: "openai", id: "gpt-6" },
  { provider: "openai", id: "gpt-6-20260101" },
  { provider: "openai", id: "gpt-6-20260301" },
];
const registry = {
  find: (p: string, i: string) => models.find((m) => m.provider === p && m.id === i),
  getAll: () => models,
};

test("normalizeModelId folds dots and a trailing date stamp", () => {
  assert.equal(normalizeModelId("Claude-Haiku-4.5"), "claude-haiku-4-5");
  assert.equal(normalizeModelId("claude-sonnet-5-20260901"), "claude-sonnet-5");
  assert.equal(normalizeModelId("gpt-6"), "gpt-6");
});

test("an exact pin resolves exactly; a cosmetic variation resolves within the same provider only", () => {
  assert.equal(findPinnedModel(registry, "anthropic/claude-haiku-4-5").model, models[0]);
  const dotted = findPinnedModel(registry, "anthropic/claude-haiku-4.5");
  assert.equal(dotted.model, models[0]);
  assert.equal(dotted.model && (dotted as { normalized?: true }).normalized, true);
  assert.equal(findPinnedModel(registry, "anthropic/claude-sonnet-5").model, models[1], "undated pin finds the dated snapshot");
  assert.equal(findPinnedModel(registry, "openai/claude-haiku-4-5").model, null, "never across providers");
});

test("a miss and an ambiguity each come back with a reason", () => {
  const miss = findPinnedModel(registry, "anthropic/claude-opus-9");
  assert.equal(miss.model, null);
  if (!miss.model) assert.equal(miss.reason, "model anthropic/claude-opus-9 not found");
  const ambiguous = findPinnedModel(registry, "openai/gpt.6");
  assert.equal(ambiguous.model, null);
  if (!ambiguous.model) assert.match(ambiguous.reason, /ambiguous \(gpt-6, gpt-6-20260101, gpt-6-20260301\)/);
  assert.match((findPinnedModel(registry, "nonsense") as { reason: string }).reason, /not provider\/id/);
});
