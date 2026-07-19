import { z, type CustomTool } from "@oh-my-pi/pi-coding-agent";
import { AgentRuntimeError } from "./errors.ts";
import type { AgentDecision, Composition } from "./types.ts";

const ContextParams = z.object({}).strict();
const DecisionParams = z
  .object({
    action: z.enum(["ingest", "defer", "reject"]),
    summary: z.string().trim().min(1).max(500),
    evidenceIds: z.array(z.string().trim().min(1).max(300)).max(32),
    actionId: z.string().trim().min(1).max(200),
  })
  .strict();

export interface DecisionCapture {
  decision?: AgentDecision;
}

export function createBusinessTools(composition: Composition, capture: DecisionCapture): CustomTool[] {
  const contextTool: CustomTool<typeof ContextParams> = {
    name: "invocation_context",
    label: "Invocation Context",
    strict: true,
    loadMode: "essential",
    description: "Return the already-validated invocation, closed definitions, and approved evidence IDs. No I/O.",
    parameters: ContextParams,
    async execute() {
      const data = {
        invocation: composition.invocation,
        site: composition.site,
        strategy: composition.strategy,
        capability: composition.capability,
        evidenceIds: composition.evidence,
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
    },
  };

  const decisionTool: CustomTool<typeof DecisionParams> = {
    name: "submit_invocation_action",
    label: "Submit Invocation Action",
    strict: true,
    loadMode: "essential",
    description: "Submit the single bounded host recommendation. This tool never performs a write.",
    parameters: DecisionParams,
    async execute(_toolCallId, params) {
      if (capture.decision) throw new AgentRuntimeError("DUPLICATE_ACTION", "only one action may be submitted");
      if (params.action === "ingest" && composition.capability.sideEffect !== "catalog_write") {
        throw new AgentRuntimeError("ACTION_NOT_ALLOWED", "ingest is not allowed for this capability");
      }
      const approvedEvidence = new Set(composition.evidence);
      if (params.evidenceIds.some((id) => !approvedEvidence.has(id))) {
        throw new AgentRuntimeError("UNAPPROVED_EVIDENCE", "decision includes evidence outside the support cell");
      }
      capture.decision = {
        action: params.action,
        summary: params.summary,
        evidenceIds: [...params.evidenceIds],
        actionId: params.actionId,
      };
      return {
        content: [{ type: "text", text: JSON.stringify({ accepted: true, actionId: params.actionId }) }],
        details: capture.decision,
      };
    },
  };

  return [contextTool, decisionTool];
}
