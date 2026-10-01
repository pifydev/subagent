import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DEFAULT_MODEL_FILE, defaultModelFiles, parseDefaultModel, readDefaultModel } from "../src/default-model.ts";

test("parseDefaultModel takes a non-empty string and nothing else", () => {
  assert.equal(parseDefaultModel('{"defaultModel":" anthropic/claude-haiku-4-5 "}'), "anthropic/claude-haiku-4-5");
  assert.equal(parseDefaultModel('{"defaultModel":""}'), null);
  assert.equal(parseDefaultModel('{"defaultModel":42}'), null);
  assert.equal(parseDefaultModel("{}"), null);
  assert.equal(parseDefaultModel("[]"), null);
  assert.equal(parseDefaultModel("not json"), null);
});

test("the project file is consulted first, and only when project agents are approved", () => {
  const agentDir = join("/", "agent");
  const cwd = join("/", "repo");
  assert.deepEqual(defaultModelFiles(agentDir, cwd, true), [join(cwd, ".pi", DEFAULT_MODEL_FILE), join(agentDir, DEFAULT_MODEL_FILE)]);
  assert.deepEqual(defaultModelFiles(agentDir, cwd, false), [join(agentDir, DEFAULT_MODEL_FILE)]);
});

test("readDefaultModel falls through unreadable or empty files and reports the source", () => {
  const agentDir = join("/", "agent");
  const cwd = join("/", "repo");
  const files: Record<string, string> = {
    [join(agentDir, DEFAULT_MODEL_FILE)]: '{"defaultModel":"openai/gpt-6"}',
    [join(cwd, ".pi", DEFAULT_MODEL_FILE)]: '{"defaultModel":"anthropic/claude-haiku-4-5"}',
  };
  const read = (file: string) => {
    const text = files[file];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
  assert.deepEqual(readDefaultModel(agentDir, cwd, true, read), { pin: "anthropic/claude-haiku-4-5", file: join(cwd, ".pi", DEFAULT_MODEL_FILE) });
  assert.deepEqual(readDefaultModel(agentDir, cwd, false, read), { pin: "openai/gpt-6", file: join(agentDir, DEFAULT_MODEL_FILE) });
  files[join(cwd, ".pi", DEFAULT_MODEL_FILE)] = "{}";
  assert.equal(readDefaultModel(agentDir, cwd, true, read)?.pin, "openai/gpt-6", "an empty project file falls through");
  assert.equal(readDefaultModel(agentDir, cwd, true, () => { throw new Error("ENOENT"); }), null);
});
