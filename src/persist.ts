/**
 * What a run looks like in the session file, and how it comes back.
 *
 * A finished run is appended to the session as a custom entry so agent_result
 * keeps working after /reload. It used to be appended the moment the child
 * session ended — which is before verify, before the gate and before the
 * outcome settles — so the restored record was a clean success with no gate
 * and no outcome, whatever the gate had actually said. The entry has to be
 * written once, after everything that can change the record has run.
 *
 * The session file is forever, so what goes in is trimmed: the gate output
 * a failing suite prints is kept to a tail, and the in-memory `settling`
 * flag — meaningful only while the extension that set it is alive — is
 * dropped.
 *
 * Pure: the entry type, the record as stored, and the replay filter.
 */

import { isRecord, type RunState } from "./types.ts";

/** The part of a session entry replay reads; pi's own entry type fits without a cast. */
export interface ReplayEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** The custom-entry type a finished run is stored under. */
export const RESULT_ENTRY = "subagent-result";

/** Longest gate output kept in the session file; the verdict is at the end. */
export const PERSISTED_GATE_OUTPUT = 4000;

/** The record as it should be stored: a copy, capped and without live-only state. */
export function persistable(run: RunState): RunState {
  const { settling: _settling, ...stored } = run;
  if (stored.gate?.output && stored.gate.output.length > PERSISTED_GATE_OUTPUT) {
    stored.gate = { ...stored.gate, output: `…\n${stored.gate.output.slice(-PERSISTED_GATE_OUTPUT)}` };
  }
  return stored;
}

/**
 * The finished runs recorded on this session branch, in order. A running
 * entry did not survive whatever restarted us and is not replayed.
 */
export function replayRuns(branch: Iterable<ReplayEntry>): RunState[] {
  const runs: RunState[] = [];
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== RESULT_ENTRY || !isRecord(entry.data)) continue;
    const data = entry.data as unknown as RunState;
    if (typeof data.id === "string" && data.status !== "running") runs.push(data);
  }
  return runs;
}
