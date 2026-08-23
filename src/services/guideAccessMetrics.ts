import { z } from "zod";
import { logEvent } from "./eventLogger.js";

export const GUIDE_ACCESS_METRIC_KIND = "guide_access_v2_metric";
const MAX_LATENCY_MS = 7 * 24 * 60 * 60 * 1_000;

export const GUIDE_ACCESS_OUTCOMES = {
  opening: ["accepted", "failed", "uncertain"],
  action: ["received", "replayed", "expired", "unsupported"],
  fresh_check: ["follower", "non_follower", "unavailable"],
  gate: ["shown", "profile_action_offered"],
  recheck: ["attempted", "confirmed", "not_confirmed", "unavailable"],
  delivery: ["planned", "completed", "failed", "needs_review"],
  // Cover outcomes. `selected` counts a cover actually put into a plan, so it is the
  // denominator for `accepted`/`failed`/`uncertain`. The three `omitted_*` outcomes are
  // kept apart because they mean very different things operationally: duplicate
  // suppression working, the rollout fence holding, and a snapshot paired with the wrong
  // guide. Together with `selected` they partition every delivery that had a cover to
  // consider, so the funnel adds up and a pairing bug cannot hide inside a routine one.
  cover: [
    "selected",
    "accepted",
    "failed",
    "uncertain",
    "omitted_already_shown",
    "omitted_not_selected",
    "omitted_mismatch",
  ],
  needs_review: ["marked"],
} as const;

export type GuideAccessMetricStage = keyof typeof GUIDE_ACCESS_OUTCOMES;
export type GuideAccessMetricOutcome =
  (typeof GUIDE_ACCESS_OUTCOMES)[GuideAccessMetricStage][number];

const STAGES = Object.keys(GUIDE_ACCESS_OUTCOMES) as [
  GuideAccessMetricStage,
  ...GuideAccessMetricStage[],
];
const inputSchema = z
  .object({
    stage: z.enum(STAGES),
    outcome: z.string(),
    latencyMs: z.number().finite().int().min(0).max(MAX_LATENCY_MS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const outcomes = GUIDE_ACCESS_OUTCOMES[value.stage] as readonly string[];
    if (!outcomes.includes(value.outcome)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "outcome is not allowlisted for stage",
      });
    }
  });

type MetricRecordResult = "recorded" | "rejected" | "failed";

export function createGuideAccessMetrics(dependencies: {
  writeEvent(kind: string, payload: object): Promise<void>;
}) {
  return {
    async record(input: unknown): Promise<MetricRecordResult> {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return "rejected";

      const payload: {
        version: 1;
        stage: GuideAccessMetricStage;
        outcome: string;
        latencyMs?: number;
      } = {
        version: 1,
        stage: parsed.data.stage,
        outcome: parsed.data.outcome,
        ...(parsed.data.latencyMs === undefined
          ? {}
          : { latencyMs: parsed.data.latencyMs }),
      };
      try {
        await dependencies.writeEvent(GUIDE_ACCESS_METRIC_KIND, payload);
        return "recorded";
      } catch {
        return "failed";
      }
    },
  };
}

/** Shared recorder for parent-flow integration. */
export const guideAccessMetrics = createGuideAccessMetrics({ writeEvent: logEvent });

export interface GuideAccessMetricsDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface GuideAccessMetricsWindow {
  from: Date;
  to: Date;
}

type AggregateRow = {
  stage: unknown;
  outcome: unknown;
  count: unknown;
  latencySamples: unknown;
  averageLatencyMs: unknown;
  p50LatencyMs: unknown;
  p95LatencyMs: unknown;
  maxLatencyMs: unknown;
};

