export type RecoveryCandidateKind =
  | "counter_constraint_review"
  | "swallowed_opening_action"
  | "logically_expired_active_token";

export type RecoveryMode =
  | "audit"
  | "normalize-token-status"
  | "release-counter-reviews"
  | "replay-swallowed-actions";

export type RecoveryAttemptInput = {
  attemptId: string;
  conversationId: string;
  senderId: string;
  resourceName: string;
  state:
    | "awaiting_request"
    | "checking_follow"
    | "awaiting_follow"
    | "delivering"
    | "delivered"
    | "needs_review"
    | "expired";
  lastFollowResult: "follower" | "non_follower" | "unknown";
  followCheckCount: number;
  followResponseCount: number;
  messagingWindowExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  hasDelivery: boolean;
  tokens: Array<{
    id: string;
    action: "request_guide" | "check_follow";
    status: "active" | "consumed" | "expired" | "cancelled";
    expiresAt: Date;
    createdAt: Date;
  }>;
  inboundMessages: Array<{ id: string; eventAt: Date }>;
};

export type RecoveryCandidate = {
  kind: RecoveryCandidateKind;
  attemptId: string;
  conversationId: string;
  senderId: string;
  resourceName: string;
  messagingWindowOpen: boolean;
  candidateAt: Date;
  tokenId?: string;
  inboundMessageId?: string;
  inboundEventAt?: Date;
};

export type RecoveryAudit = {
  candidates: RecoveryCandidate[];
  excluded: Record<string, number>;
};

export type RecoveryCliOptions = {
  mode: RecoveryMode;
  apply: boolean;
  expectedCount?: number;
  actor?: string;
  sendInstagram: boolean;
};

const MODES: ReadonlySet<string> = new Set([
  "audit",
  "normalize-token-status",
  "release-counter-reviews",
  "replay-swallowed-actions",
]);

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

/**
 * The incident starts with the strict-gate production commit. The end is the
 * recovery deployment, but no hard-coded end is needed: fixed code cannot
 * create a ten-minute request token, so the swallowed-action predicate becomes
 * false on its own.
 */
export const GUIDE_ACCESS_INCIDENT_STARTED_AT = new Date("2026-08-24T16:07:21.000Z");

