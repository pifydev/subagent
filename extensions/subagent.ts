/**
 * @pify/subagent — spawn scoped subagents from within a pi session.
 *
 * The foundation layer of the Pify agent stack: one tool call spawns one
 * child pi session (in-process, createAgentSession) with an agent type's
 * tool allowlist, model/thinking overrides, and turn cap. Foreground runs
 * block and return the child's report; background runs stream into a small
 * widget and are collected with agent_result. Agent types are Claude
 * Code-compatible markdown files (project > global > builtin); three
 * builtins ship: reviewer, scout, worker.
 *
 * Coordination of many agents belongs to @pify/swarm; scripted orchestration
 * to @pify/workflow — this package deliberately stays the primitive.
 *
 * Design synthesis: in-process runner + Claude Code tool shapes
 * (tintinweb/pi-subagents), agent archetypes + md definitions
 * (nicobailon/pi-subagents), sub-session mechanics proven in @pify/btw.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadAgentDefs } from "../src/defs.ts";
import { buildMentionMessage, findMentions } from "../src/mentions.ts";
import { createIsolationWorktree, isolationNote, type Isolation } from "../src/isolate.ts";
import { CHILD_FRAMING, buildTaskPrompt, describeDefs, formatRunResult } from "../src/prompts.ts";
import { buildWidgetLines } from "../src/widget.ts";
import {
  MAX_CONCURRENT_BACKGROUND,
  isRecord,
  type AgentDef,
  type RunState,
} from "../src/types.ts";

const RESULT_ENTRY = "subagent-result";
const MENTION_ENTRY = "subagent-mention";

type UiContext = ExtensionContext;

export default function subagent(pi: ExtensionAPI) {
  let defs = new Map<string, AgentDef>();
  // v0.2 queue: children beyond the cap wait for a slot instead of failing.
  let slotsInUse = 0;
  const slotWaiters: Array<() => void> = [];
  async function acquireSlot(): Promise<void> {
    if (slotsInUse < MAX_CONCURRENT_BACKGROUND) {
      slotsInUse++;
      return;
    }
    await new Promise<void>((resolve) => slotWaiters.push(resolve));
    slotsInUse++;
  }
  function releaseSlot(): void {
    slotsInUse--;
    const next = slotWaiters.shift();
    if (next) next();
  }
  const runs = new Map<string, RunState>();
  const counters = new Map<string, number>();
  let lastUiCtx: UiContext | null = null;

  // ── UI ───────────────────────────────────────────────────────────────

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI) return;
    lastUiCtx = ctx;
    const now = Date.now();
    const anyVisible = [...runs.values()].some(
      (r) => r.status === "running" || (r.finishedAt ?? 0) > now - 15_000,
    );
    if (!anyVisible) {
      ctx.ui.setWidget("subagent", undefined);
      return;
    }
    ctx.ui.setWidget(
      "subagent",
      (_tui: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }) =>
        new Text(buildWidgetLines([...runs.values()], theme, Date.now()).join("\n"), 0, 0),
      { placement: "aboveEditor" },
    );
  }

  function notify(ctx: UiContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  // ── Child runner ─────────────────────────────────────────────────────

  function nextId(agent: string): string {
    const n = (counters.get(agent) ?? 0) + 1;
    counters.set(agent, n);
    return `${agent}-${n}`;
  }

  async function runChild(ctx: UiContext, def: AgentDef, run: RunState, workDir?: string): Promise<void> {
    let session: AgentSession | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      let model = ctx.model ?? null;
      if (def.model) {
        const [provider, ...rest] = def.model.split("/");
        const found =
          provider && rest.length > 0 ? ctx.modelRegistry.find(provider, rest.join("/")) : undefined;
        if (found) model = found;
        else notify(ctx, `subagent ${run.id}: model ${def.model} not found — using session model`, "warning");
      }
      if (!model) throw new Error("No model available");

      // getSystemPromptOptions lives on the command context; tool contexts may
      // carry it at runtime — probe structurally, fall back to the defaults.
      const promptHost = ctx as unknown as {
        getSystemPromptOptions?: () => { customPrompt?: string; appendSystemPrompt?: string };
      };
      const promptOptions = promptHost.getSystemPromptOptions?.() ?? {};
      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(workDir ?? ctx.cwd),
        model,
        thinkingLevel: (def.thinking ?? pi.getThinkingLevel()) as never,
        tools: def.tools,
        resourceLoader: new DefaultResourceLoader({
          cwd: workDir ?? ctx.cwd,
          agentDir: getAgentDir(),
          noExtensions: true,
          noPromptTemplates: true,
          noThemes: true,
          // system_prompt_mode: replace drops the parent's prompt so a
          // specialist is not also told to be this project's coding
          // assistant; inherit_skills: false keeps a focused child out of
          // the project's whole skill surface.
          noSkills: !def.inheritSkills,
          ...(def.systemPromptMode === "replace" ? {} : { systemPrompt: promptOptions.customPrompt }),
          appendSystemPrompt: [
            ...(def.systemPromptMode === "replace" || !promptOptions.appendSystemPrompt
              ? []
              : [promptOptions.appendSystemPrompt]),
            def.systemPrompt,
            CHILD_FRAMING,
          ],
        }),
      });
      session = created.session;

      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && (event as { message?: { role?: string } }).message?.role === "assistant") {
          run.turns++;
          const usage = (event as { message?: { usage?: { totalTokens?: number } } }).message?.usage;
          if (usage && typeof usage.totalTokens === "number") run.tokens += usage.totalTokens;
          renderWidget();
          if (run.turns >= def.maxTurns) {
            void session?.abort().catch(() => {});
          }
        }
      });

      await session.prompt(buildTaskPrompt(run.task), { source: "extension" } as never);

      const messages = session.messages as Array<{
        role?: string;
        stopReason?: unknown;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      const text = (last?.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();

      run.result = text || null;
      run.status =
        last?.stopReason === "aborted" ? "aborted" : last?.stopReason === "error" ? "error" : "done";
      if (run.status === "error") run.error = text || "child session error";
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      run.finishedAt = Date.now();
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // gone
        }
      }
      if (session) {
        try {
          session.dispose();
        } catch {
          // double-dispose fine
        }
      }
      pi.appendEntry(RESULT_ENTRY, run);
      renderWidget();
    }
  }

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "agent_run",
    label: "Run subagent",
    description:
      "Delegate one scoped task to a child agent. agent: reviewer (read-only review), scout " +
      "(read-only exploration/research), worker (full tools, implements a task), or a custom type " +
      "from .pi/agents/. background=false (default) blocks and returns the child's report; " +
      "background=true returns an id immediately — collect it later with agent_result. " +
      "Write the task as a complete, self-contained brief: the child sees none of this conversation. " +
      "For MUTATING tasks set isolation=worktree: the child gets its own git worktree and branch, the " +
      "main checkout stays untouched, and the report says how to merge or discard.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent type name" }),
      task: Type.String({ description: "Complete task brief for the child" }),
      background: Type.Optional(Type.Boolean({ description: "Run without blocking (default false)" })),
      isolation: Type.Optional(Type.String({ description: "Set to worktree to run in an isolated git worktree (for mutating tasks)" })),
    }),
    async execute(
      _id,
      params: { agent: string; task: string; background?: boolean; isolation?: string },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const def = defs.get(params.agent.trim().toLowerCase());
      if (!def) {
        throw new Error(
          `Unknown agent type "${params.agent}". Available: ${[...defs.keys()].sort().join(", ")}`,
        );
      }
      if (!params.task.trim()) throw new Error("agent_run requires a non-empty task.");

      const uiCtx = ctx as UiContext;
      const background = params.background === true;

      // v0.2: worktree isolation for mutating children — its own branch and
      // checkout under ~/.worktrees/, never touching the main tree.
      let isolation: Isolation | null = null;
      if (params.isolation === "worktree") {
        isolation = createIsolationWorktree(uiCtx.cwd, nextId(def.name));
      }

      const run: RunState = {
        id: isolation ? isolation.branch.replace(/^agent\//, "") : nextId(def.name),
        agent: def.name,
        task: params.task.trim(),
        background,
        status: "running",
        startedAt: Date.now(),
        finishedAt: null,
        tokens: 0,
        turns: 0,
        result: null,
        error: null,
      };
      runs.set(run.id, run);
      renderWidget(uiCtx);

      const runIt = async () => {
        await acquireSlot();
        try {
          await runChild(uiCtx, def, run, isolation?.path);
        } finally {
          releaseSlot();
        }
        if (isolation && run.result !== null) {
          run.result = `${run.result}\n\n${isolationNote(isolation)}`;
        }
      };

      if (background) {
        // v0.2: beyond the concurrency cap runs queue instead of rejecting.
        void runIt().then(() => {
          notify(uiCtx, `subagent ${run.id}: ${run.status}`, run.status === "done" ? "info" : "warning");
        });
        return {
          content: [
            { type: "text", text: `Started ${run.id} in the background. Collect with agent_result id="${run.id}".` },
          ],
          details: { id: run.id, worktree: isolation?.path ?? null },
        };
      }

      await runIt();
      return {
        content: [{ type: "text", text: formatRunResult(run) }],
        details: { id: run.id, status: run.status, tokens: run.tokens, worktree: isolation?.path ?? null },
      };
    },
  });

  pi.registerTool({
    name: "agent_result",
    label: "Subagent result",
    description: "Fetch the report of a background subagent by id (from agent_run).",
    parameters: Type.Object({
      id: Type.String({ description: "Run id, e.g. reviewer-1" }),
    }),
    async execute(_id, params: { id: string }) {
      const run = runs.get(params.id.trim());
      if (!run) {
        const known = [...runs.keys()].sort().join(", ") || "(none this session)";
        throw new Error(`No run "${params.id}". Known runs: ${known}`);
      }
      return {
        content: [{ type: "text", text: formatRunResult(run) }],
        details: { id: run.id, status: run.status },
      };
    },
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * `@reviewer look at the diff` delegates without anyone describing the
   * agent roster to the model. The instruction rides with the turn as a
   * custom message rather than as a system-prompt edit: the prefix stays
   * byte-identical, so the prompt cache survives the turn that is about to
   * fan out.
   */
  pi.on("before_agent_start", async (event) => {
    const prompt = (event as { prompt?: unknown }).prompt;
    if (typeof prompt !== "string" || defs.size === 0) return undefined;
    const mentioned = findMentions(prompt, [...defs.keys()]);
    if (mentioned.length === 0) return undefined;
    return {
      message: {
        customType: MENTION_ENTRY,
        content: buildMentionMessage(
          mentioned.map((name) => ({ name, description: defs.get(name)?.description ?? "" })),
        ),
        display: false,
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    defs = loadAgentDefs(ctx.cwd, getAgentDir());
    // Completed runs from earlier in this session's branch are replayable so
    // agent_result keeps working after /reload. Running ones did not survive.
    runs.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type !== "custom" || e.customType !== RESULT_ENTRY || !isRecord(e.data)) continue;
      const data = e.data as unknown as RunState;
      if (typeof data.id === "string" && data.status !== "running") runs.set(data.id, data);
    }
    renderWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    for (const run of runs.values()) {
      if (run.status === "running") {
        run.status = "aborted";
        run.finishedAt = Date.now();
      }
    }
    if (ctx.hasUI) ctx.ui.setWidget("subagent", undefined);
  });

  // ── Command ──────────────────────────────────────────────────────────

  pi.registerCommand("agents", {
    description: "List subagent types and this session's runs",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const runLines =
        [...runs.values()]
          .map((r) => `${r.id}: ${r.status} (${r.turns} turns, ${r.tokens} tok)`)
          .join("\n") || "(no runs yet)";
      ctx.ui.notify(
        `Agent types\n${describeDefs([...defs.values()])}\n\nRuns\n${runLines}\n\nCustom types: .pi/agents/<name>.md`,
        "info",
      );
    },
  });
}
