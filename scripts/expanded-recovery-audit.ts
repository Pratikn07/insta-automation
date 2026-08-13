import { Client } from "pg";
import { classifyIdentityPresence, evaluateHistoricalAudience } from "../src/services/historicalAudienceSegment.js";
import {
  verifyStoredSelectionSnapshot,
  type StoredSelectionSnapshot,
} from "../src/services/historicalRecoverySnapshot.js";

const EXPANDED_SEGMENTS = ["other", "unknown_cue", "unknown_generic", "unknown_no_name"] as const;
type ExpandedSegment = (typeof EXPANDED_SEGMENTS)[number];

export type ExpandedGroupAuditCampaign = {
  id: string;
  state: string;
  phase: string;
  audienceSegment: ExpandedSegment;
  rolloutGroupId: string;
  rolloutGroupHourlyCap: number;
  selectionVersion: string;
  copyVersion: string;
  eligibilityPolicyVersion: string;
  holdoutPercent: number;
  batchSize: number;
  hourlyCap: number;
  dailyCap: number;
  candidateCount: number;
  excludedCount: number;
  allCandidatesMatchLive: boolean;
  snapshot: StoredSelectionSnapshot;
};

export type ExpandedGroupAuditSnapshot = {
  expectedGroupId: string;
  expectedCampaigns: Array<{ id: string; segment: ExpandedSegment; decisionHash: string }>;
  expectedStates: string[];
  expectedPhase: string;
  rollingCapacity: number;
  campaigns: ExpandedGroupAuditCampaign[];
};

function failAudit(detail: string): never {
  throw new Error(`expanded_group_audit_failed:${detail}`);
}

/** Validate every campaign as one pre-mutation decision, not four sequential guesses. */
export function assertExpandedGroupAuditSnapshot(input: ExpandedGroupAuditSnapshot): void {
  if (
    input.expectedCampaigns.length < 1
    || input.expectedCampaigns.length > 4
    || input.campaigns.length !== input.expectedCampaigns.length
    || input.expectedStates.length === 0
    || !Number.isInteger(input.rollingCapacity)
    || input.rollingCapacity < 0
    || input.rollingCapacity > 10
  ) failAudit("group_shape");

  const expectedIds = new Set(input.expectedCampaigns.map(({ id }) => id));
  const expectedSegments = input.expectedCampaigns.map(({ segment }) => segment);
  if (
    expectedIds.size !== input.expectedCampaigns.length
    || new Set(expectedSegments).size !== expectedSegments.length
    || input.expectedCampaigns.some(({ decisionHash }) => !/^[a-f0-9]{64}$/.test(decisionHash))
    || expectedSegments.some((value, index) =>
      index > 0
      && EXPANDED_SEGMENTS.indexOf(value) <= EXPANDED_SEGMENTS.indexOf(expectedSegments[index - 1]!))
  ) failAudit("expected_topology");

  const people = new Set<string>();
  for (const [index, campaign] of input.campaigns.entries()) {
    const expected = input.expectedCampaigns[index]!;
    const configuration = campaign.snapshot.configuration;
    if (
      campaign.id !== expected.id
      || campaign.audienceSegment !== expected.segment
      || campaign.snapshot.decisionHash !== expected.decisionHash
      || campaign.rolloutGroupId !== input.expectedGroupId
      || !input.expectedStates.includes(campaign.state)
      || campaign.phase !== input.expectedPhase
      || campaign.selectionVersion !== "v1-canonical-intents-expanded-audience"
      || campaign.copyVersion !== "recovery-v2"
      || campaign.eligibilityPolicyVersion !== "eligibility-v4-expanded-audience"
      || campaign.holdoutPercent !== 0
      || campaign.batchSize !== 1
      || campaign.hourlyCap !== 10
      || campaign.dailyCap !== 1000
      || campaign.rolloutGroupHourlyCap !== 10
      || campaign.candidateCount <= 0
      || campaign.candidateCount !== campaign.snapshot.candidateCount
      || campaign.excludedCount !== campaign.snapshot.excludedCount
      || !campaign.allCandidatesMatchLive
      || configuration === null
      || configuration.phase !== campaign.phase
      || configuration.selectionVersion !== campaign.selectionVersion
      || configuration.copyVersion !== campaign.copyVersion
      || configuration.eligibilityPolicyVersion !== campaign.eligibilityPolicyVersion
      || configuration.holdoutPercent !== campaign.holdoutPercent
      || configuration.audienceSegment !== campaign.audienceSegment
      || configuration.rolloutGroupId !== campaign.rolloutGroupId
      || configuration.rolloutGroupHourlyCap !== campaign.rolloutGroupHourlyCap
      || campaign.snapshot.inclusions.some(({ arm }) => arm !== "treatment")
    ) failAudit(`campaign_contract:${campaign.id}`);

    const verified = verifyStoredSelectionSnapshot(campaign.snapshot);
    if (!verified.ok) failAudit(`${verified.reason}:${campaign.id}`);
    for (const inclusion of campaign.snapshot.inclusions) {
      if (people.has(inclusion.igUserId)) failAudit(`duplicate_person:${inclusion.igUserId}`);
      people.add(inclusion.igUserId);
    }
  }
}

