import { compact, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  loadSettings,
  getReviewPrompt,
  type ReviewerLoopSettings,
  type ReviewInterruptBehavior,
  type ReviewPromptConfig,
} from "./settings.js";

const STATE_ENTRY = "review-loop-state";
const REVIEW_PROMPT_MESSAGE_TYPE = "review-loop-prompt";
const REVIEW_PASS_NOTE_MESSAGE_TYPE = "review-loop-pass-note";

type ReviewPromptKind = "code" | "plan";

type ReviewLoopState = {
  active: boolean;
  paused: boolean;
  pendingResume: boolean;
  awaitingReviewTurn: boolean;
  currentIteration: number;
  maxIterations: number;
  autoTrigger: boolean;
  freshContext: boolean;
  interruptBehavior: ReviewInterruptBehavior;
  customPromptSuffix: string;
  activePromptConfig: ReviewPromptConfig;
  activePromptKind: ReviewPromptKind;
};

type PersistedReviewLoopState = Partial<ReviewLoopState> & {
  version?: number;
};

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && "type" in block && block.type === "text";
    })
    .map((block) => block.text)
    .join("\n");
}

function parseCustomText(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "";

  const match = trimmed.match(/^"(.+)"$/s) || trimmed.match(/^'(.+)'$/s);
  return match ? match[1].trim() : trimmed;
}

function normalizePromptConfig(value: unknown, fallback: ReviewPromptConfig): ReviewPromptConfig {
  if (!value || typeof value !== "object") return fallback;

  const candidate = value as { type?: unknown; value?: unknown };
  if (
    (candidate.type === "inline" || candidate.type === "file" || candidate.type === "template") &&
    typeof candidate.value === "string"
  ) {
    return { type: candidate.type, value: candidate.value };
  }

  return fallback;
}

function normalizeInterruptBehavior(
  value: unknown,
  fallback: ReviewInterruptBehavior
): ReviewInterruptBehavior {
  return value === "stop" ? "stop" : fallback;
}

function normalizeIteration(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function isReviewPromptMessage(message: any): boolean {
  return message?.role === "custom" && message?.customType === REVIEW_PROMPT_MESSAGE_TYPE;
}

function isPreservedFreshContextMessage(message: any): boolean {
  if (isReviewPromptMessage(message)) return false;
  if (message?.role === "assistant") return false;
  if (message?.role === "toolResult") return false;
  return true;
}

function getLastAssistantSummary(messages: any[]): {
  hasAssistant: boolean;
  text: string;
  aborted: boolean;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;

    return {
      hasAssistant: true,
      text: extractTextFromContent(message.content),
      aborted: message.stopReason === "aborted",
    };
  }

  return {
    hasAssistant: false,
    text: "",
    aborted: false,
  };
}

