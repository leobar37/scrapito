import type {
  CapabilityDefinition,
  InvocationContext,
  InvocationResult,
  SiteDefinition,
  StrategyDefinition,
} from "@scrapito/contracts";

export const INVOCATION_STATES = [
  "accepted",
  "preflight",
  "analyzing",
  "waiting_write",
  "executing",
  "evaluating",
  "terminal",
  "requested",
  "classified",
  "reproduced",
  "candidate_created",
  "patched_in_worktree",
  "offline_verified",
  "worktree_canary_passed",
  "independently_verified",
  "awaiting_approval",
  "approved",
  "promoted",
  "production_canary",
  "healthy",
  "rejected",
  "rolled_back",
  "escalated",
] as const;
export type InvocationState = (typeof INVOCATION_STATES)[number];

export interface Composition {
  invocation: InvocationContext;
  site: SiteDefinition;
  strategy: StrategyDefinition;
  capability: CapabilityDefinition;
  evidence: readonly string[];
  prompt: string;
}

export interface ModelProfiles {
  coordinator: string;
  siteAgent: string;
  repairAgent: string;
  verifier: string;
}

export interface HostCaps {
  maxConcurrency: 3;
  maxDepth: 2;
  maxRuntimeMs: number;
  maxLlmRequests: number;
  maxCostUsd: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface AgentConfig {
  models: ModelProfiles;
  caps: HostCaps;
}

export interface LlmUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type AgentAction = "ingest" | "defer" | "reject";

export interface AgentDecision {
  action: AgentAction;
  summary: string;
  evidenceIds: string[];
  actionId: string;
}

export interface AuditRecord {
  timestamp: string;
  invocationId: string;
  site: InvocationContext["site"];
  strategy: InvocationContext["strategy"];
  capability: InvocationContext["intent"];
  state: InvocationState;
  model: string;
  usage: LlmUsage;
  evidenceIds: string[];
  actionId: string | null;
  detail: string;
}

export interface SessionRunInput {
  composition: Composition;
  config: AgentConfig;
  signal: AbortSignal;
}

export interface SessionRunOutput {
  decision: AgentDecision;
  usage: LlmUsage;
  modelsUsed: string[];
}

export interface AgentSessionRunner {
  run(input: SessionRunInput): Promise<SessionRunOutput>;
}

export interface IngestExecutor {
  execute(invocation: InvocationContext, signal: AbortSignal): Promise<InvocationResult>;
}

export interface RepairInvocationExecutor {
  execute(composition: Composition): Promise<InvocationExecution>;
}

export interface InvocationExecution {
  result: InvocationResult;
  audit: readonly AuditRecord[];
  states: readonly InvocationState[];
}