export type GuideAccessLatencySummary = {
  samples: number;
  average: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

type GuideAccessCountMatrix = {
  [Stage in GuideAccessMetricStage]: Record<
    (typeof GUIDE_ACCESS_OUTCOMES)[Stage][number],
    number
  >;
};

export interface GuideAccessMetricsResult {
  key: "guide-access-v2";
  window: { from: string; to: string };
  counts: GuideAccessCountMatrix;
  latenciesMs: Record<GuideAccessMetricStage, GuideAccessLatencySummary>;
  totalEvents: number;
  ownerReviewEvents: number;
}

const AGGREGATE_SQL = `
WITH safe_events AS (
  SELECT
    payload->>'stage' AS stage,
    payload->>'outcome' AS outcome,
    CASE
      WHEN jsonb_typeof(payload->'latencyMs') = 'number'
       AND (payload->>'latencyMs')::numeric BETWEEN 0 AND ${MAX_LATENCY_MS}
      THEN (payload->>'latencyMs')::numeric
      ELSE NULL
    END AS latency_ms
  FROM event_log
  WHERE kind = '${GUIDE_ACCESS_METRIC_KIND}'
    AND created_at >= $1::timestamptz
    AND created_at < $2::timestamptz
    AND payload->>'version' = '1'
    AND (
      (payload->>'stage' = 'opening' AND payload->>'outcome' IN ('accepted', 'failed', 'uncertain'))
      OR (payload->>'stage' = 'action' AND payload->>'outcome' IN ('received', 'replayed', 'expired', 'unsupported'))
      OR (payload->>'stage' = 'fresh_check' AND payload->>'outcome' IN ('follower', 'non_follower', 'unavailable'))
      OR (payload->>'stage' = 'gate' AND payload->>'outcome' IN ('shown', 'profile_action_offered'))
      OR (payload->>'stage' = 'recheck' AND payload->>'outcome' IN ('attempted', 'confirmed', 'not_confirmed', 'unavailable'))
      OR (payload->>'stage' = 'delivery' AND payload->>'outcome' IN ('planned', 'completed', 'failed', 'needs_review'))
      OR (payload->>'stage' = 'needs_review' AND payload->>'outcome' = 'marked')
    )
),
counts AS (
  SELECT stage, outcome, COUNT(*)::bigint AS count
  FROM safe_events
  GROUP BY stage, outcome
),
latencies AS (
  SELECT
    stage,
    COUNT(latency_ms)::bigint AS latency_samples,
    AVG(latency_ms)::double precision AS average_latency_ms,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::double precision AS p50_latency_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::double precision AS p95_latency_ms,
    MAX(latency_ms)::double precision AS max_latency_ms
  FROM safe_events
  GROUP BY stage
)
SELECT
  counts.stage AS "stage",
  counts.outcome AS "outcome",
  counts.count AS "count",
  latencies.latency_samples AS "latencySamples",
  latencies.average_latency_ms AS "averageLatencyMs",
  latencies.p50_latency_ms AS "p50LatencyMs",
  latencies.p95_latency_ms AS "p95LatencyMs",
  latencies.max_latency_ms AS "maxLatencyMs"
FROM counts
JOIN latencies USING (stage)
ORDER BY counts.stage, counts.outcome
`.trim();

function emptyCounts(): GuideAccessCountMatrix {
  return Object.fromEntries(
    STAGES.map((stage) => [
      stage,
      Object.fromEntries(GUIDE_ACCESS_OUTCOMES[stage].map((outcome) => [outcome, 0])),
    ]),
  ) as GuideAccessCountMatrix;
}

function emptyLatency(): GuideAccessLatencySummary {
  return { samples: 0, average: null, p50: null, p95: null, max: null };
}

function safeCount(value: unknown): number {
  let numeric: number;
  try {
    numeric = Number(value);
  } catch {
    return 0;
  }
  if (!Number.isSafeInteger(numeric) || numeric < 0) return 0;
  return numeric;
}

function safeLatency(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_LATENCY_MS) return null;
  return Math.round(numeric);
}

function knownStage(value: unknown): value is GuideAccessMetricStage {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(GUIDE_ACCESS_OUTCOMES, value)
  );
}

function knownOutcome(
  stage: GuideAccessMetricStage,
  value: unknown,
): value is GuideAccessMetricOutcome {
  return (
    typeof value === "string" &&
    (GUIDE_ACCESS_OUTCOMES[stage] as readonly string[]).includes(value)
  );
}

export async function runGuideAccessMetrics(
  db: GuideAccessMetricsDb,
  window: GuideAccessMetricsWindow,
): Promise<GuideAccessMetricsResult> {
  const rows = await db.$queryRawUnsafe<AggregateRow[]>(
    AGGREGATE_SQL,
    window.from,
    window.to,
  );
  const counts = emptyCounts();
  const latenciesMs = Object.fromEntries(
    STAGES.map((stage) => [stage, emptyLatency()]),
  ) as Record<GuideAccessMetricStage, GuideAccessLatencySummary>;
  const latencySeen = new Set<GuideAccessMetricStage>();

  for (const row of rows) {
    if (!knownStage(row.stage) || !knownOutcome(row.stage, row.outcome)) continue;
    const stage = row.stage;
    const stageCounts = counts[stage] as Record<string, number>;
    stageCounts[row.outcome] = safeCount(row.count);
    if (latencySeen.has(stage)) continue;
    const samples = safeCount(row.latencySamples);
    const summary = {
      samples,
      average: safeLatency(row.averageLatencyMs),
      p50: safeLatency(row.p50LatencyMs),
      p95: safeLatency(row.p95LatencyMs),
      max: safeLatency(row.maxLatencyMs),
    };
    latenciesMs[stage] =
      samples > 0 && Object.values(summary).slice(1).every((value) => value !== null)
        ? summary
        : emptyLatency();
    latencySeen.add(stage);
  }

  const totalEvents = STAGES.reduce(
    (total, stage) =>
      total + Object.values(counts[stage]).reduce((subtotal, count) => subtotal + count, 0),
    0,
  );

  return {
    key: "guide-access-v2",
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    counts,
    latenciesMs,
    totalEvents,
    ownerReviewEvents: counts.needs_review.marked,
  };
}
