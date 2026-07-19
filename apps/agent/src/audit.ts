import { createHash } from "node:crypto";
import type { AuditRecord, Composition, InvocationState, LlmUsage } from "./types.ts";

export class AuditTrail {
  readonly #records: AuditRecord[] = [];

  constructor(
    private readonly composition: Composition,
    private readonly model: string,
  ) {}

  append(state: InvocationState, detail: string, usage: LlmUsage, evidenceIds: readonly string[] = [], actionId: string | null = null): void {
    const invocation = this.composition.invocation;
    this.#records.push({
      timestamp: new Date().toISOString(),
      invocationId: invocation.invocationId,
      site: invocation.site,
      strategy: invocation.strategy,
      capability: invocation.intent,
      state,
      model: this.model,
      usage: { ...usage },
      evidenceIds: [...evidenceIds],
      actionId,
      detail,
    });
  }

  snapshot(): readonly AuditRecord[] {
    return this.#records.map((record) => ({ ...record, usage: { ...record.usage }, evidenceIds: [...record.evidenceIds] }));
  }

  artifact(): { kind: string; ref: string; sha256: string } {
    const content = JSON.stringify(this.#records);
    const sha256 = createHash("sha256").update(content).digest("hex");
    return { kind: "invocation_audit", ref: `audit:${this.composition.invocation.invocationId}:${sha256.slice(0, 16)}`, sha256 };
  }
}
