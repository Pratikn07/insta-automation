import { z } from "zod";
import { logEvent } from "./eventLogger.js";
// Same guard and the same minimum sample the rest of the funnels layer uses. One number,
// so a cover share and a follow share cannot disagree about when a sample is too thin.
import { guardedRate, type GuardedRate } from "./funnels/types.js";
import { GUIDE_FOLLOW_MIN_SAMPLE } from "./funnels/guideFollowFunnel.js";

export const GUIDE_ACCESS_METRIC_KIND = "guide_access_v2_metric";
const MAX_LATENCY_MS = 7 * 24 * 60 * 60 * 1_000;

export const GUIDE_ACCESS_OUTCOMES = {
  opening: ["accepted", "failed", "uncertain"],
  action: ["received", "replayed", "expired", "unsupported"],
  fresh_check: ["follower", "non_follower", "unavailable"],
  // `shown` only. `profile_action_offered` was declared here and could never be written:
  // the follower gate is unconditionally plain text (`sendFollowerGate` is wired with no
  // capabilities), so no code path can offer a profile control. Declaring an outcome
  // nothing can produce is the same camouflage as a stage nothing reads — a permanent zero
  // that looks like a finding. It comes back when the capability spike proves the control.
  gate: ["shown"],
  recheck: ["attempted", "confirmed", "not_confirmed", "unavailable"],
  delivery: ["planned", "completed", "failed", "needs_review"],
  // TWO cover stages, not one, because there are two cover paths and they measure
  // different things. Folding them together let a rate divide one path's numerator by the
  // other path's denominator — a panel that could read "accepted 100%" and "failed 100%"
  // simultaneously, or report that nothing had been considered while real parents were
  // receiving cover images through the gate.
  //
  // `cover_gate`: the cover the follow gate sends DIRECTLY to a non-follower. Exposure is
  // attempted immediately, so the three send outcomes are what this path produces; the two
  // `omitted_*` are decisions taken before any send.
  cover_gate: ["accepted", "failed", "uncertain", "omitted_not_selected", "omitted_mismatch"],
  // `cover_delivery`: the cover prepended as the first UNIT of a ledger delivery. This
  // path records only its plan-time decision. The four outcomes partition every plan
  // COMPILATION that had a cover to consider, which is not quite per delivery: two
  // concurrent calls for one trigger both reach the decision before `createOrLoadPlan`'s
  // `ON CONFLICT DO NOTHING` picks a winner, so one delivery can produce two outcomes; and
  // the write is fire-and-forget, so a dropped event produces none. Read the denominator as
  // "decisions taken", not "deliveries created". It is still the right denominator for an
  // inclusion share, and a pairing bug still cannot hide inside a routine rollout omission.
  // The unit's own send outcome is not recorded here — it is the delivery ledger's
  // business, and inventing a cover exposure for it would put two different events under
  // one name again.
  cover_delivery: [
    "selected",
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

/**
 * Typed entry point. `record` takes `unknown` because it validates hostile input at the
 * boundary, which also means a mistyped stage or an outcome from the wrong stage compiles
 * fine and fails silently at runtime — the whole `cover` stage was renamed underneath its
 * call sites without a single compiler error. Prefer this wherever the stage is a literal.
 */
export function recordGuideAccessMetric<Stage extends GuideAccessMetricStage>(
  stage: Stage,
  outcome: (typeof GUIDE_ACCESS_OUTCOMES)[Stage][number],
  latencyMs?: number,
): Promise<MetricRecordResult> {
  return guideAccessMetrics.record(
    latencyMs === undefined ? { stage, outcome } : { stage, outcome, latencyMs },
  );
}

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

/**
 * Cover shares, computed here rather than in the page.
 *
 * Grouped by path, and never mixed. Each group's denominator is drawn only from its own
 * stage, so no share can be a ratio between two populations that never overlap:
 *
 * - `gate` is denominated by the exposures the gate actually ATTEMPTED
 *   (`accepted + failed + uncertain`). The rollout omissions are excluded on purpose: an
 *   exposure the fence withheld was never attempted, and counting it would understate every
 *   send outcome. The three shares are mutually exclusive, so they sum to 100.
 * - `delivery` is denominated by every delivery that HAD a cover to consider (all four of
 *   that stage's outcomes), which is the pool an inclusion share is meaningfully a share of.
 */
export interface GuideCoverRates {
  gate: {
    accepted: GuardedRate;
    failed: GuardedRate;
    uncertain: GuardedRate;
  };
  delivery: {
    included: GuardedRate;
    duplicateSuppressed: GuardedRate;
    mispaired: GuardedRate;
  };
}

export interface GuideAccessMetricsResult {
  key: "guide-access-v2";
  window: { from: string; to: string };
  counts: GuideAccessCountMatrix;
  latenciesMs: Record<GuideAccessMetricStage, GuideAccessLatencySummary>;
  coverRates: GuideCoverRates;
  totalEvents: number;
  ownerReviewEvents: number;
}

/**
 * The reader's allowlist, DERIVED from the writer's vocabulary rather than restated.
 *
 * This clause used to be a hand-written literal listing every stage. It fell out of sync
 * the moment a stage was added: `cover` events were written, validated, and stored, and
 * then silently discarded here, so every cover count read zero. Nothing failed — the SQL
 * was valid and the tests mocked it. Generating the predicate makes drift impossible
 * instead of merely detectable.
 */
const SQL_TOKEN = /^[a-z_]+$/;

const VOCABULARY_PREDICATE = Object.entries(GUIDE_ACCESS_OUTCOMES)
  .map(([stage, outcomes]) => {
    // These are compile-time constants, never user input, but this clause is interpolated
    // into SQL: refuse anything that is not a bare identifier rather than quote it.
    for (const token of [stage, ...(outcomes as readonly string[])]) {
      if (!SQL_TOKEN.test(token)) {
        throw new Error(`unsafe guide access metric token: ${token}`);
      }
    }
    const list = (outcomes as readonly string[]).map((outcome) => `'${outcome}'`).join(", ");
    return `(payload->>'stage' = '${stage}' AND payload->>'outcome' IN (${list}))`;
  })
  .join("\n      OR ");

/** Exported so a test can assert the generated allowlist against the vocabulary. */
export const GUIDE_ACCESS_AGGREGATE_SQL = `
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
      ${VOCABULARY_PREDICATE}
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

const AGGREGATE_SQL = GUIDE_ACCESS_AGGREGATE_SQL;

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
    coverRates: coverRates(counts),
    totalEvents,
    ownerReviewEvents: counts.needs_review.marked,
  };
}

function coverRates(counts: GuideAccessCountMatrix): GuideCoverRates {
  const gate = counts.cover_gate;
  const delivery = counts.cover_delivery;
  const rate = (numerator: number, denominator: number): GuardedRate =>
    guardedRate(numerator, denominator, GUIDE_FOLLOW_MIN_SAMPLE);

  // Exposures the gate actually reached the provider with. Omissions are excluded: they
  // were decided before any send, so they belong to no send-outcome denominator.
  const attempted = gate.accepted + gate.failed + gate.uncertain;
  // Every delivery that reached the cover decision landed in exactly one of these four.
  const considered =
    delivery.selected +
    delivery.omitted_already_shown +
    delivery.omitted_not_selected +
    delivery.omitted_mismatch;

  return {
    gate: {
      accepted: rate(gate.accepted, attempted),
      failed: rate(gate.failed, attempted),
      uncertain: rate(gate.uncertain, attempted),
    },
    delivery: {
      included: rate(delivery.selected, considered),
      duplicateSuppressed: rate(delivery.omitted_already_shown, considered),
      mispaired: rate(delivery.omitted_mismatch, considered),
    },
  };
}
