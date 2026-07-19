import { z } from "zod";
import { AgentRuntimeError } from "./errors.ts";
import type { AgentConfig, HostCaps, ModelProfiles } from "./types.ts";

export const HARD_CAPS = Object.freeze({
  maxConcurrency: 3 as const,
  maxDepth: 2 as const,
  maxRuntimeMs: 60 * 60 * 1_000,
  maxLlmRequests: 16,
  maxCostUsd: 0.5,
  maxInputTokens: 200_000,
  maxOutputTokens: 40_000,
});

const DEFAULT_MODELS: ModelProfiles = Object.freeze({
  coordinator: "pi/smol",
  siteAgent: "pi/smol",
  repairAgent: "pi/slow",
  verifier: "pi/task",
});

const FileConfigSchema = z
  .object({
    models: z
      .object({
        coordinator: z.string().min(1).optional(),
        siteAgent: z.string().min(1).optional(),
        repairAgent: z.string().min(1).optional(),
        verifier: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    caps: z
      .object({
        maxRuntimeMs: z.number().int().positive().max(HARD_CAPS.maxRuntimeMs).optional(),
        maxLlmRequests: z.number().int().positive().max(HARD_CAPS.maxLlmRequests).optional(),
        maxCostUsd: z.number().positive().max(HARD_CAPS.maxCostUsd).optional(),
        maxInputTokens: z.number().int().positive().max(HARD_CAPS.maxInputTokens).optional(),
        maxOutputTokens: z.number().int().positive().max(HARD_CAPS.maxOutputTokens).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type FileConfig = z.infer<typeof FileConfigSchema>;

function positiveNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new AgentRuntimeError("BAD_CONFIG", `${name} must be positive`);
  return parsed;
}

export async function loadAgentConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentConfig> {
  let file: FileConfig = {};
  if (path) {
    try {
      file = FileConfigSchema.parse(JSON.parse(await Bun.file(path).text()));
    } catch (error) {
      throw new AgentRuntimeError("BAD_CONFIG", error instanceof Error ? error.message : String(error));
    }
  }

  const caps: HostCaps = {
    maxConcurrency: HARD_CAPS.maxConcurrency,
    maxDepth: HARD_CAPS.maxDepth,
    maxRuntimeMs: positiveNumber(env.SCRAP_AGENT_MAX_RUNTIME_MS, "SCRAP_AGENT_MAX_RUNTIME_MS") ?? file.caps?.maxRuntimeMs ?? HARD_CAPS.maxRuntimeMs,
    maxLlmRequests: positiveNumber(env.SCRAP_AGENT_MAX_LLM_REQUESTS, "SCRAP_AGENT_MAX_LLM_REQUESTS") ?? file.caps?.maxLlmRequests ?? HARD_CAPS.maxLlmRequests,
    maxCostUsd: positiveNumber(env.SCRAP_AGENT_MAX_COST_USD, "SCRAP_AGENT_MAX_COST_USD") ?? file.caps?.maxCostUsd ?? HARD_CAPS.maxCostUsd,
    maxInputTokens: positiveNumber(env.SCRAP_AGENT_MAX_INPUT_TOKENS, "SCRAP_AGENT_MAX_INPUT_TOKENS") ?? file.caps?.maxInputTokens ?? HARD_CAPS.maxInputTokens,
    maxOutputTokens: positiveNumber(env.SCRAP_AGENT_MAX_OUTPUT_TOKENS, "SCRAP_AGENT_MAX_OUTPUT_TOKENS") ?? file.caps?.maxOutputTokens ?? HARD_CAPS.maxOutputTokens,
  };

  for (const [key, value] of Object.entries(caps)) {
    const hard = HARD_CAPS[key as keyof typeof HARD_CAPS];
    if (typeof value === "number" && typeof hard === "number" && value > hard) {
      throw new AgentRuntimeError("CAP_EXCEEDS_HOST_LIMIT", `${key} exceeds host hard cap`, { requested: value, hard });
    }
  }

  return {
    models: {
      coordinator: env.SCRAP_AGENT_COORDINATOR_MODEL ?? file.models?.coordinator ?? DEFAULT_MODELS.coordinator,
      siteAgent: env.SCRAP_AGENT_SITE_MODEL ?? file.models?.siteAgent ?? DEFAULT_MODELS.siteAgent,
      repairAgent: env.SCRAP_AGENT_REPAIR_MODEL ?? file.models?.repairAgent ?? DEFAULT_MODELS.repairAgent,
      verifier: env.SCRAP_AGENT_VERIFIER_MODEL ?? file.models?.verifier ?? DEFAULT_MODELS.verifier,
    },
    caps,
  };
}
