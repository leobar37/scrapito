import { z } from "zod";

/** The two supported Peru storefronts. */
export const StoreIdSchema = z.enum(["ripley-pe", "falabella-pe"]);
export type StoreId = z.infer<typeof StoreIdSchema>;

/** Only Peruvian Soles are supported in v1. */
export const CurrencySchema = z.literal("PEN");
export type Currency = z.infer<typeof CurrencySchema>;

export const STORE_IDS: readonly StoreId[] = StoreIdSchema.options;
