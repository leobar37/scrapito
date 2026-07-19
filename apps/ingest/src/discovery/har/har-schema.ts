/**
 * Zod schema for the HAR 1.2 subset the discovery pipeline consumes. Unknown
 * fields pass through so nothing the browser recorded is silently lost, but
 * every field the sanitizer/analyzer touches is structurally validated first.
 */
import { z } from "zod";

export const HarNameValueSchema = z
  .object({ name: z.string(), value: z.string() })
  .passthrough();

export const HarRequestSchema = z
  .object({
    method: z.string(),
    url: z.string(),
    headers: z.array(HarNameValueSchema).default([]),
    queryString: z.array(HarNameValueSchema).default([]),
    postData: z
      .object({ mimeType: z.string().optional(), text: z.string().optional() })
      .passthrough()
      .optional(),
    cookies: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const HarResponseSchema = z
  .object({
    status: z.number(),
    headers: z.array(HarNameValueSchema).default([]),
    cookies: z.array(z.unknown()).optional(),
    content: z
      .object({
        mimeType: z.string().optional(),
        text: z.string().optional(),
        size: z.number().optional(),
        encoding: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const HarEntrySchema = z
  .object({
    startedDateTime: z.string().optional(),
    request: HarRequestSchema,
    response: HarResponseSchema,
  })
  .passthrough();

export const HarFileSchema = z
  .object({
    log: z
      .object({
        version: z.string().optional(),
        creator: z.unknown().optional(),
        entries: z.array(HarEntrySchema),
      })
      .passthrough(),
  })
  .passthrough();

export type HarNameValue = z.infer<typeof HarNameValueSchema>;
export type HarRequest = z.infer<typeof HarRequestSchema>;
export type HarResponse = z.infer<typeof HarResponseSchema>;
export type HarEntry = z.infer<typeof HarEntrySchema>;
export type HarFile = z.infer<typeof HarFileSchema>;

/** Parse + validate a HAR document, failing closed on structural garbage. */
export function parseHar(raw: unknown): HarFile {
  return HarFileSchema.parse(raw);
}
