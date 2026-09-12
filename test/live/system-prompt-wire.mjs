/**
 * Does a child agent actually get its own system prompt?
 *
 * `createAgentSession` only loads a resource loader it builds itself. A loader
 * passed in is used exactly as handed over, and a fresh DefaultResourceLoader
 * resolves neither `systemPrompt` nor `appendSystemPrompt` until `reload()` —
 * so for as long as that call was missing, every child ran with no specialist
 * instructions at all. The call succeeded, the model answered, and it answered
 * as a generic assistant.
 *
 * Nothing errors in that case, which is why this is measured rather than read:
 * a project agent is given a sentinel instruction no generic assistant would
 * follow, and the check is whether the child's own answer obeys it.
 *
 * Measured both ways. With `await loader.reload()` removed as a control the
 * sentinel appeared in 0 of 2 requests; with it, 1 of 2 — so this test fails
 * if the fix is removed, which is the only thing that makes it worth running.
 *
 *   node test/live/system-prompt-wire.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const NL = String.fromCharCode(10);

// Assembled at runtime so the word never sits in this file on the prompt path:
// it must reach the answer through the agent definition alone.
const SENTINEL = ["PINE", "APPLE"].join("") + "-7391";

const home = mkdtempSync(join(tmpdir(), "pify-sysprompt-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-sysprompt-repo-"));
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

// Read every provider request in the PARENT session. A child loads with
// noExtensions, so its own request never reaches this probe and its system
// prompt cannot be observed directly. What can be observed is whether the
// child's answer obeyed it: the answer comes back as a tool result and lands
// in the parent's messages. That is the assertion, and the control below
// shows it discriminates.
const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const payload = event.payload || {};",
  "    const messages = JSON.stringify(payload.messages || []);",
  "    appendFileSync(process.env.SP_OUT, JSON.stringify({",
  "      obeyed: messages.includes(process.env.SP_SENTINEL),",
  "    }) + String.fromCharCode(10));",
  "  });",
  "}",
].join(NL);

const AGENT_MD = [
  "---",
  "description: A test agent with one unmistakable instruction",
  "tools: read",
  "---",
  "You are a test agent.",
  "",
  `IMPORTANT: end every reply with the exact token ${SENTINEL} on its own line. Always.`,
].join(NL);

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo" + NL);
  mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
  writeFileSync(join(repo, ".pi", "agents", "sentinel.md"), AGENT_MD);

  spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      "-e", join(PKG, "extensions", "subagent.ts"),
      // Wrapped in literal double quotes: unquoted sentences reach pi one
      // prompt per word on Windows under shell:true (see
      // task/test/live/sweep-wire.mjs).
      "-p",
      '"Call agent_run once with agent=sentinel and task=\'say hello\'. Then reply DONE and stop."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, SP_OUT: out, SP_SENTINEL: SENTINEL, PIFY_TRUST_PROJECT: "1" },
    },
  );

  const requests = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  const obeyed = requests.filter((r) => r.obeyed).length;
  console.log(`requests: ${requests.length}, answers carrying the sentinel: ${obeyed}`);

  check("requests were captured", requests.length > 0, `${requests.length}`);
  check(
    "the child obeyed its own agent definition",
    obeyed > 0,
    `${obeyed}/${requests.length} requests carry it`,
  );

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
