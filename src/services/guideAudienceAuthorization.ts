import { createHash } from "node:crypto";
import type {
  GuideAudienceActionSource,
  GuideAudienceConfidence,
  GuideAudienceDeferReason,
  GuideAudienceOrigin,
} from "@prisma/client";
import { isAxiosError } from "axios";
import { env } from "../config/env.js";
import { geminiEnabled } from "../meta/geminiClient.js";
import { flags } from "./flagService.js";
import {
  guideAudienceAuthorizationRepository,
  type GuideAudienceAuthorizationRepository,
  type GuideAudienceSubject,
} from "./guideAudienceAuthorizationRepository.js";
import {
  classifyIdentityPresence,
  CURRENT_ORIGIN_METHOD,
} from "./historicalAudienceSegment.js";
import { classifyOrigins } from "./originClassifier.js";
import {
  compareAndSetOrigin,
  originVerdictWriteData,
  readStoredOrigin,
} from "./originVerdictStore.js";

export type { GuideAudienceAuthorizationRepository } from "./guideAudienceAuthorizationRepository.js";

export const GUIDE_AUDIENCE_PROVIDER = "gemini" as const;

/**
 * Same 80-char cap the classifier's roster applies, so the hashed snapshot and
 * the classified snapshot are the same string.
 */
const IDENTITY_FIELD_LIMIT = 80;

export type AuthorizeNewGuideActionInput = {
  igUserId: string;
  source: GuideAudienceActionSource;
  conversationId?: string;
  commentId?: string;
  inboundMessageId?: string;
  resourceId?: string;
};

export type GuideAudienceAuthorization =
  | { kind: "allow" }
  | { kind: "block"; auditId: string | null };

export type GuideAudienceAuthorizationServiceDependencies = {
  repository: GuideAudienceAuthorizationRepository;
  classify: typeof classifyOrigins;
  persistVerdict: typeof compareAndSetOrigin;
  isEnabled(): boolean;
  classifierEnabled: boolean;
  timeoutMs: number;
  now?: () => Date;
};

const ALLOW: GuideAudienceAuthorization = { kind: "allow" };

function safeIdentityField(value: string | null): string {
  if (!value) return "";
  return value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, IDENTITY_FIELD_LIMIT);
}

/**
 * guide_audience_decision.identity_hash is CHAR(64) NOT NULL: the audit row
 * anchors to an identity without storing the name or username.
 */
function identitySnapshot(subject: GuideAudienceSubject): {
  name: string;
  username: string;
  hash: string;
} {
  const name = safeIdentityField(subject.name);
  const username = safeIdentityField(subject.username);
  return {
    name,
    username,
    hash: createHash("sha256").update(JSON.stringify({ name, username })).digest("hex"),
  };
}

function unverifiedReason(error: unknown): GuideAudienceDeferReason {
  if (isAxiosError(error) && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")) {
    return "provider_timeout";
  }
  return "provider_unavailable";
}

export function createGuideAudienceAuthorizationService(
  dependencies: GuideAudienceAuthorizationServiceDependencies,
) {
  const now = dependencies.now ?? (() => new Date());

  async function block(
    input: AuthorizeNewGuideActionInput,
    identityHash: string,
    origin: GuideAudienceOrigin,
    confidence: GuideAudienceConfidence,
  ): Promise<GuideAudienceAuthorization> {
    try {
      const audit = await dependencies.repository.createDecision({
        ...input,
        identityHash,
        kind: "block",
        origin,
        confidence,
        provider: GUIDE_AUDIENCE_PROVIDER,
        modelId: env.GEMINI_MODEL,
        method: CURRENT_ORIGIN_METHOD,
      });
      return { kind: "block", auditId: audit.id };
    } catch {
      // An unauditable block is still a block. The verdict was explicit; only
      // the record of it was lost.
      return { kind: "block", auditId: null };
    }
  }

  /**
   * No verdict, and the send goes out. Recorded so the operator can tell a
   * policy decision from a broken classifier: more than a few percent of these
   * means raise GUIDE_AUDIENCE_TIMEOUT_MS, not change the policy.
   */
  async function allowUnverified(
    input: AuthorizeNewGuideActionInput,
    identityHash: string,
    reason: GuideAudienceDeferReason,
  ): Promise<GuideAudienceAuthorization> {
    try {
      await dependencies.repository.createDecision({
        ...input,
        identityHash,
        kind: "allow_unverified",
        deferReason: reason,
        provider: GUIDE_AUDIENCE_PROVIDER,
        modelId: env.GEMINI_MODEL,
        method: CURRENT_ORIGIN_METHOD,
      });
    } catch {
      // Audit-only. Losing the row must not change the send.
    }
    return ALLOW;
  }

  return {
    async authorizeNewGuideAction(
      input: AuthorizeNewGuideActionInput,
    ): Promise<GuideAudienceAuthorization> {
      try {
        if (!dependencies.isEnabled()) return ALLOW;
      } catch {
        return ALLOW;
      }

      let subject: GuideAudienceSubject | null;
      try {
        subject = await dependencies.repository.findAudienceSubject(input.igUserId);
      } catch {
        return ALLOW;
      }
      // An absent row is a miss with nothing to classify, not an error.
      if (!subject) return ALLOW;

      const snapshot = identitySnapshot(subject);

      const stored = readStoredOrigin(subject);
      if (stored) {
        return stored.origin === "south_asian"
          ? block(input, snapshot.hash, "south_asian", stored.confidence)
          : ALLOW;
      }

      // Nothing to screen. Gemini's own answer for an empty roster entry is
      // `unknown`, which sends anyway, so skip the call and the cost. This is
      // the worker's own predicate, so "-" and "---" count as absent here too
      // rather than being billed as a name.
      const absent = classifyIdentityPresence({
        username: subject.username,
        name: subject.name,
      });
      if (absent) return ALLOW;
      if (!dependencies.classifierEnabled) return ALLOW;

      let result;
      try {
        result = await dependencies.classify(
          [{ id: subject.id, username: subject.username, name: subject.name }],
          { timeoutMs: dependencies.timeoutMs },
        );
      } catch (error) {
        return allowUnverified(input, snapshot.hash, unverifiedReason(error));
      }

      const verdict = result.verdicts.find((candidate) => candidate.id === subject.id);
      if (!verdict) {
        return allowUnverified(input, snapshot.hash, "invalid_provider_response");
      }

      // Write back through the identity-guarded path so the next interaction —
      // and the DM-recovery gate — read the same verdict from the same column.
      // A rename between the read and here makes this a no-op rather than
      // stamping the new identity with the old one's answer.
      try {
        await dependencies.persistVerdict([
          {
            candidate: { id: subject.id, username: subject.username, name: subject.name },
            data: originVerdictWriteData(verdict, now()),
          },
        ]);
      } catch {
        // Cache-only. The verdict in hand still decides this action.
      }

      return verdict.origin === "south_asian"
        ? block(input, snapshot.hash, "south_asian", verdict.confidence)
        : ALLOW;
    },
  };
}

export const guideAudienceAuthorization = createGuideAudienceAuthorizationService({
  repository: guideAudienceAuthorizationRepository,
  classify: classifyOrigins,
  persistVerdict: compareAndSetOrigin,
  isEnabled: () => flags.bool("GUIDE_AUDIENCE_BLOCK_ENABLED"),
  classifierEnabled: geminiEnabled,
  timeoutMs: env.GUIDE_AUDIENCE_TIMEOUT_MS,
});