export function classifyRecoveryCandidates(
  attempts: RecoveryAttemptInput[],
  now: Date,
  incidentStartedAt = GUIDE_ACCESS_INCIDENT_STARTED_AT,
): RecoveryAudit {
  const candidates: RecoveryCandidate[] = [];
  const excluded: Record<string, number> = {};

  for (const attempt of attempts) {
    const windowOpen = attempt.messagingWindowExpiresAt > now;

    for (const token of attempt.tokens) {
      if (token.status === "active" && token.expiresAt <= now) {
        candidates.push({
          kind: "logically_expired_active_token",
          attemptId: attempt.attemptId,
          conversationId: attempt.conversationId,
          senderId: attempt.senderId,
          resourceName: attempt.resourceName,
          messagingWindowOpen: windowOpen,
          candidateAt: token.expiresAt,
          tokenId: token.id,
        });
      }
    }

    const incidentAttempt = attempt.createdAt >= incidentStartedAt;
    if (
      attempt.state === "needs_review" &&
      attempt.lastFollowResult === "non_follower" &&
      attempt.followCheckCount === 3 &&
      attempt.followResponseCount === 2
    ) {
      if (!incidentAttempt) increment(excluded, "outside_incident_window");
      else if (attempt.hasDelivery) increment(excluded, "delivery_owns_recovery");
      else {
        candidates.push({
          kind: "counter_constraint_review",
          attemptId: attempt.attemptId,
          conversationId: attempt.conversationId,
          senderId: attempt.senderId,
          resourceName: attempt.resourceName,
          messagingWindowOpen: windowOpen,
          candidateAt: attempt.updatedAt,
        });
      }
    }

    if (attempt.state !== "awaiting_request") continue;
    const shortExpiredRequestTokens = attempt.tokens
      .filter(
        (token) =>
          token.action === "request_guide" &&
          // Already acted on, so not a swallowed tap however short its expiry looks.
          // `consumed` means the parent's tap WAS processed; `cancelled` means an owner
          // resend superseded it. Excluding both matters because a resend also returns the
          // attempt to `awaiting_request`, which would otherwise re-flag that parent's old
          // ten-minute token forever. The real incident tokens are all `expired`.
          token.status !== "consumed" &&
          token.status !== "cancelled" &&
          token.expiresAt <= now &&
          token.expiresAt < attempt.messagingWindowExpiresAt,
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    const token = shortExpiredRequestTokens[0];
    if (!token) continue;
    const inbound = attempt.inboundMessages
      .filter(
        (message) =>
          message.eventAt >= token.expiresAt &&
          message.eventAt < attempt.messagingWindowExpiresAt,
      )
      .sort((left, right) => left.eventAt.getTime() - right.eventAt.getTime())[0];
    if (!inbound) continue;
    if (!incidentAttempt) increment(excluded, "outside_incident_window");
    else if (attempt.hasDelivery) increment(excluded, "delivery_owns_recovery");
    else {
      candidates.push({
        kind: "swallowed_opening_action",
        attemptId: attempt.attemptId,
        conversationId: attempt.conversationId,
        senderId: attempt.senderId,
        resourceName: attempt.resourceName,
        messagingWindowOpen: windowOpen,
        candidateAt: inbound.eventAt,
        tokenId: token.id,
        inboundMessageId: inbound.id,
        inboundEventAt: inbound.eventAt,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.candidateAt.getTime() - right.candidateAt.getTime() ||
      left.kind.localeCompare(right.kind),
  );
  return { candidates, excluded };
}

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseRecoveryCliArgs(args: string[]): RecoveryCliOptions {
  const options: RecoveryCliOptions = {
    mode: "audit",
    apply: false,
    sendInstagram: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--apply") options.apply = true;
    else if (arg === "--send-instagram") options.sendInstagram = true;
    else if (arg === "--mode") {
      const value = valueAfter(args, index, arg);
      if (!MODES.has(value)) throw new Error(`unsupported recovery mode: ${value}`);
      options.mode = value as RecoveryMode;
      index += 1;
    } else if (arg === "--expected-count") {
      const value = valueAfter(args, index, arg);
      if (!/^\d+$/.test(value)) throw new Error("--expected-count must be a non-negative integer");
      options.expectedCount = Number(value);
      index += 1;
    } else if (arg === "--actor") {
      options.actor = valueAfter(args, index, arg).trim();
      index += 1;
    } else {
      throw new Error(`unsupported recovery option: ${arg}`);
    }
  }

  if (options.apply) {
    if (options.mode === "audit") throw new Error("audit mode is read-only");
    if (options.expectedCount === undefined) {
      throw new Error("--apply requires --expected-count from a fresh audit");
    }
    if (!options.actor) throw new Error("--apply requires --actor");
    if (options.mode === "replay-swallowed-actions" && !options.sendInstagram) {
      throw new Error("Instagram replay requires --send-instagram");
    }
  }
  if (options.sendInstagram && options.mode !== "replay-swallowed-actions") {
    throw new Error("--send-instagram is only valid for replay-swallowed-actions");
  }
  return options;
}

export function candidatesForMode(
  audit: RecoveryAudit,
  mode: RecoveryMode,
): RecoveryCandidate[] {
  if (mode === "normalize-token-status") {
    return audit.candidates.filter((row) => row.kind === "logically_expired_active_token");
  }
  if (mode === "release-counter-reviews") {
    return audit.candidates.filter((row) => row.kind === "counter_constraint_review");
  }
  if (mode === "replay-swallowed-actions") {
    // A historical action outside its messaging window is evidence for the audit,
    // not authority to contact a parent now.
    return audit.candidates.filter(
      (row) => row.kind === "swallowed_opening_action" && row.messagingWindowOpen,
    );
  }
  return audit.candidates;
}

function safeResourceName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || "Unnamed guide";
}

export function formatRecoveryAudit(
  audit: RecoveryAudit,
  mode: RecoveryMode = "audit",
): string {
  const selected = candidatesForMode(audit, mode);
  const lines = [
    "Guide access recovery audit (read-only unless --apply is present)",
    `Selected mode: ${mode}`,
    `Selected candidates: ${selected.length}`,
  ];
  const kinds: RecoveryCandidateKind[] = [
    "counter_constraint_review",
    "swallowed_opening_action",
    "logically_expired_active_token",
  ];
  for (const kind of kinds) {
    const rows = audit.candidates.filter((candidate) => candidate.kind === kind);
    const open = rows.filter((candidate) => candidate.messagingWindowOpen).length;
    lines.push(`${kind}: ${rows.length} (${open} open, ${rows.length - open} closed)`);
    const resources = new Map<string, number>();
    for (const row of rows) {
      const name = safeResourceName(row.resourceName);
      resources.set(name, (resources.get(name) ?? 0) + 1);
    }
    for (const [name, count] of [...resources].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`  ${name}: ${count}`);
    }
    if (rows.length > 0) {
      lines.push(`  oldest: ${rows[0]!.candidateAt.toISOString()}`);
      lines.push(`  newest: ${rows.at(-1)!.candidateAt.toISOString()}`);
    }
  }
  for (const [reason, count] of Object.entries(audit.excluded).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`excluded/${reason}: ${count}`);
  }
  return lines.join("\n");
}

export type RecoveryExecutionDependencies = {
  load(): Promise<RecoveryAudit>;
  normalizeTokenStatus(candidates: RecoveryCandidate[], actor: string): Promise<number>;
  releaseCounterReviews(candidates: RecoveryCandidate[], actor: string): Promise<number>;
  replaySwallowedAction(candidate: RecoveryCandidate, actor: string): Promise<"handled" | "needs_review">;
};

export async function executeRecoveryCommand(
  options: RecoveryCliOptions,
  dependencies: RecoveryExecutionDependencies,
): Promise<string> {
  const audit = await dependencies.load();
  const selected = candidatesForMode(audit, options.mode);
  const report = formatRecoveryAudit(audit, options.mode);
  if (!options.apply) return report;
  if (options.expectedCount !== selected.length) {
    throw new Error(
      `candidate count drift: expected ${options.expectedCount}, freshly selected ${selected.length}`,
    );
  }
  const actor = options.actor!;
  let changed = 0;
  if (options.mode === "normalize-token-status") {
    changed = await dependencies.normalizeTokenStatus(selected, actor);
  } else if (options.mode === "release-counter-reviews") {
    changed = await dependencies.releaseCounterReviews(selected, actor);
  } else if (options.mode === "replay-swallowed-actions") {
    for (const candidate of selected) {
      const outcome = await dependencies.replaySwallowedAction(candidate, actor);
      changed += 1;
      if (outcome === "needs_review") {
        throw new Error("Instagram replay stopped after an uncertain outcome; review the creator queue");
      }
    }
  }
  if (changed !== selected.length) {
    throw new Error(`write fence changed ${changed} rows; freshly selected ${selected.length}`);
  }
  return `${report}\nApplied: ${changed}`;
}
