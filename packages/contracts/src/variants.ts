import type { VariantInput, VariantWarning } from "./schemas.ts";
import { VariantInputSchema } from "./schemas.ts";

export interface VariantValidationResult {
  variants: VariantInput[];
  warnings: VariantWarning[];
}

/**
 * Validate a product's raw variant array independently of the parent product.
 * Each raw entry is parsed with `VariantInputSchema.safeParse`; a malformed
 * entry is dropped with a structured warning and never rejects the parent or
 * any valid sibling. Duplicate `externalId`s keep the FIRST occurrence and
 * warn about the rest.
 */
export function validateVariants(rawVariants: readonly unknown[]): VariantValidationResult {
  const variants: VariantInput[] = [];
  const warnings: VariantWarning[] = [];
  const seen = new Set<string>();

  for (const raw of rawVariants) {
    const parsed = VariantInputSchema.safeParse(raw);
    if (!parsed.success) {
      const externalId =
        raw && typeof raw === "object" && "externalId" in raw && typeof (raw as { externalId?: unknown }).externalId === "string"
          ? ((raw as { externalId: string }).externalId)
          : undefined;
      warnings.push({
        externalId,
        reason: parsed.error.issues[0]?.message ?? "invalid variant",
      });
      continue;
    }
    if (seen.has(parsed.data.externalId)) {
      warnings.push({ externalId: parsed.data.externalId, reason: "duplicate externalId; kept first occurrence" });
      continue;
    }
    seen.add(parsed.data.externalId);
    variants.push(parsed.data);
  }

  return { variants, warnings };
}
