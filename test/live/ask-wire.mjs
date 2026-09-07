/**
 * Does the child actually receive `ask_supervisor` on the wire?
 *
 * A tool nobody calls has two very different explanations — the model chose
 * not to, or it was never offered — and only the provider payload tells them
 * apart. This drives the real extension through pi and reads the tool list
 * out of every request the child makes.
 *
 *   bun run test/live/ask-wire.mjs
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
      "-p", 'Use agent_run with agent="scout" and task="reply with the single word DONE".',
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

  const offered = requests.some((names) => names.includes("ask_supervisor"));
  console.log(`\nask_supervisor offered to a child: ${offered ? "YES" : "NO"}`);
  if (!offered) {
    console.log("stderr:", (result.stderr || "").slice(0, 300));
  }
  process.exitCode = requests.length > 0 && offered ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
