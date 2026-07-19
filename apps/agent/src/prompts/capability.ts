import type { CapabilityDefinition, InvocationContext } from "@scrapito/contracts";

export function capabilityPrompt(capability: CapabilityDefinition, invocation: InvocationContext): string {
  const repairAllowed = invocation.intent === "repair" && invocation.repairPolicy.allowRepair;
  return [
    `Capability: ${capability.capability}`,
    `Declared output: ${capability.output}`,
    `Declared side effect: ${capability.sideEffect}`,
    `Capability context: ${capability.contextRef}`,
    `Repair authorized: ${repairAllowed}`,
    capability.sideEffect === "catalog_write"
      ? "The only permitted write action is to recommend host action ingest."
      : capability.sideEffect === "worktree_write"
        ? "Repair may only propose bounded file content under the exact SiteDefinition repair root. The host applies it in an isolated worktree; no shell, command, free URL, policy bypass, production edit, approval, or promotion is available to the model."
        : "Do not recommend catalog ingestion for this capability.",
    repairAllowed
      ? "A candidate must stop at awaiting_approval. Baseline auto-promotion is disabled and only a human hash-bound approval may unlock serialized host promotion."
      : "Do not create, infer, or request a repair.",
  ].join("\n");
}
