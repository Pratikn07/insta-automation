import { Client } from "pg";
import { classifyIdentityPresence, evaluateHistoricalAudience } from "../src/services/historicalAudienceSegment.js";

type AudienceRow = { username: string | null; name: string | null; segment: string | null; origin: string | null; confidence: string | null; method: string | null };

export function hasExactHistoricalAudienceShape(row: AudienceRow): boolean {
  const identity = classifyIdentityPresence(row);
  const decision = evaluateHistoricalAudience({ segment: row.segment, origin: row.origin, confidence: row.confidence, method: row.method });
  if (identity === "unknown_no_name") return row.segment === "unknown_no_name" && row.origin === "unknown" && row.confidence === "low" && row.method === "llm_v3";
  return decision.kind !== "defer" && row.segment !== "unknown_no_name";
}

async function readonlyClient(): Promise<Client> {
  const connectionString = process.env.PGURL;
  if (!connectionString) throw new Error("PGURL is required through the environment, never argv");
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("BEGIN READ ONLY");
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
  const group = arg("--group"), phase = arg("--phase");
  const client = await readonlyClient();
  try {
    const bad = await client.query<{ count: string }>(`
      WITH duplicates AS (SELECT k.ig_user_id FROM recovery_candidate k JOIN recovery_campaign c ON c.id=k.campaign_id WHERE c.rollout_group_id=$1::uuid GROUP BY k.ig_user_id HAVING COUNT(*)>1),
      capacity AS (SELECT COUNT(*) AS n FROM public_recovery_dispatch d JOIN recovery_campaign c ON c.id=d.campaign_id WHERE c.rollout_group_id=$1::uuid AND d.state IN ('reserved','dispatch_started','sent','uncertain') AND d.reserved_at > NOW()-INTERVAL '1 hour')
      SELECT COUNT(*)::text AS count FROM recovery_campaign c
      LEFT JOIN recovery_candidate k ON k.campaign_id=c.id LEFT JOIN ig_users u ON u.id=k.ig_user_id
      WHERE c.rollout_group_id=$1::uuid AND (c.state::text<>ALL(string_to_array($2,'|')) OR c.audience_segment NOT IN ('other','unknown_cue','unknown_generic','unknown_no_name') OR c.holdout_percent<>0 OR c.batch_size<>1 OR c.hourly_cap<>10 OR c.daily_cap<>1000 OR c.rollout_group_hourly_cap<>10 OR c.selection_fingerprint IS NULL OR c.decision_hash IS NULL OR EXISTS(SELECT 1 FROM duplicates) OR (SELECT n FROM capacity)>10 OR (k.id IS NOT NULL AND (k.audience_segment IS DISTINCT FROM c.audience_segment OR k.audience_segment IS DISTINCT FROM u.audience_segment OR k.audience_origin IS DISTINCT FROM u.inferred_origin OR k.audience_origin_method IS DISTINCT FROM u.origin_method OR k.audience_origin_confidence IS DISTINCT FROM u.origin_confidence)))`, [group, phase]);
    if (bad.rows[0]?.count !== "0") throw new Error(`group audit failures=${bad.rows[0]?.count}`);
    process.stdout.write('{"ok":true}\n');
  } finally { await done(client); }
}
async function firstSend(): Promise<void> {
  const campaign = arg("--campaign"), timeout = Number(arg("--timeout-seconds")), deadline = Date.now() + timeout * 1000;
  for (;;) {
    const client = await readonlyClient();
    try {
      const row = await client.query<{ reply: string; parent: string; text: string }>(`
        SELECT c.public_reply_id AS reply, c.dispatch_comment_id AS parent, c.public_reply_text AS text
        FROM recovery_candidate c JOIN public_recovery_dispatch d ON d.campaign_id=c.campaign_id AND d.ig_user_id=c.ig_user_id
        WHERE c.campaign_id=$1::uuid AND c.outcome='sent' AND d.state='sent' AND c.sent_at IS NOT NULL AND d.sent_at IS NOT NULL AND c.public_reply_id=d.provider_reply_id
        ORDER BY c.sent_at ASC LIMIT 1`, [campaign]);
      if (row.rows[0]) { const r = row.rows[0]; process.stdout.write(`${r.reply}\t${r.parent}\t${r.text}\n`); return; }
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
