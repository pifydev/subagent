/**
 * A suite-wide default model for child agents.
 *
 * Every child without a `model:` of its own ran on whatever the parent
 * session happened to be using — a frontier-model session fanned out
 * frontier-model children for grep-level work, and switching the parent to
 * something cheap for the fan-out meant switching back afterwards. One file
 * names the model children default to: `pify-agents.json` in pi's agent
 * directory, or `.pi/pify-agents.json` in the project, which wins. An agent
 * file's own `model:` still wins over both; a session with neither file
 * behaves as before. The pin is resolved by the same matcher as an agent
 * file's pin, so a stale id is said out loud rather than silently dropped.
 * (signalridge pi-subagent's defaultModel setting, as one file shared by the
 * three spawning packages rather than three settings.) Vendored per package,
 * byte-identical; zero dependencies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MODEL_FILE = "pify-agents.json";

export interface DefaultModelSource {
  /** The `provider/id` pin as written. */
  pin: string;
  /** The file it came from, for the notice. */
  file: string;
}

/** The `defaultModel` of a config text, or null when it names none; never throws. */
export function parseDefaultModel(text: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const pin = (raw as { defaultModel?: unknown }).defaultModel;
  return typeof pin === "string" && pin.trim() ? pin.trim() : null;
}

/** The files consulted, most specific first. The project file only when its agents are approved. */
export function defaultModelFiles(agentDir: string, cwd: string, includeProject: boolean): string[] {
  const files = [join(agentDir, DEFAULT_MODEL_FILE)];
  if (includeProject) files.unshift(join(cwd, ".pi", DEFAULT_MODEL_FILE));
  return files;
}

export function readDefaultModel(
  agentDir: string,
  cwd: string,
  includeProject: boolean,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): DefaultModelSource | null {
  for (const file of defaultModelFiles(agentDir, cwd, includeProject)) {
    let text: string;
    try {
      text = read(file);
    } catch {
      continue;
    }
    const pin = parseDefaultModel(text);
    if (pin) return { pin, file };
  }
  return null;
}
