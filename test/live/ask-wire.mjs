/**
 * ask_supervisor and headless runs: the fail-closed half, measured.
 *
 * The suite-wide review found the old version of this test could
 * structurally never pass: in `-p` print mode ctx.hasUI is false, so the
 * extension deliberately does not register ask_supervisor — and even when it
 * is registered, it lives on the CHILD session, whose noExtensions loader
 * means the child's provider requests never pass through this parent-side
 * probe. The test was asserting on bytes it could not see, and its failure
 * measured the harness, not the feature.
 *
 * What -p CAN measure is the design's fail-closed half: a headless run has
 * nobody to answer a supervisor question, so the tool must NOT be offered.
 * That is asserted here for the parent payloads, plus the split-brain guard:
 * agent_run itself must still be offered, or the gate silenced more than the
 * question tool. The offered-when-a-UI-exists half needs a TUI and is
 * documented in the README's honest-status line instead of being faked here.
 *
 *   node test/live/ask-wire.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";

const home = mkdtempSync(join(tmpdir(), "pify-ask-wire-"));
const repo = mkdtempSync(join(tmpdir(), "pify-ask-repo-"));
const wire = join(home, "wire.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const tools = (event.payload && event.payload.tools) || [];",
  "    const names = tools.map((t) => (t.function && t.function.name) || t.name);",
  "    appendFileSync(process.env.ASK_WIRE, JSON.stringify(names) + String.fromCharCode(10));",
  "  });",
  "}",
].join(String.fromCharCode(10));

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo\n");

  const result = spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      "-e", join(PKG, "extensions", "subagent.ts"),
      // Wrapped in literal double quotes (inner quoting switched to single,
      // which cmd.exe passes through): an unwrapped sentence reaches pi one
      // prompt per word on Windows (see task/test/live/sweep-wire.mjs).
      "-p", '"Use agent_run with agent=scout and task=\'reply with the single word DONE\'."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ASK_WIRE: wire },
    },
  );

  const requests = existsSync(wire)
    ? readFileSync(wire, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

  console.log(`requests captured: ${requests.length}`);
  requests.forEach((names, i) => console.log(`  #${i + 1}: ${names.join(", ") || "(no tools)"}`));

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  check("requests were captured", requests.length > 0, `${requests.length}`);
  check(
    "headless: ask_supervisor is NOT offered — nobody is there to answer it",
    requests.length > 0 && !requests.some((names) => names.includes("ask_supervisor")),
  );
  check(
    "and agent_run still is — the gate silenced the question, not the package",
    requests.some((names) => names.includes("agent_run")),
  );
  if (failed > 0) console.log("stderr:", (result.stderr || "").slice(0, 300));

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
