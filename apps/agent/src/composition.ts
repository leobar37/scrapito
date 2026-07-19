import { InvocationContextSchema, type InvocationContext } from "@scrapito/contracts";
import {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_SUPPORT_MATRIX,
  SITE_DEFINITIONS,
  STRATEGY_DEFINITIONS,
} from "@scrapito/ingest/src/targets/definitions.ts";
import { AgentRuntimeError } from "./errors.ts";
import { composePrompt } from "./prompts/index.ts";
import type { Composition } from "./types.ts";

export function composeInvocation(raw: unknown): Composition {
  const invocation = InvocationContextSchema.parse(raw);
  const site = SITE_DEFINITIONS.find((item) => item.site === invocation.site);
  const strategy = STRATEGY_DEFINITIONS.find((item) => item.strategy === invocation.strategy);
  const capability = CAPABILITY_DEFINITIONS.find((item) => item.capability === invocation.intent);
  const support = CAPABILITY_SUPPORT_MATRIX.find(
    (item) => item.site === invocation.site && item.strategy === invocation.strategy && item.capability === invocation.intent,
  );

  if (!site || !strategy || !capability || !support) {
    throw new AgentRuntimeError("INVALID_CAPABILITY_MATRIX", "definition or support cell is missing");
  }
  if (!support.supported) {
    throw new AgentRuntimeError(
      "UNSUPPORTED_INVOCATION",
      `unsupported invocation: ${invocation.site}/${invocation.strategy}/${invocation.intent}`,
      { reason: support.reason },
    );
  }
  if (strategy.targetKind !== invocation.target.kind) {
    throw new AgentRuntimeError("INVALID_TARGET_ADAPTER", "strategy target kind mismatch");
  }

  return {
    invocation,
    site,
    strategy,
    capability,
    evidence: support.evidence,
    prompt: composePrompt(invocation, site, strategy, capability),
  };
}

export function parseInvocation(raw: unknown): InvocationContext {
  return InvocationContextSchema.parse(raw);
}
