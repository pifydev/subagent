/**
 * Does a finished background run actually reach the model?
 *
 * The not-ready answer now tells the agent "do not poll, the result is
 * delivered to you". That is a promise, and if delivery does not work it is a
 * lie that strands the agent waiting for something that never arrives. Only
 * the provider payload can settle it, so this reads every request pi sends
 * and looks for the report in one of them.
 *
 *   bun run test/live/delivery-wire.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const NL = String.fromCharCode(10);

const home = mkdtempSync(join(tmpdir(), "pify-delivery-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-delivery-repo-"));
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const text = JSON.stringify((event.payload && event.payload.messages) || []);",
  "    appendFileSync(process.env.DELIVERY_OUT, JSON.stringify({",
  '      delivered: text.includes("you started in the background"),',
  '      pendingAnswer: text.includes("Do not poll"),',
  "    }) + String.fromCharCode(10));",
  "  });",
  "}",
].join(NL);

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo" + NL);

  spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      "-e", join(PKG, "extensions", "subagent.ts"),
      // Quoted: with shell:true on Windows an unquoted sentence arrives as
      // one prompt per word.
      "-p",
      '"Call agent_run with agent=scout, background=true and task=\'name one file in this directory\'. Then reply with the word STARTED and stop. Do not call agent_result."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, DELIVERY_OUT: out },
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

  const delivered = requests.filter((r) => r.delivered).length;
  console.log(`requests: ${requests.length}, carrying the delivered report: ${delivered}`);

  check("requests were captured", requests.length > 0, `${requests.length}`);
  check("the finished run's report reached the model unasked", delivered > 0);

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
