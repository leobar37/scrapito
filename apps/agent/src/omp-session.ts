import {
  createAgentSession,
  SessionManager,
  Settings,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
} from "@oh-my-pi/pi-coding-agent";
import type { SettingsOptions } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRuntimeError } from "./errors.ts";
import { createBusinessTools, type DecisionCapture } from "./tools.ts";
import type { AgentSessionRunner, LlmUsage, SessionRunInput, SessionRunOutput } from "./types.ts";

interface UsageShape {
  input: number;
  output: number;
  cost: { total: number };
}

function isUsage(value: unknown): value is UsageShape {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UsageShape>;
  return (
    typeof candidate.input === "number" &&
    typeof candidate.output === "number" &&
    !!candidate.cost &&
    typeof candidate.cost.total === "number"
  );
}

function collectUsage(value: unknown, seen = new WeakSet<object>()): LlmUsage {
  const total: LlmUsage = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  if (!value || typeof value !== "object" || seen.has(value)) return total;
  seen.add(value);
  if (isUsage(value)) {
    return { requests: 1, inputTokens: value.input, outputTokens: value.output, costUsd: value.cost.total };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const usage = collectUsage(item, seen);
      total.requests += usage.requests;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.costUsd += usage.costUsd;
    }
    return total;
  }
  for (const child of Object.values(value)) {
    const usage = collectUsage(child, seen);
    total.requests += usage.requests;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.costUsd += usage.costUsd;
  }
  return total;
}

function assertUsageWithinCaps(usage: LlmUsage, input: SessionRunInput): void {
  const limits: Array<[boolean, string, number, number]> = [
    [usage.requests <= input.config.caps.maxLlmRequests, "REQUEST_BUDGET_EXCEEDED", usage.requests, input.config.caps.maxLlmRequests],
    [usage.costUsd <= input.config.caps.maxCostUsd, "COST_BUDGET_EXCEEDED", usage.costUsd, input.config.caps.maxCostUsd],
    [usage.inputTokens <= input.config.caps.maxInputTokens, "INPUT_TOKEN_BUDGET_EXCEEDED", usage.inputTokens, input.config.caps.maxInputTokens],
    [usage.outputTokens <= input.config.caps.maxOutputTokens, "OUTPUT_TOKEN_BUDGET_EXCEEDED", usage.outputTokens, input.config.caps.maxOutputTokens],
  ];
  for (const [ok, code, observed, hard] of limits) {
    if (!ok) throw new AgentRuntimeError(code, `${code}: ${observed} > ${hard}`, { observed, hard });
  }
}

type OmpSettingsLoader = (options: SettingsOptions) => Promise<Settings>;

const loadOmpSettings: OmpSettingsLoader = options => Settings.loadReadOnly(options);

/**
 * Keeps invocation behavior isolated while inheriting the current user's OMP
 * config. AuthStorage and ModelRegistry are intentionally omitted: OMP 17.0.4
 * then discovers its standard broker/local agent.db auth and models.yml registry.
 */
export async function createOmpSessionOptions(
  cwd: string,
  input: SessionRunInput,
  capture: DecisionCapture,
  settingsLoader: OmpSettingsLoader = loadOmpSettings,
): Promise<CreateAgentSessionOptions> {
  const settings = await settingsLoader({
    cwd,
    overrides: {
      "async.enabled": false,
      "compaction.enabled": false,
      "retry.enabled": false,
      "task.batch": true,
      "task.isolation.mode": "none",
      "task.maxConcurrency": input.config.caps.maxConcurrency,
      "task.maxRecursionDepth": input.config.caps.maxDepth,
      "task.maxRuntimeMs": input.config.caps.maxRuntimeMs,
      "task.softRequestBudget": 2,
      "task.softRequestBudgetNotice": true,
      "task.agentModelOverrides": {
        "site-agent": input.config.models.siteAgent,
        "repair-agent": input.config.models.repairAgent,
        verifier: input.config.models.verifier,
      },
    },
  });

  return {
    cwd,
    modelPattern: input.config.models.coordinator,
    deadline: Date.now() + input.config.caps.maxRuntimeMs,
    settings,
    sessionManager: SessionManager.inMemory(cwd),
    systemPrompt: [input.composition.prompt],
    customTools: createBusinessTools(input.composition, capture),
    toolNames: ["task", "invocation_context", "submit_invocation_action"],
    restrictToolNames: true,
    spawns: "site-agent,repair-agent,verifier",
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    disableExtensionDiscovery: true,
    preloadedCustomToolPaths: [],
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    hasUI: false,
  };
}

export class OmpAgentSessionRunner implements AgentSessionRunner {
  constructor(private readonly cwd: string) {}

  async run(input: SessionRunInput): Promise<SessionRunOutput> {
    const capture: DecisionCapture = {};
    const { session } = await createAgentSession(
      await createOmpSessionOptions(this.cwd, input, capture),
    );

    let liveBudgetError: AgentRuntimeError | undefined;
    let liveUsage: LlmUsage = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const usage = collectUsage(event.message.usage);
      liveUsage = {
        requests: liveUsage.requests + 1,
        inputTokens: liveUsage.inputTokens + usage.inputTokens,
        outputTokens: liveUsage.outputTokens + usage.outputTokens,
        costUsd: liveUsage.costUsd + usage.costUsd,
      };
      try {
        assertUsageWithinCaps(liveUsage, input);
      } catch (error) {
        liveBudgetError = error instanceof AgentRuntimeError ? error : new AgentRuntimeError("BUDGET_EXCEEDED", String(error));
        void session.abort({ goalReason: "internal", reason: liveBudgetError.message });
      }
    });
    const abortFromHost = () => void session.abort({ goalReason: "internal", reason: "host runtime aborted" });
    input.signal.addEventListener("abort", abortFromHost, { once: true });

    try {
      const accepted = await session.prompt(input.composition.prompt, { expandPromptTemplates: false });
      if (!accepted) throw new AgentRuntimeError("OMP_REJECTED_PROMPT", "OMP session did not accept the invocation prompt");
      if (input.signal.aborted) throw input.signal.reason;
      if (liveBudgetError) throw liveBudgetError;
      if (!capture.decision) throw new AgentRuntimeError("MISSING_ACTION", "OMP session ended without one typed action");

      const usage = collectUsage(session.messages);
      assertUsageWithinCaps(usage, input);
      return {
        decision: capture.decision,
        usage,
        modelsUsed: [
          input.config.models.coordinator,
          input.config.models.siteAgent,
          input.config.models.repairAgent,
          input.config.models.verifier,
        ],
      };
    } finally {
      input.signal.removeEventListener("abort", abortFromHost);
      unsubscribe();
      await session.dispose();
    }
  }
}

export class DeterministicSessionRunner implements AgentSessionRunner {
  constructor(
    private readonly output: Partial<SessionRunOutput> = {},
    private readonly delayMs = 0,
  ) {}

  async run(input: SessionRunInput): Promise<SessionRunOutput> {
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    if (input.signal.aborted) throw input.signal.reason;
    return {
      decision: this.output.decision ?? {
        action: "ingest",
        summary: "deterministic supported invocation",
        evidenceIds: [...input.composition.evidence],
        actionId: `fake-${input.composition.invocation.invocationId}`,
      },
      usage: this.output.usage ?? { requests: 1, inputTokens: 100, outputTokens: 25, costUsd: 0.001 },
      modelsUsed: this.output.modelsUsed ?? ["fake/deterministic"],
    };
  }
}
