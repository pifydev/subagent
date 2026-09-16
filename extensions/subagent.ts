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
import { withUiLock } from "../src/ui-lock.ts";
import { LoopGuard } from "../src/loop-guard.ts";
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
import { registerOwned } from "../src/owned.ts";
import { DELIVERY_TYPE, deliveryMessage, pendingResult } from "../src/pending.ts";
import { waitUntil } from "../src/wait.ts";
import {
  consentQuestion,
  decideConsent,
  envConsent,
  parseConsent,
  persistConsent,
  readConsent,
} from "../src/consent.ts";
import { createIsolationWorktree, isolationNote, removeIfUnchanged, type Isolation } from "../src/isolate.ts";
import { buildTaskPrompt, childFraming, describeDefs, formatRunResult } from "../src/prompts.ts";
import { runVerification } from "../src/verify.ts";
import { normalizeGate, runGate, sharedWith, type GateContract, type GateSibling } from "../src/gate.ts";
import { runGateCycle } from "../src/repair.ts";
import { repairAllowed } from "../src/policy.ts";
import { deriveOutcome, parseDeclaredOutcome, stripDeclaration } from "../src/outcome.ts";
import { extractReport, markReport, type ReportMessage } from "../src/report.ts";
import { RESULT_ENTRY, persistable, replayRuns } from "../src/persist.ts";
import { mintRunId, seedCounters } from "../src/ids.ts";
import { buildWidgetLines, isVisible } from "../src/widget.ts";
import { MAX_CONCURRENT_BACKGROUND, type AgentDef, type RunState, type RunStatus } from "../src/types.ts";

