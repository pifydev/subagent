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
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadAgentDefs } from "../src/defs.ts";
import {
  ASK_BUDGET,
  ASK_EXHAUSTED,
  ASK_REASONS,
  ASK_TOOL_DESCRIPTION,
  ASK_TOOL_NAME,
  askBody,
  askTitle,
  formatAnswer,
  type AskReason,
} from "../src/ask.ts";
import { buildMentionMessage, findMentions } from "../src/mentions.ts";
import { LiveChildren, cancelNote, type CancelReason } from "../src/cancel.ts";
import {
  consentQuestion,
  decideConsent,
  envConsent,
  parseConsent,
  readConsent,
  writeConsent,
} from "../src/consent.ts";
import { createIsolationWorktree, isolationNote, removeIfUnchanged, type Isolation } from "../src/isolate.ts";
import { buildTaskPrompt, childFraming, describeDefs, formatRunResult } from "../src/prompts.ts";
import { buildWidgetLines } from "../src/widget.ts";
import {
  MAX_CONCURRENT_BACKGROUND,
  isRecord,
  type AgentDef,
  type RunState,
  type RunStatus,
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
  /** Live child sessions per run, so a stop actually reaches the children. */
  const live = new LiveChildren();
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

  /** Where the suite records which projects you approved, and for what. */
  function consentFile(): string {
    return join(getAgentDir(), "pify-project-consent.json");
  }

  /**
   * May this repository's own agent definitions be loaded? A project
   * definition overrides a builtin of the same name and carries both a tool
   * allowlist and a system prompt, so it decides what your `reviewer` is.
   *
   * pi's own trust decision is necessary but not sufficient: pi only asks
   * about trust when the repository ships one of the resources pi itself
   * loads, and `.pi/agents/` is not one of them — measured, a repo whose only
   * pi file was `.pi/agents/reviewer.md` reported `isProjectTrusted=true`.
   */
  async function projectAgentsAllowed(ctx: UiContext): Promise<boolean> {
    const dir = join(ctx.cwd, ".pi", "agents");
    if (!existsSync(dir)) return false;
    const file = consentFile();
    let raw: string | null = null;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      raw = null;
    }
    const store = parseConsent(raw);
    const verdict = decideConsent({
      projectTrusted: (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false,
      remembered: readConsent(store, ctx.cwd, "agents"),
      hasUI: ctx.hasUI,
      envOverride: envConsent(process.env),
    });
    if (verdict !== "ask") return verdict === "allow";

    const approved = await ctx.ui.confirm(
      "Load this project's agent definitions?",
      consentQuestion("its own agent definitions, which override the builtins of the same name", dir),
    );
    try {
      writeFileSync(file, `${JSON.stringify(writeConsent(store, ctx.cwd, "agents", approved), null, 2)}
`);
    } catch {
      // An unwritable consent file costs us the memory of the answer, not the answer.
    }
    return approved;
  }

  async function runChild(ctx: UiContext, def: AgentDef, run: RunState, workDir?: string): Promise<void> {
    // Nothing to start if the user already stopped this run while it queued
    // behind the concurrency cap.
    if (run.status === "aborted") return;
    let session: AgentSession | null = null;
    let unsubscribe: (() => void) | null = null;
    let releaseLive: (() => void) | null = null;
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
      // The child gets one way to reach a human: the decision it must not
      // invent. Only when there is a UI to ask through.
      let questionsLeft = ASK_BUDGET;
      const customTools = ctx.hasUI
        ? [
            {
              name: ASK_TOOL_NAME,
              label: "Ask supervisor",
              description: ASK_TOOL_DESCRIPTION,
              parameters: Type.Object({
                reason: StringEnum(ASK_REASONS),
                question: Type.String({ description: "One specific question" }),
                context: Type.Optional(Type.String({ description: "What you already established" })),
              }),
              async execute(
                _childId: string,
                params: { reason: AskReason; question: string; context?: string },
              ) {
                if (questionsLeft <= 0) {
                  return { content: [{ type: "text", text: ASK_EXHAUSTED }], details: {} };
                }
                questionsLeft--;
                const answer = await ctx.ui.input(
                  askTitle(def.name, params.reason),
                  askBody(params.question, params.context).slice(0, 500),
                );
                return {
                  content: [{ type: "text", text: formatAnswer(answer ?? null) }],
                  details: { reason: params.reason, answered: Boolean(answer?.trim()) },
                };
              },
            },
          ]
        : [];

      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(workDir ?? ctx.cwd),
        model,
        thinkingLevel: (def.thinking ?? pi.getThinkingLevel()) as never,
        // `tools` is an allowlist and it filters customTools too, so a custom
        // tool that is not named here is registered and then dropped — the
        // child is told it has no such tool. Found the hard way.
        tools: customTools.length > 0 ? [...def.tools, ASK_TOOL_NAME] : def.tools,
        customTools: customTools as never,
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
            childFraming(customTools.length > 0),
          ],
        }),
      });
      session = created.session;
      releaseLive = live.register(run.id, session);

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

      // A run stopped at its turn cap is not a finished answer. Returning it
      // unmarked reads as complete to whoever asked for it.
      const cappedAtTurnLimit = run.turns >= def.maxTurns && last?.stopReason === "aborted";
      run.result = cappedAtTurnLimit && text
        ? `${text}

[partial: stopped at the ${def.maxTurns}-turn cap for agent "${def.name}" — this answer may be unfinished]`
        : text || null;
      // A run the user (or session teardown) already cancelled keeps that
      // verdict and its explanation — the child stopping is the consequence,
      // not a separate outcome.
      // The cast is load-bearing: TypeScript narrowed status at the top of
      // this function, but cancelRun can flip it while we were awaiting.
      const cancelled = (run.status as RunStatus) === "aborted" && run.error !== null;
      if (!cancelled) {
        run.status =
          last?.stopReason === "aborted" ? "aborted" : last?.stopReason === "error" ? "error" : "done";
      }
      // A child that stopped cleanly and said nothing has not answered. It
      // used to be recorded as done with a null result, which formatRunResult
      // then reported as "still running" — the parent polling forever for a
      // run that already ended. An exit status is not an answer.
      if (run.status === "done" && !run.result) {
        run.status = "error";
        run.error = "the child finished without producing an answer";
      }
      if (run.status === "error" && !run.error) run.error = text || "child session error";
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      run.finishedAt = Date.now();
      if (releaseLive) releaseLive();
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

  /**
   * Stop a run and the child it started. Both meanings of "stop" — the user's
   * abort and session teardown — come through here; marking the record
   * without aborting the child left it talking to the provider on the user's
   * money, writing into a conversation nobody would read.
   */
  function cancelRun(run: RunState, reason: CancelReason): void {
    const stopped = live.abortRun(run.id);
    if (run.status === "running") {
      run.status = "aborted";
      run.finishedAt = Date.now();
      run.error = cancelNote(reason, stopped);
    }
    renderWidget();
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
      signal,
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

      // Esc must reach the child. A background run outlives this tool call by
      // design, so its signal is not its cancel button.
      let stopListening: (() => void) | null = null;
      if (signal && !background) {
        const onAbort = () => cancelRun(run, "user-abort");
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          stopListening = () => signal.removeEventListener("abort", onAbort);
        }
      }

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

      try {
        await runIt();
      } finally {
        if (stopListening) stopListening();
      }
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
    const loaded = loadAgentDefs(ctx.cwd, getAgentDir(), await projectAgentsAllowed(ctx));
    defs = loaded.defs;
    if (loaded.refused.length > 0) {
      notify(
        ctx,
        `subagent: ${loaded.refused.length} project agent definition(s) not loaded — you have not approved this project's agents (${loaded.refused.join(", ")})`,
        "warning",
      );
    }
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
    // A child cannot outlive the session that asked for it.
    for (const run of runs.values()) {
      if (run.status === "running") cancelRun(run, "session-switch");
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
