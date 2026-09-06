import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { BUILTIN_AGENTS } from "./builtin.ts";
import { parseAgentFile } from "./frontmatter.ts";
import type { AgentDef } from "./types.ts";

function loadDir(dir: string, source: "global" | "project"): AgentDef[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const defs: AgentDef[] = [];
  for (const file of files) {
    try {
      const def = parseAgentFile(
        basename(file, ".md"),
        readFileSync(join(dir, file), "utf8"),
        source,
      );
      if (def) defs.push(def);
    } catch {
      // unreadable file — skip
    }
  }
  return defs;
}

export interface LoadResult {
  defs: Map<string, AgentDef>;
  /** Project definitions found but not loaded because the project is untrusted. */
  refused: string[];
}

/**
 * Load all agent definitions. Precedence per name:
 * project (.pi/agents/) > global (<agentDir>/agents/) > builtin.
 *
 * Project definitions are a repository's own files: they carry a tool
 * allowlist and a system prompt, and they OVERRIDE a builtin of the same
 * name. A cloned repo shipping .pi/agents/reviewer.md would otherwise
 * silently become "reviewer" the first time anyone ran it. They load only
 * once the project is trusted, riding pi's existing decision rather than
 * inventing a second prompt.
 */
export function loadAgentDefs(cwd: string, agentDir: string, projectTrusted = true): LoadResult {
  const defs = new Map<string, AgentDef>();
  for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
    const def = parseAgentFile(name, content, "builtin");
    if (def) defs.set(def.name, def);
  }
  for (const def of loadDir(join(agentDir, "agents"), "global")) defs.set(def.name, def);

  const project = loadDir(join(cwd, ".pi", "agents"), "project");
  if (!projectTrusted) {
    return { defs, refused: project.map((def) => def.name) };
  }
  for (const def of project) defs.set(def.name, def);
  return { defs, refused: [] };
}