const MENTION_ENTRY = "subagent-mention";
/** Longest agent_result may block waiting for a run, in seconds. */
const MAX_WAIT_SECONDS = 120;
/** How often a waiting agent_result looks at the run. */
const WAIT_POLL_MS = 250;
const CLEAN_WORKTREE_NOTE =
  "Ran isolated in a temporary worktree; it changed nothing, so the worktree and its branch were removed.";

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
  /** Live child sessions addressable for steering while they run in the background. */
  const steerable = new Map<string, AgentSession>();
  const counters = new Map<string, number>();
  let lastUiCtx: UiContext | null = null;

  // ── UI ───────────────────────────────────────────────────────────────

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI) return;
    lastUiCtx = ctx;
    const now = Date.now();
    const anyVisible = [...runs.values()].some((r) => isVisible(r, now));
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
    return mintRunId(counters, agent);
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

    const approved = await withUiLock(() =>
      ctx.ui.confirm(
        "Load this project's agent definitions?",
        consentQuestion("its own agent definitions, which override the builtins of the same name", dir),
      ),
    );
    try {
      persistConsent(file, ctx.cwd, "agents", approved);
    } catch {
      // An unwritable consent file costs us the memory of the answer, not the answer.
    }
    return approved;
  }

  /**
   * How a child is filed and recorded. `owner` is the run whose cancel must
   * reach this child — a verify or gate helper names its parent, a top-level
   * run names itself. `persist` writes the record to the session as soon as
   * the child ends; a top-level run leaves that to runIt, which writes it once
   * after verify, gate and the outcome have had their say.
   */
  interface ChildOptions {
    owner?: string;
    persist?: boolean;
  }

  async function runChild(
    ctx: UiContext,
    def: AgentDef,
    run: RunState,
    workDir?: string,
    options: ChildOptions = {},
  ): Promise<void> {
    // Nothing to start if the user already stopped this run while it queued
    // behind the concurrency cap.
    if (run.status === "aborted") return;
    const owner = options.owner ?? run.id;
    let session: AgentSession | null = null;
    let unsubscribe: (() => void) | null = null;
    let releaseLive: (() => void) | null = null;
    let stallReason: string | null = null;
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
                const answer = await withUiLock(() =>
                  ctx.ui.input(
                    askTitle(def.name, params.reason),
                    askBody(params.question, params.context).slice(0, 500),
                  ),
                );
                return {
                  content: [{ type: "text", text: formatAnswer(answer ?? null) }],
                  details: { reason: params.reason, answered: Boolean(answer?.trim()) },
                };
              },
            },
          ]
        : [];

      // `reload()` is not optional. `createAgentSession` only loads a resource
      // loader it builds itself; one passed in is used exactly as handed over,
      // and a fresh DefaultResourceLoader resolves neither `systemPrompt` nor
      // `appendSystemPrompt` until it loads. Without it the child ran with no
      // instructions at all — the call succeeds, the model answers, and it
      // answers as a generic assistant with nothing to say it went wrong.
      const loader = new DefaultResourceLoader({
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
      });
      await loader.reload();
      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(workDir ?? ctx.cwd),
        model,
        thinkingLevel: (def.thinking ?? pi.getThinkingLevel()) as never,
        // `tools` is an allowlist and it filters customTools too, so a custom
        // tool that is not named here is registered and then dropped — the
        // child is told it has no such tool. Found the hard way.
        tools: customTools.length > 0 ? [...def.tools, ASK_TOOL_NAME] : def.tools,
        customTools: customTools as never,
        resourceLoader: loader,
      });
      session = created.session;
      // Under its own id and its owner's: Esc on the parent stops the helper
      // it is waiting on, and the helper can still be stopped by name.
      releaseLive = registerOwned(live, run.id, owner, session);
      // Addressable for agent_steer while it runs; removed in the finally.
      steerable.set(run.id, session);

      const guard = new LoopGuard();
      unsubscribe = session.subscribe((event) => {
        const message = (
          event as {
            message?: {
              role?: string;
              usage?: { totalTokens?: number };
              content?: Array<{ type?: string; text?: string }>;
            };
          }
        ).message;
        if (event.type === "message_end" && message?.role === "assistant") {
          run.turns++;
          const usage = message.usage;
          if (usage && typeof usage.totalTokens === "number") run.tokens += usage.totalTokens;

          // A turn cap bounds cost; it does not notice a child spinning —
          // restating the same thing every turn without calling a tool. Stop
          // that early with a reason, rather than letting it run to the cap.
          if (!stallReason && Array.isArray(message.content)) {
            const usedTool = message.content.some((c) => c.type === "toolCall");
            const turnText = message.content
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join("\n");
            const verdict = guard.observe({ text: turnText, usedTool });
            if (verdict.stalled) {
              stallReason = verdict.reason ?? "no progress";
              void session?.abort().catch(() => {});
            }
          }

          renderWidget();
          if (run.turns >= def.maxTurns) {
            void session?.abort().catch(() => {});
          }
        }
      });

      await session.prompt(buildTaskPrompt(run.task), { source: "extension" } as never);

      // The report is the last thing the child SAID, not the last message it
      // sent: after a turn-cap abort or an Esc mid-tool that message is often
      // text-free, and the account it wrote a turn earlier is the one to keep.
      const { text, stopReason } = extractReport(session.messages as ReportMessage[]);

      // A run stopped at its turn cap is not a finished answer. Returning it
      // unmarked reads as complete to whoever asked for it. A run the loop
      // guard stopped is the same: mark it, with the reason, so the parent
      // knows the child gave up rather than concluded.
      const cappedAtTurnLimit = run.turns >= def.maxTurns && stopReason === "aborted";
      run.result = markReport(text, { stallReason, cappedAtTurnLimit, maxTurns: def.maxTurns, agent: def.name });
      // A run the user (or session teardown) already cancelled keeps that
      // verdict and its explanation — the child stopping is the consequence,
      // not a separate outcome.
      // The cast is load-bearing: TypeScript narrowed status at the top of
      // this function, but cancelRun can flip it while we were awaiting.
      const cancelled = (run.status as RunStatus) === "aborted" && run.error !== null;
      if (!cancelled) {
        run.status = stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "done";
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
      steerable.delete(run.id);
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
      // A helper's record is final here. A top-level run's is not — verify,
      // gate and the outcome still have to write into it — so runIt persists
      // that one, once, at the end.
      if (options.persist) persistRun(run);
      renderWidget();
    }
  }

  /** Append the run to the session so agent_result still finds it after /reload. */
  function persistRun(run: RunState): void {
    try {
      pi.appendEntry(RESULT_ENTRY, persistable(run));
    } catch {
      // A /reload or session switch while this child ran invalidates the
      // captured pi handle ("ctx is stale"); the run's result then cannot
      // be persisted, but throwing here would turn a finished child into an
      // unhandled rejection that takes the whole process down.
    }
  }

  function mkRun(id: string, agent: string, task: string): RunState {
    return {
      id,
      agent,
      task,
      background: false,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      tokens: 0,
      turns: 0,
      result: null,
      error: null,
    };
  }

  /**
   * Auto peer-review: after a worker settles with a result, a reviewer child
   * checks it against the task; a failed review sends the worker back for one
   * revision (in the same worktree if isolated). Bounded to a single round so it
   * can never ping-pong, and best-effort — a reviewer that cannot run leaves the
   * result returned-but-unverified rather than failing the whole run.
   */
  async function verifyRun(ctx: UiContext, run: RunState, workerDef: AgentDef, workDir?: string): Promise<void> {
    // The reviewer gets the worker's workDir too: when the worker ran isolated,
    // its changes live in that worktree, and a reviewer pointed at the untouched
    // main checkout would review a diff it cannot see.
    await runVerification(run, workDir, {
      reviewerDef: defs.get("reviewer"),
      workerDef,
      mkRun,
      nextId,
      register: (r) => {
        runs.set(r.id, r);
        renderWidget(ctx);
      },
      runChild: (def, r, wd) => runHelper(ctx, run, def, r, wd),
    });
  }

  /**
   * Spawn a verify/gate helper on the parent's behalf: owned by the parent so
   * Esc reaches it, persisted on its own since nothing settles it later. A
   * parent cancelled between phases — the user pressed Esc while the reviewer
   * was thinking — is no longer "done", and a helper started for it would be
   * a child nobody is waiting for.
   */
  async function runHelper(ctx: UiContext, parent: RunState, def: AgentDef, helper: RunState, workDir?: string): Promise<void> {
    if (parent.status !== "done") {
      helper.status = "aborted";
      helper.finishedAt = Date.now();
      helper.error = `Not started: ${parent.id} was stopped before this pass began.`;
      renderWidget(ctx);
      return;
    }
    // The helper works where its parent did. Recorded so a sibling's gate can
    // tell whether this pass was in its directory — a repair inside a worktree
    // is not sharing the main checkout, and vice versa.
    if (workDir && !helper.workDir) helper.workDir = workDir;
    await runChild(ctx, def, helper, workDir, { owner: parent.id, persist: true });
  }

  /**
   * Run the caller's gate in the tree the child worked in and, if it failed,
   * send the child back to fix it before the result is returned. The verdict is
   * recorded on the run either way — a gate that passed is a fact worth saying,
   * and a gate that could not run says so rather than blaming the work.
   */
  async function gateRun(
    ctx: UiContext,
    run: RunState,
    def: AgentDef,
    contract: GateContract,
    attempts: number,
    canRepair: boolean,
  ): Promise<void> {
    const subject = run.workDir ?? ctx.cwd;
    // A run without a workDir works in the session's cwd, and sharedWith reads
    // an undefined workDir as "wherever the subject is" — which blamed every
    // running non-isolated sibling for an isolated run's worktree.
    const self: GateSibling = { id: 0, label: run.id, status: run.status, workDir: run.workDir ?? ctx.cwd };
    const siblings: GateSibling[] = [...runs.values()]
      .filter((r) => r.id !== run.id)
      .map((r, i) => ({ id: i + 1, label: r.id, status: r.status, workDir: r.workDir ?? ctx.cwd }));

    const { record, verification } = await runGateCycle(run.task, contract, subject, {
      runGate,
      canRepair,
      maxAttempts: attempts,
      sharedWith: sharedWith(self, subject, siblings),
      repair: async (prompt) => {
        const fix = mkRun(nextId(def.name), def.name, prompt);
        runs.set(fix.id, fix);
        renderWidget(ctx);
        await runHelper(ctx, run, def, fix, run.workDir);
        // The repair's own report replaces the stale one: the caller must not
        // be handed a description of a tree that has since changed.
        if (fix.status === "done" && fix.result?.trim()) run.result = fix.result;
      },
    });
    run.gate = record;
    run.verification = verification;
  }

  /**
   * Settle the two facts a caller needs and the status alone cannot give: what
   * the task came to, and how well that is known. Idempotent, and safe to call
   * on a run that never had a gate.
   */
  function settleOutcome(run: RunState): void {
    if (run.status === "running") return;
    // Whatever was still deciding the outcome has now decided it: the run is
    // finished from here, and the widget's clock stops here too.
    if (run.settling) {
      delete run.settling;
      run.finishedAt = Date.now();
    }
    // Settled once and for good: re-running it after the isolation note has
    // been appended would find the declaration already stripped and quietly
    // promote a blocked run to a successful one.
    if (run.outcome) return;
    const declared = parseDeclaredOutcome(run.result);
    if (declared && run.result) run.result = stripDeclaration(run.result);
    run.verification ??= "not-requested";
    run.outcome = deriveOutcome({ status: run.status, declared, verification: run.verification });
  }

  /**
   * Stop a run and the child it started. Both meanings of "stop" — the user's
   * abort and session teardown — come through here; marking the record
   * without aborting the child left it talking to the provider on the user's
   * money, writing into a conversation nobody would read.
   *
   * A settling run is stopped the same way: its own child has finished, but
   * the helpers verifying its work are live under its id, and a stop that
   * left them running would be the same bug one phase later.
   */
  function cancelRun(run: RunState, reason: CancelReason): void {
    const stopped = live.abortRun(run.id);
    if (run.status === "running" || run.settling) {
      run.status = "aborted";
      run.error = cancelNote(reason, stopped);
      settleOutcome(run);
      run.finishedAt = Date.now();
    }
    renderWidget();
  }

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "agent_run",
    label: "Run subagent",
    promptSnippet: "Delegate one self-contained task to a child agent",
    promptGuidelines: [
      "Reach for the smallest delegation that fits: agent_run for one task, swarm_run for many independent ones, workflow when the steps depend on each other.",
    ],
    description:
      "Delegate one scoped task to a child agent. agent: reviewer (read-only review), scout " +
      "(read-only exploration/research), worker (full tools, implements a task), or a custom type " +
      "from .pi/agents/. background=false (default) blocks and returns the child's report; " +
      "background=true returns an id immediately — collect it later with agent_result. " +
      "Write the task as a complete, self-contained brief: the child sees none of this conversation. " +
      "For MUTATING tasks set isolation=worktree: the child gets its own git worktree and branch, the " +
      "main checkout stays untouched, and the report says how to merge or discard. " +
      "Set verify=true for work worth double-checking: the reviewer agent judges the result and, if it finds " +
      "real problems, the worker gets one revision pass before the result is returned. " +
      "Prefer gate for anything that can be checked by running something: the command runs in the child's " +
      "own working directory after it finishes, a failure sends the child back to fix it once, and the " +
      "report says what the check proved instead of only what the child claims.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent type name" }),
      task: Type.String({ description: "Complete task brief for the child" }),
      background: Type.Optional(Type.Boolean({ description: "Run without blocking (default false)" })),
      isolation: Type.Optional(Type.String({ description: "Set to worktree to run in an isolated git worktree (for mutating tasks)" })),
      verify: Type.Optional(
        Type.Boolean({ description: "After the worker finishes, have the reviewer check it and allow one revision (default false)" }),
      ),
      gate: Type.Optional(
        Type.String({
          description:
            "Shell command that must pass for the work to count as verified, e.g. \"bun test\" or \"tsc --noEmit\". Run in the child's working directory once it finishes.",
        }),
      ),
      gateExpect: Type.Optional(
        Type.String({
          description:
            "Regex the gate output must match. Use it when exit 0 does not prove the check ran (e.g. \"[1-9][0-9]* pass\"); exiting 0 without a match is reported as verifying nothing.",
        }),
      ),
      gateRepairs: Type.Optional(
        Type.Number({ description: "Repair passes allowed after a failed gate, 0-5 (default 1)" }),
      ),
    }),
    async execute(
      _id,
      params: {
        agent: string;
        task: string;
        background?: boolean;
        isolation?: string;
        verify?: boolean;
        gate?: string;
        gateExpect?: string;
        gateRepairs?: number;
      },
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

      // A gate is validated up front: a broken contract should be a tool error
      // the caller can fix now, not a "verified nothing" verdict discovered
      // after a child has already spent a full run.
      let gate: GateContract | null = null;
      if (params.gate?.trim()) {
        gate = normalizeGate(params.gate.trim());
        const expect = params.gateExpect?.trim();
        if (expect) {
          try {
            new RegExp(expect, "m");
          } catch {
            throw new Error(`gateExpect is not a valid regular expression: ${expect}`);
          }
          gate.expect = expect;
        }
      } else if (params.gateExpect?.trim()) {
        throw new Error("gateExpect needs a gate command to judge.");
      }

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
        ...(isolation ? { workDir: isolation.path } : {}),
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
        try {
          await acquireSlot();
          try {
            await runChild(uiCtx, def, run, isolation?.path);
          } finally {
            releaseSlot();
          }
          // The child is done; the run is not, if a check was asked for. Until
          // it settles, agent_result and the widget say "verifying" rather than
          // handing out a result the gate may be about to contradict.
          if ((params.verify || gate) && run.status === "done") run.settling = true;
          // Opt-in auto peer-review, before the worktree is cleaned so a revision
          // can still write into it. Best-effort; never fails the run.
          if (params.verify && run.status === "done" && run.result?.trim()) {
            try {
              await verifyRun(uiCtx, run, def, isolation?.path);
            } catch {
              // verification is a convenience; the worker's result already stands
            }
          }
          // The gate runs last and inside the worktree, so it judges the tree the
          // caller will actually merge — after any revision, before cleanup.
          if (gate && run.status === "done") {
            // Read now, while the declaration is still in the report: a child
            // that said it was blocked is not sent on repair passes, but the
            // gate still runs once so the record says what the tree proves.
            const canRepair = repairAllowed(def, run.result);
            try {
              await gateRun(uiCtx, run, def, gate, params.gateRepairs ?? 1, canRepair);
            } catch (err) {
              // A gate that throws proved nothing; say so rather than losing the
              // child's work to an error in the checking machinery.
              run.gate = {
                command: gate.command,
                outcome: "no_attestation",
                ok: false,
                reason: `gate could not be run: ${err instanceof Error ? err.message : String(err)}`,
              };
              run.verification = "inconclusive";
            }
          }
          settleOutcome(run);
          if (isolation) {
            // A worktree the child left untouched is removed with its branch —
            // the common case for a review or a search, and the cleanup all
            // three READMEs promise but none performed: removeIfUnchanged was
            // imported and never called, so every isolated run leaked a
            // directory and an agent/<slug> branch under ~/.worktrees forever.
            // Anything changed or committed is kept, and only then does the
            // merge note make sense.
            const removed = removeIfUnchanged(uiCtx.cwd, isolation);
            if (!removed && run.result !== null) {
              run.result = `${run.result}\n\n${isolationNote(isolation)}`;
            } else if (removed && run.result !== null) {
              run.result = `${run.result}\n\n${CLEAN_WORKTREE_NOTE}`;
            }
          }
        } finally {
          // Once, and last: the record that survives /reload is the settled
          // one, gate and outcome included. In a finally so a cleanup that
          // throws still leaves the run findable afterwards.
          persistRun(run);
        }
      };

      if (background) {
        // v0.2: beyond the concurrency cap runs queue instead of rejecting.
        void runIt()
          .then(() => {
            notify(uiCtx, `subagent ${run.id}: ${run.status}`, run.status === "done" ? "info" : "warning");
            // The report goes to the agent, not just to the screen. Without
            // this its only way to learn the run had finished was to ask
            // again, which is why the not-ready answer can now tell it not to.
            // A finished child arrives as a followUp — it waits politely for
            // the current turn. A FAILED one arrives as a steer: a broken
            // intermediate the leader is likely building on should interrupt
            // now, not sit in the queue until the leader has moved on
            // (arhen/pi-core-subagent's failure-as-interrupt insight).
            const failed = run.status !== "done";
            pi.sendMessage(
              {
                customType: DELIVERY_TYPE,
                content: deliveryMessage(run.id, "subagent", formatRunResult(run)),
                display: true,
                details: { id: run.id, status: run.status, tokens: run.tokens },
              },
              { deliverAs: failed ? "steer" : "followUp", triggerTurn: true },
            );
          })
          .catch(() => {
            // The whole chain, not just sendMessage: a /reload mid-run makes
            // every captured pi/ctx handle throw "ctx is stale", and an
            // uncaught rejection here takes the process down with the run's
            // work. Delivery is a convenience; agent_result still works.
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
    promptSnippet: "Collect the report from a background child agent",
    description:
      "Fetch the report of a background subagent by id (from agent_run). A run whose verify or gate is still " +
      "deciding is reported as not ready, not as done. Set wait (seconds, up to 120) to block up to that long " +
      "for it before answering — useful headless, where nothing is delivered after your turn ends.",
    parameters: Type.Object({
      id: Type.String({ description: "Run id, e.g. reviewer-1" }),
      wait: Type.Optional(
        Type.Number({ description: "Seconds to wait for the run to finish before answering, 0-120 (default 0)" }),
      ),
    }),
    async execute(_id, params: { id: string; wait?: number }, signal, _onUpdate, ctx) {
      const run = runs.get(params.id.trim());
      if (!run) {
        const known = [...runs.keys()].sort().join(", ") || "(none this session)";
        throw new Error(`No run "${params.id}". Known runs: ${known}`);
      }
      const ready = () => run.status !== "running" && !run.settling;
      const waitMs = Math.max(0, Math.min(MAX_WAIT_SECONDS, Number(params.wait) || 0)) * 1000;
      // The tool's own signal stops the wait: Esc must not sit out the budget.
      await waitUntil(ready, waitMs, WAIT_POLL_MS, signal);
      if (!ready()) {
        const interactive = (ctx as { hasUI?: boolean }).hasUI !== false;
        const pending = pendingResult({
          id: run.id,
          kind: "running",
          startedAt: run.startedAt,
          now: Date.now(),
          collectWith: "agent_result",
          interactive,
        });
        // A settling run has a result the caller must not see yet: the gate
        // may be about to contradict it, and a repair pass may replace it.
        const text = [
          pending.text,
          ...(run.settling
            ? ["", `${run.id} has finished its work and is being verified; the report lands once that settles.`]
            : []),
          ...(interactive ? [] : ["", `Or call again with wait: 30 to block up to 30 seconds for it.`]),
        ].join("\n");
        return { content: [{ type: "text", text }], details: pending.details as never };
      }
      return {
        content: [{ type: "text", text: formatRunResult(run) }],
        details: { id: run.id, status: run.status },
      };
    },
  });

  pi.registerTool({
    name: "agent_steer",
    label: "Steer subagent",
    promptSnippet: "Redirect a running background subagent",
    description:
      "Send a steering message to a still-running BACKGROUND subagent (started with agent_run background:true). " +
      "It lands at the child's next step without restarting it — use to add a constraint, correct course, or narrow " +
      "scope mid-run. Only works while the run is live; a finished run is collected with agent_result instead.",
    parameters: Type.Object({
      id: Type.String({ description: "Run id of a running background subagent, e.g. reviewer-1" }),
      message: Type.String({ description: "The steering instruction to inject into the running child" }),
    }),
    async execute(
      _id,
      params: { id: string; message: string },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }> {
      const session = steerable.get(params.id.trim());
      if (!session) {
        const live = [...steerable.keys()].sort().join(", ") || "(none running)";
        return {
          content: [{ type: "text", text: `No running subagent "${params.id}". Live now: ${live}. A finished run is collected with agent_result.` }],
          details: {},
          isError: true,
        };
      }
      const message = String(params.message ?? "").trim();
      if (!message) return { content: [{ type: "text", text: "Empty steering message." }], details: {}, isError: true };
      try {
        await session.steer(message);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Could not steer ${params.id}: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
      const clip = message.length > 60 ? `${message.slice(0, 59)}…` : message;
      return { content: [{ type: "text", text: `Steered ${params.id}: "${clip}". It will pick this up at its next step.` }], details: { id: params.id } };
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
    for (const restored of replayRuns(ctx.sessionManager.getBranch())) runs.set(restored.id, restored);
    // The id counter is memory-only and starts empty on a fresh load; re-seed it
    // past the replayed ids so the first new run does not mint "reviewer-1"/
    // "agent-1" again and overwrite a live entry via runs.set().
    seedCounters(counters, runs.keys());
    renderWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // A child cannot outlive the session that asked for it — nor can the
    // helpers still verifying a child that has.
    for (const run of runs.values()) {
      if (run.status === "running" || run.settling) cancelRun(run, "session-switch");
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
          .map((r) => `${r.id}: ${r.settling ? "verifying" : r.status} (${r.turns} turns, ${r.tokens} tok)`)
          .join("\n") || "(no runs yet)";
      ctx.ui.notify(
        `Agent types\n${describeDefs([...defs.values()])}\n\nRuns\n${runLines}\n\nCustom types: .pi/agents/<name>.md`,
        "info",
      );
    },
  });
}
