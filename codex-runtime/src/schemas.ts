import { z } from "zod";

/**
 * The runtime's HTTP + structured-output contracts.
 *
 * Every field is bounded. This is a trust boundary: the request arrives from the
 * existing API carrying a participant's own DM text, and the output is parsed
 * from a model turn. Neither is assumed well-formed.
 */

const participantSchema = z.object({
  igUserId: z.string().min(1).max(128),
  username: z.string().max(100).nullable(),
  name: z.string().max(200).nullable(),
});

const messagesSchema = z
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
  .max(20);

const guideContextSchema = z.object({
  keyword: z.string().max(100),
  resourceName: z.string().max(200),
  description: z.string().max(2000).nullable(),
});

const requestFields = {
  requestId: z.string().uuid(),
  promptVersion: z.literal(2),
  participant: participantSchema,
  messages: messagesSchema,
  brandVoice: z.string().min(1).max(4000),
};

export const dmDraftRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...requestFields,
      kind: z.literal("reply"),
      guideDeliveredAt: z.null(),
      guideContext: z.null(),
    })
    .strict(),
  z
    .object({
      ...requestFields,
      kind: z.literal("engagement_follow_up"),
      guideDeliveredAt: z.string().datetime(),
      guideContext: guideContextSchema,
    })
    .strict(),
]);

export type DmDraftRequest = z.infer<typeof dmDraftRequestSchema>;

/**
 * What the model must return. The reply cap is 1000 chars — an Instagram DM the
 * owner will actually skim, not an essay. Extra keys are rejected rather than
 * silently stripped, keeping the Zod and JSON Schema boundaries identical.
 */
export const dmDraftOutputSchema = z
  .object({
    reply: z.string().min(1).max(1000),
    rationale: z.string().min(1).max(1000),
    confidence: z.enum(["low", "medium", "high"]),
    warnings: z.array(z.string().max(300)).max(8),
  })
  .strict();

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

// --- advisor ------------------------------------------------------------------

/** The only links the advisor may point at: existing read-only owner pages. */
const ADVISOR_HREFS = ["/conversations", "/insights", "/keywords", "/sequences"] as const;

/**
 * Every substantive advisor answer must carry a recommendation, the evidence
 * behind it, a confidence level, one next step, and any data gaps. The schema
 * enforces that rather than trusting the prompt: an advisor that answers without
 * evidence is just a chatbot with database access.
 */
export const advisorResponseSchema = z.object({
  answer: z.string().min(1).max(4000),
  recommendation: z.string().min(1).max(1200),
  evidence: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        value: z.string().min(1).max(300),
        // A closed enum, so the advisor cannot emit an arbitrary URL for the owner
        // to click.
        href: z.enum(ADVISOR_HREFS).nullable(),
      }),
    )
    .max(8),
  confidence: z.enum(["low", "medium", "high"]),
  nextStep: z.string().min(1).max(600),
  nextStepHref: z.enum(ADVISOR_HREFS).nullable(),
  dataGaps: z.array(z.string().max(300)).max(8),
});

export type AdvisorResponse = z.infer<typeof advisorResponseSchema>;

export const advisorRequestSchema = z
  .object({
    message: z.string().min(1).max(2000),
    clientMessageId: z.string().min(1).max(128),
  })
  .strict();

export type AdvisorRequest = z.infer<typeof advisorRequestSchema>;

export interface AdvisorHistoryItem {
  role: "user" | "assistant";
  clientMessageId: string | null;
  text: string | null;
  response: AdvisorResponse | null;
}

const hrefProperty = { type: "string", enum: [...ADVISOR_HREFS] } as const;

/** JSON Schema handed to app-server as the advisor turn's outputSchema. */
export const advisorResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "answer",
    "recommendation",
    "evidence",
    "confidence",
    "nextStep",
    "nextStepHref",
    "dataGaps",
  ],
  properties: {
    answer: { type: "string", minLength: 1, maxLength: 4000 },
    recommendation: { type: "string", minLength: 1, maxLength: 1200 },
    evidence: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value", "href"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 120 },
          value: { type: "string", minLength: 1, maxLength: 300 },
          href: { anyOf: [hrefProperty, { type: "null" }] },
        },
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    nextStep: { type: "string", minLength: 1, maxLength: 600 },
    nextStepHref: { anyOf: [hrefProperty, { type: "null" }] },
    dataGaps: { type: "array", maxItems: 8, items: { type: "string", maxLength: 300 } },
  },
} as const;

/**
 * The advisor's dynamic tools, declared literally.
 *
 * Three read-only functions. Nothing here can send, write, update, delete, or
 * touch Instagram — a test asserts those words appear nowhere in this list, so a
 * future edit that adds a write tool fails loudly.
 */
export const ADVISOR_TOOLS = [
  {
    type: "function",
    name: "business_overview",
    description: "Read measured Tiny SOHO business totals for a fixed 7- or 30-day window.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["windowDays"],
      properties: { windowDays: { type: "integer", enum: [7, 30] } },
    },
  },
  {
    type: "function",
    name: "keyword_guide_catalog",
    description: "Read the bounded active keyword and guide catalog.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["limit"],
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
  {
    type: "function",
    name: "conversation_summary",
    description: "Read redacted aggregate DM thread summaries for a fixed window.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["windowDays", "limit"],
      properties: {
        windowDays: { type: "integer", enum: [7, 30] },
        limit: { type: "integer", minimum: 1, maximum: 25 },
      },
    },
  },
] as const;
