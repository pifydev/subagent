/**
 * Does a tool's AbortSignal actually fire when the turn is aborted?
 *
 * The whole cancel path in @pify/subagent, @pify/swarm and @pify/workflow
 * rests on this one assumption: pi hands a long-running tool an AbortSignal,
 * and that signal fires when the user stops the turn. If it never fires, the
 * children keep talking to the provider and the cancel is cosmetic. The
 * mechanism is not something a unit test can check — it belongs to pi — so
 * this drives the real host.
 *
 * A probe extension registers a tool that sleeps, and aborts the agent from
 * an event handler while that tool is in flight. The tool reports whether the
 * signal fired and how long it waited.
 *
 *   bun run test/live/abort-wire.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";

const home = mkdtempSync(join(tmpdir(), "pify-abort-wire-"));
const repo = mkdtempSync(join(tmpdir(), "pify-abort-repo-"));
const out = join(home, "result.json");
const probe = join(home, "probe.ts");

const NL = String.fromCharCode(10);

// The probe mirrors exactly what agent_run / swarm_run / workflow do: take the
// signal, register an abort listener, and stop the long thing when it fires.
const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  'import { Type } from "typebox";',
  "export default function probe(pi) {",
  "  pi.registerTool({",
  '    name: "slow_thing",',
  '    label: "Slow thing",',
  '    description: "Sleeps for 60 seconds. Call it once, with no arguments, and report what it returns.",',
  "    parameters: Type.Object({}),",
  "    async execute(_id, _params, signal, _onUpdate, ctx) {",
  "      const started = Date.now();",
  "      // Abort the agent from inside the in-flight tool call: this is the",
  "      // exact situation a user pressing Esc creates.",
  "      setTimeout(() => { try { ctx.abort(); } catch {} }, 1500);",
  "      const stopped = await new Promise((resolve) => {",
  "        const timer = setTimeout(() => resolve(false), 60000);",
  "        if (signal) {",
  "          if (signal.aborted) { clearTimeout(timer); resolve(true); return; }",
  '          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(true); }, { once: true });',
  "        }",
  "      });",
  "      appendFileSync(process.env.ABORT_OUT, JSON.stringify({",
  "        signalProvided: Boolean(signal),",
  "        aborted: stopped,",
  "        waitedMs: Date.now() - started,",
  "      }) + String.fromCharCode(10));",
  '      return { content: [{ type: "text", text: stopped ? "aborted" : "slept" }], details: {} };',
  "    },",
  "  });",
  "}",
].join(NL);

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo" + NL);

  const started = Date.now();
  const result = spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      // Wrapped: unquoted sentences reach pi one prompt per word on Windows
      // under shell:true (see task/test/live/sweep-wire.mjs).
      "-p", '"Call the slow_thing tool once, then tell me what it returned."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ABORT_OUT: out },
    },
  );
  const elapsed = Date.now() - started;
  if (process.env.ABORT_DEBUG) {
    console.log("stdout:", (result.stdout || "").slice(0, 1500));
    console.log("stderr:", (result.stderr || "").slice(0, 1500));
  }

  const records = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  check("the tool ran", records.length > 0, `${records.length} call(s)`);
  const first = records[0];
  if (first) {
    check("pi hands a long-running tool a signal", first.signalProvided === true);
    check("the signal fires when the turn is aborted", first.aborted === true);
    check(
      "it fires promptly, not after the work would have finished anyway",
      first.aborted === true && first.waitedMs < 30_000,
      `waited ${first.waitedMs}ms of a 60000ms sleep`,
    );
  }
  console.log(`${NL}${passed}/${passed + failed} passed (pi exited after ${elapsed}ms)`);
  process.exitCode = failed === 0 && records.length > 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