type AudienceRow = { username: string | null; name: string | null; segment: string | null; origin: string | null; confidence: string | null; method: string | null };

export function hasExactHistoricalAudienceShape(row: AudienceRow): boolean {
  const identity = classifyIdentityPresence(row);
  const decision = evaluateHistoricalAudience({ segment: row.segment, origin: row.origin, confidence: row.confidence, method: row.method });
  if (identity === "unknown_no_name") return row.segment === "unknown_no_name" && row.origin === "unknown" && row.confidence === "low" && row.method === "llm_v3";
  return decision.kind !== "defer" && row.segment !== "unknown_no_name";
}

export type FirstSendSourceRow = {
  candidateId: string;
  sourceKind: string;
  sourceId: string;
  dispatchCommentId: string | null;
  approvedSourceCommentIds: string[];
};

export function isAuthorizedFirstSendRow(row: FirstSendSourceRow): boolean {
  return row.sourceKind === "historical"
    && row.sourceId === row.candidateId
    && row.dispatchCommentId !== null
    && row.approvedSourceCommentIds.includes(row.dispatchCommentId);
}

async function readonlyClient(): Promise<Client> {
  const connectionString = process.env.PGURL;
  if (!connectionString) throw new Error("PGURL is required through the environment, never argv");
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const safety = await client.query<{ user: string; readonly: string; dml: boolean }>(`
    SELECT current_user AS user, current_setting('transaction_read_only') AS readonly,
      has_table_privilege(current_user, 'recovery_campaign', 'INSERT, UPDATE, DELETE, TRUNCATE') AS dml`);
  if (safety.rows[0]?.readonly !== "on" || (safety.rows[0]?.dml && process.env.EXPANDED_AUDIT_TEST_ALLOW_DML_ROLE !== "true")) throw new Error("audit role must be transaction-read-only and lack recovery_campaign DML");
  return client;
}
async function done(client: Client): Promise<void> { await client.query("ROLLBACK"); await client.end(); }
function arg(name: string): string { const i = process.argv.indexOf(name); const value = i < 0 ? undefined : process.argv[i + 1]; if (!value) throw new Error(`${name} is required`); return value; }
function sameSet(actual: string[], expected: string[]): boolean { return actual.length === expected.length && [...actual].sort().every((id, i) => id === [...expected].sort()[i]); }

