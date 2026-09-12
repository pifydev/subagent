/**
 * Does a finished background run's report reach the model unasked?
 *
 * The suite-wide review found the previous version of this test measured
 * print-mode teardown, not delivery: `pi -p` disposes the runtime the moment
 * the parent's prompt resolves, the emitted session_shutdown makes subagent
 * cancel its own still-running child, and the delivery then fired into a
 * disposed session where the error is swallowed. The only pass path was the
 * child finishing while the parent still streamed — a race a multi-round-trip
 * child structurally loses. A real TUI session outlives its children; print
 * mode does not, so the probe holds the parent's last turn open until the
 * child's result entry lands on the branch, then releases. The queued
 * follow-up delivery triggers the next turn, and THAT turn's provider payload
 * is where the claim is settled — the held-turn technique memory's
 * observe-wire proved, standing in for a session that is simply still alive.
 *
 *   node test/live/delivery-wire.mjs
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
  // Hold the parent's turn open until the background child's result entry
  // appears on the branch, so print mode cannot tear the session down under
  // the run. A real session stays alive on its own; only -p needs this.
  "  let held = false;",
  '  pi.on("agent_end", async (_event, ctx) => {',
  "    if (held) return;",
  "    held = true;",
  "    const deadline = Date.now() + 120000;",
  "    for (;;) {",
  "      const finished = ctx.sessionManager.getBranch().some((e) => {",
  "        const entry = e || {};",
  '        return entry.customType === "subagent-result" && entry.data && entry.data.status && entry.data.status !== "running";',
  "      });",
  "      if (finished || Date.now() > deadline) {",
  '        appendFileSync(process.env.DELIVERY_OUT, JSON.stringify({ waited: true, finished }) + String.fromCharCode(10));',
  "        return;",
  "      }",
  "      await new Promise((r) => setTimeout(r, 1500));",
  "    }",
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
      timeout: 420_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, DELIVERY_OUT: out },
    },
  );

  const lines = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const requests = lines.filter((l) => l.delivered !== undefined);
  const wait = lines.find((l) => l.waited);

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  const delivered = requests.filter((r) => r.delivered).length;
  console.log(
    `requests: ${requests.length}, carrying the delivered report: ${delivered}, child finished: ${wait ? wait.finished : "unknown"}`,
  );

  check("requests were captured", requests.length > 0, `${requests.length}`);
  check(
    "the background child actually finished while the session lived",
    wait !== undefined && wait.finished === true,
  );
  check("the finished run's report reached the model unasked", delivered > 0, `${delivered} request(s)`);

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
