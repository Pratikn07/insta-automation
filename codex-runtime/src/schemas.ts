import { z } from "zod";

/**
 * The runtime's HTTP + structured-output contracts.
 *
 * Every field is bounded. This is a trust boundary: the request arrives from the
 * existing API carrying a participant's own DM text, and the output is parsed
 * from a model turn. Neither is assumed well-formed.
 */

export const dmDraftRequestSchema = z.object({
  requestId: z.string().uuid(),
  participant: z.object({
    igUserId: z.string().min(1).max(128),
    username: z.string().max(100).nullable(),
    name: z.string().max(200).nullable(),
  }),
  messages: z
    .array(
      z.object({
        direction: z.enum(["inbound", "outbound"]),
        text: z.string().max(2000).nullable(),
        messageType: z.enum(["text", "image", "video", "audio", "file", "unknown"]),
        source: z.string().max(64),
        at: z.string().datetime(),
      }),
    )
    .min(1)
    .max(20),
  brandVoice: z.string().min(1).max(4000),
  guideContext: z
    .object({
      keyword: z.string().max(100),
      resourceName: z.string().max(200),
      description: z.string().max(2000).nullable(),
    })
    .nullable(),
});

export type DmDraftRequest = z.infer<typeof dmDraftRequestSchema>;

/**
 * What the model must return. The reply cap is 1000 chars — an Instagram DM the
 * owner will actually skim, not an essay. Extra keys are stripped by Zod, so a
 * model that tries to smuggle a field cannot.
 */
export const dmDraftOutputSchema = z.object({
  reply: z.string().min(1).max(1000),
  rationale: z.string().min(1).max(1000),
  confidence: z.enum(["low", "medium", "high"]),
  warnings: z.array(z.string().max(300)).max(8),
});

export type DmDraftOutput = z.infer<typeof dmDraftOutputSchema>;

/**
 * The JSON Schema handed to app-server as the turn's `outputSchema`. Kept in sync
 * with `dmDraftOutputSchema` by hand — app-server wants JSON Schema, and deriving
 * it at runtime would pull in a converter for four fields that never change.
 */
export const dmDraftOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "rationale", "confidence", "warnings"],
  properties: {
    reply: { type: "string", minLength: 1, maxLength: 1000 },
    rationale: { type: "string", minLength: 1, maxLength: 1000 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    warnings: { type: "array", maxItems: 8, items: { type: "string", maxLength: 300 } },
  },
} as const;

export interface DmDraftSuggestion {
  reply: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  warnings: string[];
  modelId: string | null;
}