async function auditLive(): Promise<void> {
  const client = await readonlyClient();
  try {
    const rows = await client.query<AudienceRow>(`
      SELECT u.username, u.name, u.audience_segment AS segment, u.inferred_origin AS origin, u.origin_confidence AS confidence, u.origin_method AS method
      FROM journey_intent ji JOIN journey_trigger jt ON jt.intent_id=ji.id JOIN ig_users u ON u.id=ji.ig_user_id
      WHERE jt.trigger_kind='comment' AND jt.received_at < NOW() - INTERVAL '7 days' GROUP BY u.id`);
    const invalid = rows.rows.filter((row) => !hasExactHistoricalAudienceShape(row));
    if (invalid.length) throw new Error(`stale_or_structurally_invalid_targeted_users=${invalid.length}`);
    process.stdout.write(JSON.stringify({ ok: true, targeted: rows.rows.length }) + "\n");
  } finally { await done(client); }
}
async function assertGroup(): Promise<void> {
  const group = arg("--group"), expected = arg("--campaigns").split(","), phases = arg("--phase").split("|");
  const client = await readonlyClient();
  try {
    const result = await client.query<{ id: string; state: string }>(`SELECT id, state::text FROM recovery_campaign WHERE rollout_group_id=$1::uuid ORDER BY id`, [group]);
    if (!sameSet(result.rows.map((row) => row.id), expected) || !result.rows.every((row) => phases.includes(row.state))) throw new Error("campaign set/state does not exactly match audited rollout group");
    process.stdout.write(JSON.stringify({ campaignIds: result.rows.map((row) => row.id), phase: result.rows[0]?.state }) + "\n");
  } finally { await done(client); }
}
async function auditGroup(): Promise<void> {
  const group = arg("--group");
  const states = arg("--phase").split("|");
  const selectorPhase = arg("--selector-phase");
  const expectedCampaigns = JSON.parse(arg("--campaigns-json")) as Array<{
    id: string;
    segment: ExpandedSegment;
    decisionHash: string;
  }>;
  const client = await readonlyClient();
  try {
    const campaignResult = await client.query<{
      id: string; state: string; phase: string; selectionVersion: string;
      sourceDataCutoff: Date; commentFrom: Date | null; commentTo: Date | null;
      selectionLimit: number | null; holdoutPercent: number; copyVersion: string;
      batchSize: number; hourlyCap: number; dailyCap: number; candidateCount: number;
      excludedCount: number; selectionFingerprint: string | null;
      eligibilityPolicyVersion: string | null; westernOnly: boolean | null;
      inboundWindowHours: number; completionWindowHours: number;
      decisionHash: string | null; audienceSegment: ExpandedSegment | null;
      rolloutGroupId: string | null; rolloutGroupHourlyCap: number | null;
    }>(`
      SELECT id, state::text, phase::text,
        selection_version AS "selectionVersion", source_data_cutoff AS "sourceDataCutoff",
        comment_from AS "commentFrom", comment_to AS "commentTo",
        selection_limit AS "selectionLimit", holdout_percent AS "holdoutPercent",
        copy_version AS "copyVersion", batch_size AS "batchSize", hourly_cap AS "hourlyCap",
        daily_cap AS "dailyCap", candidate_count AS "candidateCount",
        excluded_count AS "excludedCount", selection_fingerprint AS "selectionFingerprint",
        eligibility_policy_version AS "eligibilityPolicyVersion", western_only AS "westernOnly",
        inbound_window_hours AS "inboundWindowHours",
        completion_window_hours AS "completionWindowHours", decision_hash AS "decisionHash",
        audience_segment::text AS "audienceSegment", rollout_group_id::text AS "rolloutGroupId",
        rollout_group_hourly_cap AS "rolloutGroupHourlyCap"
      FROM recovery_campaign
      WHERE rollout_group_id=$1::uuid
      ORDER BY CASE audience_segment::text
        WHEN 'other' THEN 1 WHEN 'unknown_cue' THEN 2
        WHEN 'unknown_generic' THEN 3 WHEN 'unknown_no_name' THEN 4 ELSE 99 END, id`, [group]);

    const candidateResult = await client.query<{
      id: string; campaignId: string; selectionPosition: number | null; intentId: string;
      igUserId: string; conversationId: string | null; keywordId: string; commentId: string;
      mediaId: string | null; commentAt: Date; keywordSnapshot: string; publicReplyText: string;
      evidence: string; audienceOrigin: string | null; audienceOriginMethod: string | null;
      audienceOriginConfidence: string | null; audienceSegment: ExpandedSegment | null;
      arm: "treatment" | "holdout"; sourceChoiceReason: string | null;
      username: string | null; name: string | null; liveOrigin: string | null;
      liveMethod: string | null; liveConfidence: string | null; liveSegment: string | null;
    }>(`
      SELECT k.id::text, k.campaign_id::text AS "campaignId",
        k.selection_position AS "selectionPosition", k.intent_id::text AS "intentId",
        k.ig_user_id AS "igUserId", k.conversation_id::text AS "conversationId",
        k.keyword_id::text AS "keywordId", k.comment_id AS "commentId", k.media_id AS "mediaId",
        k.comment_at AS "commentAt", k.keyword_snapshot AS "keywordSnapshot",
        k.public_reply_text AS "publicReplyText", k.evidence,
        k.audience_origin AS "audienceOrigin", k.audience_origin_method AS "audienceOriginMethod",
        k.audience_origin_confidence AS "audienceOriginConfidence",
        k.audience_segment::text AS "audienceSegment", k.arm::text AS arm,
        k.source_choice_reason AS "sourceChoiceReason", u.username, u.name,
        u.inferred_origin AS "liveOrigin", u.origin_method AS "liveMethod",
        u.origin_confidence AS "liveConfidence", u.audience_segment::text AS "liveSegment"
      FROM recovery_candidate k
      JOIN recovery_campaign c ON c.id=k.campaign_id
      JOIN ig_users u ON u.id=k.ig_user_id
      WHERE c.rollout_group_id=$1::uuid
      ORDER BY CASE c.audience_segment::text
        WHEN 'other' THEN 1 WHEN 'unknown_cue' THEN 2
        WHEN 'unknown_generic' THEN 3 WHEN 'unknown_no_name' THEN 4 ELSE 99 END,
        k.selection_position, k.id`, [group]);

    const sourceResult = await client.query<{
      candidateId: string; position: number; commentId: string; mediaId: string | null;
      receivedAt: Date; choiceReason: string;
    }>(`
      SELECT s.candidate_id::text AS "candidateId", s.position,
        s.comment_id AS "commentId", s.media_id AS "mediaId",
        s.received_at AS "receivedAt", s.choice_reason AS "choiceReason"
      FROM recovery_candidate_source s
      JOIN recovery_candidate k ON k.id=s.candidate_id
      JOIN recovery_campaign c ON c.id=k.campaign_id
      WHERE c.rollout_group_id=$1::uuid
      ORDER BY s.candidate_id, s.position, s.id`, [group]);

    const exclusionResult = await client.query<{
      campaignId: string; intentId: string; igUserId: string; keywordId: string; reason: string;
    }>(`
      SELECT e.campaign_id::text AS "campaignId", e.intent_id::text AS "intentId",
        e.ig_user_id AS "igUserId", e.keyword_id::text AS "keywordId", e.reason
      FROM recovery_selection_exclusion e
      JOIN recovery_campaign c ON c.id=e.campaign_id
      WHERE c.rollout_group_id=$1::uuid
      ORDER BY e.campaign_id, e.intent_id, e.ig_user_id, e.keyword_id, e.reason`, [group]);

    const capacityResult = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM public_recovery_dispatch d
      JOIN recovery_campaign c ON c.id=d.campaign_id
      WHERE c.rollout_group_id=$1::uuid
        AND d.state IN ('reserved','dispatch_started','sent','uncertain')
        AND d.reserved_at > NOW()-INTERVAL '1 hour'`, [group]);

    const sourcesByCandidate = new Map<string, typeof sourceResult.rows>();
    for (const source of sourceResult.rows) {
      const rows = sourcesByCandidate.get(source.candidateId) ?? [];
      rows.push(source);
      sourcesByCandidate.set(source.candidateId, rows);
    }
    const candidatesByCampaign = new Map<string, typeof candidateResult.rows>();
    for (const candidate of candidateResult.rows) {
      const rows = candidatesByCampaign.get(candidate.campaignId) ?? [];
      rows.push(candidate);
      candidatesByCampaign.set(candidate.campaignId, rows);
    }
    const exclusionsByCampaign = new Map<string, typeof exclusionResult.rows>();
    for (const exclusion of exclusionResult.rows) {
      const rows = exclusionsByCampaign.get(exclusion.campaignId) ?? [];
      rows.push(exclusion);
      exclusionsByCampaign.set(exclusion.campaignId, rows);
    }

    const campaigns: ExpandedGroupAuditCampaign[] = campaignResult.rows.map((campaign) => {
      const candidates = candidatesByCampaign.get(campaign.id) ?? [];
      const exclusions = (exclusionsByCampaign.get(campaign.id) ?? []).map(
        ({ campaignId: _campaignId, ...row }) => row,
      );
      const inclusions = candidates.map((candidate) => ({
        position: candidate.selectionPosition ?? -1,
        intentId: candidate.intentId,
        igUserId: candidate.igUserId,
        conversationId: candidate.conversationId,
        keywordId: candidate.keywordId,
        commentId: candidate.commentId,
        mediaId: candidate.mediaId,
        commentAt: candidate.commentAt.toISOString(),
        keywordSnapshot: candidate.keywordSnapshot,
        publicReplyText: candidate.publicReplyText,
        evidence: candidate.evidence,
        audienceOrigin: candidate.audienceOrigin,
        audienceOriginMethod: candidate.audienceOriginMethod,
        audienceOriginConfidence: candidate.audienceOriginConfidence,
        audienceSegment: candidate.audienceSegment,
        arm: candidate.arm,
        sourceChoiceReason: candidate.sourceChoiceReason ?? "",
        sources: (sourcesByCandidate.get(candidate.id) ?? []).map((source) => ({
          position: source.position,
          commentId: source.commentId,
          mediaId: source.mediaId,
          receivedAt: source.receivedAt.toISOString(),
          choiceReason: source.choiceReason,
        })),
      }));
      const configuration = campaign.eligibilityPolicyVersion && campaign.westernOnly !== null
        ? {
            phase: campaign.phase as "confirmed_failure" | "unknown_read_pilot",
            selectionVersion: campaign.selectionVersion,
            sourceDataCutoff: campaign.sourceDataCutoff.toISOString(),
            commentFrom: campaign.commentFrom?.toISOString() ?? null,
            commentTo: campaign.commentTo?.toISOString() ?? null,
            selectionLimit: campaign.selectionLimit,
            westernOnly: campaign.westernOnly,
            holdoutPercent: campaign.holdoutPercent,
            copyVersion: campaign.copyVersion,
            eligibilityPolicyVersion: campaign.eligibilityPolicyVersion,
            inboundWindowHours: campaign.inboundWindowHours,
            completionWindowHours: campaign.completionWindowHours,
            audienceSegment: campaign.audienceSegment,
            rolloutGroupId: campaign.rolloutGroupId,
            rolloutGroupHourlyCap: campaign.rolloutGroupHourlyCap,
          }
        : null;
      const allCandidatesMatchLive = Boolean(campaign.audienceSegment)
        && candidates.every((candidate) =>
          candidate.audienceSegment === campaign.audienceSegment
          && candidate.liveSegment === campaign.audienceSegment
          && candidate.audienceOrigin === candidate.liveOrigin
          && candidate.audienceOriginMethod === candidate.liveMethod
          && candidate.audienceOriginConfidence === candidate.liveConfidence
          && hasExactHistoricalAudienceShape({
            username: candidate.username,
            name: candidate.name,
            segment: candidate.liveSegment,
            origin: candidate.liveOrigin,
            confidence: candidate.liveConfidence,
            method: candidate.liveMethod,
          }));
      return {
        id: campaign.id,
        state: campaign.state,
        phase: campaign.phase,
        audienceSegment: campaign.audienceSegment as ExpandedSegment,
        rolloutGroupId: campaign.rolloutGroupId ?? "",
        rolloutGroupHourlyCap: campaign.rolloutGroupHourlyCap ?? -1,
        selectionVersion: campaign.selectionVersion,
        copyVersion: campaign.copyVersion,
        eligibilityPolicyVersion: campaign.eligibilityPolicyVersion ?? "",
        holdoutPercent: campaign.holdoutPercent,
        batchSize: campaign.batchSize,
        hourlyCap: campaign.hourlyCap,
        dailyCap: campaign.dailyCap,
        candidateCount: campaign.candidateCount,
        excludedCount: campaign.excludedCount,
        allCandidatesMatchLive,
        snapshot: {
          configuration,
          selectionFingerprint: campaign.selectionFingerprint,
          decisionHash: campaign.decisionHash,
          candidateCount: campaign.candidateCount,
          excludedCount: campaign.excludedCount,
          inclusions,
          exclusions,
        },
      };
    });

    assertExpandedGroupAuditSnapshot({
      expectedGroupId: group,
      expectedCampaigns,
      expectedStates: states,
      expectedPhase: selectorPhase,
      rollingCapacity: Number(capacityResult.rows[0]?.count ?? "-1"),
      campaigns,
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      campaignIds: campaigns.map(({ id }) => id),
      candidateCount: campaigns.reduce((sum, campaign) => sum + campaign.candidateCount, 0),
      excludedCount: campaigns.reduce((sum, campaign) => sum + campaign.excludedCount, 0),
      rollingCapacity: Number(capacityResult.rows[0]?.count ?? "-1"),
    }) + "\n");
  } finally { await done(client); }
}
async function firstSend(): Promise<void> {
  const campaign = arg("--campaign"), timeout = Number(arg("--timeout-seconds")), deadline = Date.now() + timeout * 1000;
  for (;;) {
    const client = await readonlyClient();
    try {
      const rows = await client.query<{
        reply: string;
        text: string;
        candidateId: string;
        sourceKind: string;
        sourceId: string;
        dispatchCommentId: string | null;
        approvedSourceCommentIds: string[];
      }>(`
        SELECT c.public_reply_id AS reply,
          c.public_reply_text AS text,
          c.id AS "candidateId",
          d.source_kind::text AS "sourceKind",
          d.source_id::text AS "sourceId",
          c.dispatch_comment_id AS "dispatchCommentId",
          ARRAY(
            SELECT s.comment_id
            FROM recovery_candidate_source s
            WHERE s.candidate_id=c.id
            ORDER BY s.position, s.id
          ) AS "approvedSourceCommentIds"
        FROM recovery_candidate c
        JOIN recovery_campaign campaign ON campaign.id=c.campaign_id
        JOIN public_recovery_dispatch d
          ON d.campaign_id=c.campaign_id
         AND d.ig_user_id=c.ig_user_id
         AND d.source_kind='historical'
         AND d.source_id=c.id
        WHERE c.campaign_id=$1::uuid
          AND campaign.state IN ('running','completed')
          AND c.outcome='sent'
          AND d.state='sent'
          AND c.sent_at IS NOT NULL
          AND d.sent_at IS NOT NULL
          AND c.public_reply_id=d.provider_reply_id
        ORDER BY c.sent_at ASC, c.id, d.id`, [campaign]);
      const row = rows.rows.find(isAuthorizedFirstSendRow);
      if (row) {
        process.stdout.write(JSON.stringify({
          schemaVersion: 1,
          kind: "expanded-recovery-first-send",
          replyId: row.reply,
          parentCommentId: row.dispatchCommentId,
          text: row.text,
        }) + "\n");
        return;
      }
    } finally { await done(client); }
    if (Date.now() >= deadline) throw new Error("first send timeout");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  const main = command === "audit-live" ? auditLive : command === "assert-group" ? assertGroup : command === "audit-group" ? auditGroup : command === "first-send" ? firstSend : undefined;
  if (!main) throw new Error("commands: audit-live assert-group audit-group first-send");
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