export default function (pi: ExtensionAPI) {
  let settings: ReviewerLoopSettings = loadSettings();

  function createInitialState(config: ReviewerLoopSettings): ReviewLoopState {
    return {
      active: false,
      paused: false,
      pendingResume: false,
      awaitingReviewTurn: false,
      currentIteration: 0,
      maxIterations: config.maxIterations,
      autoTrigger: config.autoTrigger,
      freshContext: config.freshContext,
      interruptBehavior: config.interruptBehavior,
      customPromptSuffix: "",
      activePromptConfig: config.reviewPromptConfig,
      activePromptKind: "code",
    };
  }

  let state: ReviewLoopState = createInitialState(settings);

  // Guard flag: set before pi.sendMessage so the input handler knows
  // the next input event is our own review prompt, not a user interrupt.
  let sendingReviewPrompt = false;

  function getSessionScopedState(): Pick<
    ReviewLoopState,
    "maxIterations" | "autoTrigger" | "freshContext" | "interruptBehavior"
  > {
    return {
      maxIterations: state.maxIterations,
      autoTrigger: state.autoTrigger,
      freshContext: state.freshContext,
      interruptBehavior: state.interruptBehavior,
    };
  }

  function createInactiveState(): ReviewLoopState {
    return {
      ...createInitialState(settings),
      ...getSessionScopedState(),
    };
  }

  function restoreState(ctx: ExtensionContext) {
    settings = loadSettings();
    const defaults = createInitialState(settings);

    let persisted: PersistedReviewLoopState | undefined;
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as { type?: string; customType?: string; data?: PersistedReviewLoopState };
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
        persisted = entry.data;
        break;
      }
    }

    if (!persisted) {
      state = defaults;
      updateStatus(ctx);
      return;
    }

    const active = persisted.active === true;
    state = {
      active,
      paused: active ? persisted.paused === true : false,
      pendingResume: active ? persisted.pendingResume === true : false,
      awaitingReviewTurn: active ? persisted.awaitingReviewTurn === true : false,
      currentIteration: active ? normalizeIteration(persisted.currentIteration) : 0,
      maxIterations: normalizePositiveNumber(persisted.maxIterations, defaults.maxIterations),
      autoTrigger: typeof persisted.autoTrigger === "boolean" ? persisted.autoTrigger : defaults.autoTrigger,
      freshContext: typeof persisted.freshContext === "boolean" ? persisted.freshContext : defaults.freshContext,
      interruptBehavior: normalizeInterruptBehavior(
        persisted.interruptBehavior,
        defaults.interruptBehavior
      ),
      customPromptSuffix: active && typeof persisted.customPromptSuffix === "string"
        ? persisted.customPromptSuffix
        : "",
      activePromptConfig: active
        ? normalizePromptConfig(persisted.activePromptConfig, defaults.activePromptConfig)
        : defaults.activePromptConfig,
      activePromptKind: active && persisted.activePromptKind === "plan" ? "plan" : "code",
    };

    updateStatus(ctx);
  }

  function persistState(ctx?: ExtensionContext) {
    pi.appendEntry(STATE_ENTRY, {
      version: 1,
      ...state,
    } satisfies PersistedReviewLoopState);

    if (ctx) updateStatus(ctx);
  }

  function notify(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error" = "info"
  ) {
    if (!ctx.hasUI) return;
    ctx.ui.notify(message, level);
  }

  function nextPassNumber(): number {
    return Math.min(state.currentIteration + 1, state.maxIterations);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    if (!state.active) {
      ctx.ui.setStatus("review-loop", undefined);
      return;
    }

    const parts = [`Review mode (${nextPassNumber()}/${state.maxIterations})`];
    if (state.paused) parts.push(state.pendingResume ? "paused → resume" : "paused");
    if (state.freshContext) parts.push("fresh");
    if (state.activePromptKind === "plan") parts.push("plan");
    ctx.ui.setStatus("review-loop", parts.join(" | "));
  }

  function buildReviewPrompt(promptConfig: ReviewPromptConfig): string {
    const basePrompt = getReviewPrompt(promptConfig);
    if (state.customPromptSuffix) {
      return `${basePrompt}\n\n**Additional focus:** ${state.customPromptSuffix}`;
    }
    return basePrompt;
  }

  function getPromptConfigForKind(kind: ReviewPromptKind): ReviewPromptConfig {
    return kind === "plan"
      ? { type: "template", value: "double-check-plan" }
      : settings.reviewPromptConfig;
  }

  function getStateSnapshot(message: string) {
    return {
      active: state.active,
      paused: state.paused,
      pendingResume: state.pendingResume,
      awaitingReviewTurn: state.awaitingReviewTurn,
      currentIteration: state.currentIteration,
      nextIteration: state.active ? nextPassNumber() : 0,
      maxIterations: state.maxIterations,
      autoTrigger: state.autoTrigger,
      freshContext: state.freshContext,
      interruptBehavior: state.interruptBehavior,
      focus: state.customPromptSuffix || undefined,
      promptType: state.activePromptKind,
      message,
    };
  }

  function deactivateReview(ctx: ExtensionContext, reason: string) {
    state = createInactiveState();
    persistState(ctx);
    notify(ctx, `Review mode ended: ${reason}`, "info");
  }

  function pauseReview(ctx: ExtensionContext, reason: string, pendingResume: boolean) {
    if (!state.active) return;

    state = {
      ...state,
      paused: true,
      pendingResume,
      awaitingReviewTurn: false,
    };
    persistState(ctx);
    notify(ctx, reason, "info");
  }

  function startReview(
    ctx: ExtensionContext,
    promptKind: ReviewPromptKind,
    focus: string,
    autoTriggered: boolean
  ) {
    state = {
      ...state,
      active: true,
      paused: false,
      pendingResume: false,
      awaitingReviewTurn: autoTriggered,
      currentIteration: 0,
      customPromptSuffix: focus,
      activePromptConfig: getPromptConfigForKind(promptKind),
      activePromptKind: promptKind,
    };
    persistState(ctx);
    notify(ctx, autoTriggered ? "Review mode activated (auto-trigger)" : "Review mode activated", "info");
  }

  function sendReviewPrompt(ctx: ExtensionContext, delivery: "steer" | "followUp" = "followUp") {
    if (!state.active) return;

    state = {
      ...state,
      paused: false,
      pendingResume: false,
      awaitingReviewTurn: true,
    };
    persistState(ctx);

    const message = {
      customType: REVIEW_PROMPT_MESSAGE_TYPE,
      content: buildReviewPrompt(state.activePromptConfig),
      display: true,
      details: {
        iteration: nextPassNumber(),
        maxIterations: state.maxIterations,
        promptType: state.activePromptKind,
        focus: state.customPromptSuffix || undefined,
      },
    };

    sendingReviewPrompt = true;
    if (ctx.isIdle()) {
      pi.sendMessage(message, { triggerTurn: true });
    } else {
      pi.sendMessage(message, {
        triggerTurn: true,
        deliverAs: delivery,
      });
    }
    sendingReviewPrompt = false;
  }

  function resumeReview(
    ctx: ExtensionContext,
    reason: string,
    delivery: "steer" | "followUp" = "followUp"
  ) {
    if (!state.active) return;

    if (ctx.hasPendingMessages()) {
      state = {
        ...state,
        paused: true,
        pendingResume: true,
        awaitingReviewTurn: false,
      };
      persistState(ctx);
      return;
    }

    notify(ctx, reason, "info");
    sendReviewPrompt(ctx, delivery);
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreState(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    restoreState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreState(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    restoreState(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") {
      return { action: "continue" as const };
    }

    // Skip input events triggered by our own sendMessage calls
    if (sendingReviewPrompt) {
      return { action: "continue" as const };
    }

    if (!state.active) {
      return { action: "continue" as const };
    }

    const isTrigger = state.autoTrigger && settings.triggerPatterns.some((pattern) => pattern.test(event.text));
    if (isTrigger) {
      return { action: "continue" as const };
    }

    if (state.interruptBehavior === "stop") {
      deactivateReview(ctx, "user interrupted");
      return { action: "continue" as const };
    }

    pauseReview(ctx, "Review paused for user input", true);
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (state.active) return;
    if (!state.autoTrigger) return;

    const isTrigger = settings.triggerPatterns.some((pattern) => pattern.test(event.prompt));
    if (!isTrigger) return;

    startReview(ctx, "code", "", true);

    return {
      message: {
        customType: REVIEW_PROMPT_MESSAGE_TYPE,
        content: "[Review loop active. Treat the current user prompt as review pass 1.]",
        display: false,
        details: {
          iteration: 1,
          maxIterations: state.maxIterations,
          promptType: "code",
          autoTriggered: true,
        },
      },
    };
  });

  pi.on("context", async (event) => {
    if (!state.active || !state.freshContext) return;

    const promptIndexes: number[] = [];
    for (let i = 0; i < event.messages.length; i++) {
      if (isReviewPromptMessage(event.messages[i])) {
        promptIndexes.push(i);
      }
    }

    if (promptIndexes.length <= 1) return;

    const firstPromptIndex = promptIndexes[0];
    const lastPromptIndex = promptIndexes[promptIndexes.length - 1];
    const baseMessages = event.messages.slice(0, firstPromptIndex);
    const preservedMessages = event.messages
      .slice(firstPromptIndex, lastPromptIndex)
      .filter(isPreservedFreshContextMessage);
    const currentIterationMessages = event.messages.slice(lastPromptIndex);

    const passNote = {
      role: "custom",
      customType: REVIEW_PASS_NOTE_MESSAGE_TYPE,
      content: `[Review pass ${nextPassNumber()}. ${state.currentIteration} prior pass(es) completed. Re-read any relevant plan, spec, PRD, or progress documents before reviewing again. Use the code on disk as the source of truth.]`,
      display: false,
      timestamp: Date.now(),
    } as any;

    return {
      messages: [
        ...baseMessages,
        ...preservedMessages,
        passNote,
        ...currentIterationMessages,
      ],
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state.active) return;

    const wasReviewTurn = state.awaitingReviewTurn || event.messages.some(isReviewPromptMessage);
    if (!wasReviewTurn) {
      if (state.pendingResume && !ctx.hasPendingMessages()) {
        resumeReview(ctx, "Resuming review", "followUp");
      }
      return;
    }

    state = {
      ...state,
      awaitingReviewTurn: false,
    };
    persistState(ctx);

    const lastAssistant = getLastAssistantSummary(event.messages as any[]);
    if (!lastAssistant.hasAssistant || lastAssistant.aborted || !lastAssistant.text.trim()) {
      if (state.pendingResume) {
        state = {
          ...state,
          paused: true,
          awaitingReviewTurn: false,
        };
        persistState(ctx);
        return;
      }

      if (state.paused) {
        persistState(ctx);
        return;
      }

      pauseReview(
        ctx,
        "Review paused after an interruption. Use /review-resume to continue.",
        false
      );
      return;
    }

    const hasExitPhrase = settings.exitPatterns.some((pattern) => pattern.test(lastAssistant.text));
    const hasIssuesFixed = settings.issuesFixedPatterns.some((pattern) => pattern.test(lastAssistant.text));

    if (hasExitPhrase && !hasIssuesFixed) {
      deactivateReview(ctx, "no issues found");
      return;
    }

    state = {
      ...state,
      currentIteration: state.currentIteration + 1,
      paused: false,
      pendingResume: false,
    };

    if (state.currentIteration >= state.maxIterations) {
      deactivateReview(ctx, `max iterations (${state.maxIterations}) reached`);
      return;
    }

    persistState(ctx);

    if (ctx.hasPendingMessages()) {
      state = {
        ...state,
        paused: true,
        pendingResume: true,
        awaitingReviewTurn: false,
      };
      persistState(ctx);
      return;
    }

    sendReviewPrompt(ctx, "followUp");
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!state.active || !ctx.model) return;

    const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
    if (!apiKey) return;

    const instructions = [
      event.customInstructions,
      `A review loop is active. Preserve that state in the summary.`,
      `Current review pass: ${nextPassNumber()} of ${state.maxIterations}.`,
      state.paused
        ? state.pendingResume
          ? `The review is currently paused while another user message runs, then it should resume.`
          : `The review is currently paused and should remain resumable.`
        : `The review should continue after the next review response unless it concludes with no issues found.`,
      state.customPromptSuffix ? `Current review focus: ${state.customPromptSuffix}` : undefined,
      state.activePromptKind === "plan"
        ? `This is a plan/spec review loop, not an implementation review loop.`
        : `This is a code review loop over recent changes.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const compaction = await compact(event.preparation, ctx.model, apiKey, instructions, event.signal);
      return { compaction };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[review-loop] Compaction failed: ${message}\n`);
      notify(ctx, `Review compaction failed: ${message}`, "warning");
      return;
    }
  });

  pi.registerCommand("review-start", {
    description: "Activate review loop with optional custom focus text.",
    handler: async (args, ctx) => {
      const focus = parseCustomText(args);

      if (state.active) {
        if (focus) {
          state = {
            ...state,
            customPromptSuffix: focus,
            activePromptConfig: getPromptConfigForKind("code"),
            activePromptKind: "code",
          };
          persistState(ctx);
        }

        if (state.paused || state.pendingResume) {
          resumeReview(ctx, "Review resumed", "followUp");
        } else {
          notify(ctx, focus ? "Review focus updated" : "Review mode is already active", "info");
        }
        return;
      }

      startReview(ctx, "code", focus, false);
      sendReviewPrompt(ctx);
    },
  });

  pi.registerCommand("review-plan", {
    description: "Activate review loop for plans/specs/PRDs with optional custom focus text.",
    handler: async (args, ctx) => {
      const focus = parseCustomText(args);

      if (state.active) {
        if (focus) {
          state = {
            ...state,
            customPromptSuffix: focus,
            activePromptConfig: getPromptConfigForKind("plan"),
            activePromptKind: "plan",
          };
          persistState(ctx);
        }

        if (state.paused || state.pendingResume) {
          resumeReview(ctx, "Plan review resumed", "followUp");
        } else {
          notify(ctx, focus ? "Plan review focus updated" : "Review mode is already active", "info");
        }
        return;
      }

      startReview(ctx, "plan", focus, false);
      sendReviewPrompt(ctx);
    },
  });

  pi.registerCommand("review-pause", {
    description: "Pause the current review loop without clearing its state.",
    handler: async (_args, ctx) => {
      if (!state.active) {
        notify(ctx, "Review mode is not active", "info");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.abort();
      }
      pauseReview(ctx, "Review paused", false);
    },
  });

  pi.registerCommand("review-resume", {
    description: "Resume a paused review loop with optional updated focus text.",
    handler: async (args, ctx) => {
      if (!state.active) {
        notify(ctx, "Review mode is not active", "info");
        return;
      }

      const focus = parseCustomText(args);
      if (focus) {
        state = {
          ...state,
          customPromptSuffix: focus,
        };
        persistState(ctx);
      }

      if (!state.paused && !state.pendingResume) {
        notify(ctx, "Review mode is already running", "info");
        return;
      }

      if (!ctx.isIdle()) {
        state = {
          ...state,
          paused: true,
          pendingResume: true,
          awaitingReviewTurn: false,
        };
        persistState(ctx);
        notify(ctx, "Review will resume after the current message", "info");
        return;
      }

      resumeReview(ctx, "Review resumed", "followUp");
    },
  });

  pi.registerCommand("review-max", {
    description: "Set max review iterations (default: 7)",
    handler: async (args, ctx) => {
      const num = parseInt(args, 10);
      if (Number.isNaN(num) || num < 1) {
        notify(ctx, "Usage: /review-max <number>", "error");
        return;
      }

      state = {
        ...state,
        maxIterations: num,
      };
      persistState(ctx);
      notify(ctx, `Max review iterations set to ${state.maxIterations}`, "info");
    },
  });

  pi.registerCommand("review-exit", {
    description: "Exit review mode manually",
    handler: async (_args, ctx) => {
      if (!state.active) {
        notify(ctx, "Review mode is not active", "info");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.abort();
      }
      deactivateReview(ctx, "manual exit");
    },
  });

  pi.registerCommand("review-status", {
    description: "Show review mode status",
    handler: async (_args, ctx) => {
      if (state.active) {
        const parts = [`iteration ${nextPassNumber()}/${state.maxIterations}`];
        if (state.paused) parts.push(state.pendingResume ? "paused, auto-resume queued" : "paused");
        if (state.freshContext) parts.push("fresh context");
        parts.push(`interrupt: ${state.interruptBehavior}`);
        parts.push(state.activePromptKind === "plan" ? "plan review" : "code review");
        notify(ctx, `Review mode active: ${parts.join(", ")}`, "info");
      } else {
        notify(
          ctx,
          `Review mode inactive (max: ${state.maxIterations}, auto-trigger: ${state.autoTrigger ? "on" : "off"}, fresh: ${state.freshContext ? "on" : "off"}, interrupt: ${state.interruptBehavior})`,
          "info"
        );
      }
    },
  });

  pi.registerCommand("review-auto", {
    description: "Toggle auto-trigger, or start review with custom focus: /review-auto focus on X",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const argLower = arg.toLowerCase();

      if (argLower === "on" || argLower === "true" || argLower === "1") {
        state = {
          ...state,
          autoTrigger: true,
        };
        persistState(ctx);
        notify(ctx, "Auto-trigger enabled", "info");
        return;
      }

      if (argLower === "off" || argLower === "false" || argLower === "0") {
        state = {
          ...state,
          autoTrigger: false,
        };
        persistState(ctx);
        notify(ctx, "Auto-trigger disabled", "info");
        return;
      }

      if (arg === "") {
        state = {
          ...state,
          autoTrigger: !state.autoTrigger,
        };
        persistState(ctx);
        notify(ctx, `Auto-trigger ${state.autoTrigger ? "enabled" : "disabled"}`, "info");
        return;
      }

      state = {
        ...state,
        autoTrigger: true,
        customPromptSuffix: parseCustomText(arg),
      };
      persistState(ctx);

      if (state.active) {
        notify(ctx, "Auto-trigger enabled, focus updated", "info");
        return;
      }

      startReview(ctx, "code", state.customPromptSuffix, false);
      sendReviewPrompt(ctx);
      notify(ctx, "Auto-trigger enabled, review started with custom focus", "info");
    },
  });

  pi.registerCommand("review-fresh", {
    description: "Toggle fresh context mode for review iterations",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      let freshContext = state.freshContext;
      if (arg === "on" || arg === "true" || arg === "1") {
        freshContext = true;
      } else if (arg === "off" || arg === "false" || arg === "0") {
        freshContext = false;
      } else {
        freshContext = !freshContext;
      }

      state = {
        ...state,
        freshContext,
      };
      persistState(ctx);
      notify(ctx, `Fresh context ${state.freshContext ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerCommand("review-interrupt", {
    description: "Set interrupt behavior: pause (default) or stop",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode !== "pause" && mode !== "stop") {
        notify(ctx, "Usage: /review-interrupt <pause|stop>", "error");
        return;
      }

      state = {
        ...state,
        interruptBehavior: mode,
      };
      persistState(ctx);
      notify(ctx, `Interrupt behavior set to ${mode}`, "info");
    },
  });

  pi.registerTool({
    name: "review_loop",
    description:
      "Control the automated code review loop. Start, pause, resume, or stop review mode, adjust settings, or check status.",
    promptSnippet:
      "Control the automated code review loop. Start/stop review mode, toggle auto-trigger, or check status. When started, the loop repeatedly prompts for code review until 'No issues found' or max iterations reached.",
    promptGuidelines: [
      "When started, the loop repeatedly prompts for code review until 'No issues found' or max iterations reached.",
    ],
    parameters: Type.Object({
      start: Type.Optional(
        Type.Boolean({
          description: "Start review mode and send the review prompt",
        })
      ),
      stop: Type.Optional(
        Type.Boolean({
          description: "Stop review mode",
        })
      ),
      pause: Type.Optional(
        Type.Boolean({
          description: "Pause review mode without clearing its state",
        })
      ),
      resume: Type.Optional(
        Type.Boolean({
          description: "Resume a paused review mode",
        })
      ),
      autoTrigger: Type.Optional(
        Type.Boolean({
          description: "Enable/disable auto-trigger from keywords (disabled by default)",
        })
      ),
      maxIterations: Type.Optional(
        Type.Number({
          description: "Set max iterations (can be combined with start)",
          minimum: 1,
        })
      ),
      focus: Type.Optional(
        Type.String({
          description: "Custom focus/instructions to append to the review prompt (e.g., \"focus on error handling\")",
        })
      ),
      freshContext: Type.Optional(
        Type.Boolean({
          description: "Enable/disable fresh context mode (strips prior review iterations from context)",
        })
      ),
      promptType: Type.Optional(
        Type.String({
          description: "Prompt type to use when starting/resuming the review ('code' or 'plan')",
        })
      ),
      interruptBehavior: Type.Optional(
        Type.String({
          description: "What to do when the user interrupts an active review ('pause' or 'stop')",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (typeof params.maxIterations === "number" && params.maxIterations >= 1) {
        state = {
          ...state,
          maxIterations: Math.floor(params.maxIterations),
        };
      }

      if (typeof params.autoTrigger === "boolean") {
        state = {
          ...state,
          autoTrigger: params.autoTrigger,
        };
      }

      if (typeof params.focus === "string") {
        state = {
          ...state,
          customPromptSuffix: params.focus.trim(),
        };
      }

      if (typeof params.freshContext === "boolean") {
        state = {
          ...state,
          freshContext: params.freshContext,
        };
      }

      if (params.interruptBehavior === "pause" || params.interruptBehavior === "stop") {
        state = {
          ...state,
          interruptBehavior: params.interruptBehavior,
        };
      }

      const promptKind: ReviewPromptKind = params.promptType === "plan" ? "plan" : "code";
      if (params.promptType === "code" || params.promptType === "plan") {
        state = {
          ...state,
          activePromptKind: promptKind,
          activePromptConfig: getPromptConfigForKind(promptKind),
        };
      }

      persistState(ctx);

      if (params.start) {
        if (state.active) {
          if (state.paused || state.pendingResume) {
            resumeReview(ctx, "Review resumed", "followUp");
            return {
              content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode resumed")) }],
            };
          }

          return {
            content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode is already active")) }],
          };
        }

        startReview(ctx, promptKind, state.customPromptSuffix, false);
        sendReviewPrompt(ctx);
        return {
          content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode started. Review prompt sent.")) }],
        };
      }

      if (params.resume) {
        if (!state.active) {
          return {
            content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode is not active")) }],
          };
        }

        if (!state.paused && !state.pendingResume) {
          return {
            content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode is already running")) }],
          };
        }

        resumeReview(ctx, "Review resumed", "followUp");
        return {
          content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode resumed")) }],
        };
      }

      if (params.pause) {
        if (!state.active) {
          return {
            content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode is not active")) }],
          };
        }

        pauseReview(ctx, "Review paused", false);
        return {
          content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode paused")) }],
        };
      }

      if (params.stop) {
        if (!state.active) {
          return {
            content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode is not active")) }],
          };
        }

        deactivateReview(ctx, "stopped by agent");
        return {
          content: [{ type: "text", text: JSON.stringify(getStateSnapshot("Review mode stopped")) }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(getStateSnapshot(state.active ? "Review mode active" : "Review mode inactive")) }],
      };
    },
  });
}
