import { createHash } from "node:crypto";
import type {
  GuideAudienceActionSource,
  GuideAudienceDeferReason,
} from "@prisma/client";
import { env } from "../config/env.js";
import { flags } from "./flagService.js";
import {
  guideAudienceAuthorizationRepository,
  type CurrentGuideAudienceClassification,
  type GuideAudienceAuthorizationRepository,
} from "./guideAudienceAuthorizationRepository.js";
import {
  NVIDIA_AUDIENCE_FIELD_LIMIT,
  NVIDIA_AUDIENCE_PROVIDER,
  NvidiaAudienceClassifierError,
  nvidiaAudienceClassifier,
  type AudienceClassificationProvider,
} from "./nvidiaAudienceClassifier.js";

export type { GuideAudienceAuthorizationRepository } from "./guideAudienceAuthorizationRepository.js";

export type AuthorizeNewGuideActionInput = {
  igUserId: string;
  source: GuideAudienceActionSource;
  conversationId?: string;
  commentId?: string;
  inboundMessageId?: string;
  resourceId?: string;
};

export type GuideAudienceAuthorization =
  | { kind: "allow"; enforced: false }
  | {
      kind: "allow";
      enforced: true;
      classification: CurrentGuideAudienceClassification;
    }
  | {
      kind: "block";
      auditId: string;
      classification: CurrentGuideAudienceClassification;
    }
  | { kind: "defer"; auditId: string | null; reason: GuideAudienceDeferReason };

export type GuideAudienceAuthorizationServiceDependencies = {
  repository: GuideAudienceAuthorizationRepository;
  provider: AudienceClassificationProvider;
  isEnabled(): boolean;
  configuredModelId: string;
  now?: () => Date;
};

function safeIdentityField(value: string | null): string {
  if (!value) return "";
  return value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, NVIDIA_AUDIENCE_FIELD_LIMIT);
}

function identitySnapshot(name: string | null, username: string | null): {
  name: string;
  username: string;
  hash: string;
} {
  const normalizedName = safeIdentityField(name);
  const normalizedUsername = safeIdentityField(username);
  const canonical = JSON.stringify({ name: normalizedName, username: normalizedUsername });
  return {
    name: normalizedName,
    username: normalizedUsername,
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

function providerErrorReason(error: unknown): GuideAudienceDeferReason {
  if (error instanceof NvidiaAudienceClassifierError) {
    if (error.category === "provider_timeout") return "provider_timeout";
    if (error.category === "invalid_provider_response") return "invalid_provider_response";
  }
  return "provider_unavailable";
}

export function createGuideAudienceAuthorizationService(
  dependencies: GuideAudienceAuthorizationServiceDependencies,
) {
  const now = dependencies.now ?? (() => new Date());

  async function recordDefer(
    input: AuthorizeNewGuideActionInput,
    identityHash: string,
    reason: GuideAudienceDeferReason,
    modelId: string,
  ): Promise<Extract<GuideAudienceAuthorization, { kind: "defer" }>> {
    try {
      const audit = await dependencies.repository.createDecision({
        ...input,
        identityHash,
        kind: "defer",
        deferReason: reason,
        provider: NVIDIA_AUDIENCE_PROVIDER,
        modelId,
        method: "nvidia_guide_audience_v1",
      });
      return { kind: "defer", auditId: audit.id, reason };
    } catch {
      // A database outage cannot be durably audited. It still must never become
      // a send; callers treat this exactly as every other defer.
      return { kind: "defer", auditId: null, reason: "persistence_failed" };
    }
  }

  async function decideCurrentClassification(
    input: AuthorizeNewGuideActionInput,
    classification: CurrentGuideAudienceClassification,
  ): Promise<GuideAudienceAuthorization> {
    if (classification.origin !== "south_asian") {
      return { kind: "allow", enforced: true, classification };
    }

    try {
      const audit = await dependencies.repository.createDecision({
        ...input,
        identityHash: classification.identityHash,
        kind: "block",
        classificationId: classification.id,
        provider: classification.provider,
        modelId: classification.modelId,
        method: classification.method,
      });
      return { kind: "block", auditId: audit.id, classification };
    } catch {
      return recordDefer(
        input,
        classification.identityHash,
        "persistence_failed",
        classification.modelId,
      );
    }
  }

  return {
    async authorizeNewGuideAction(
      input: AuthorizeNewGuideActionInput,
    ): Promise<GuideAudienceAuthorization> {
      // Read the operator-controlled flag for every candidate action. Disabled
      // means exactly unchanged historical behavior and no provider traffic.
      try {
        if (!dependencies.isEnabled()) return { kind: "allow", enforced: false };
      } catch {
        return { kind: "defer", auditId: null, reason: "persistence_failed" };
      }

      let initialIdentity;
      try {
        initialIdentity = await dependencies.repository.findCurrentIdentity(input.igUserId);
      } catch {
        return recordDefer(
          input,
          identitySnapshot(null, null).hash,
          "persistence_failed",
          dependencies.configuredModelId,
        );
      }
      const snapshot = identitySnapshot(initialIdentity?.name ?? null, initialIdentity?.username ?? null);
      if (!initialIdentity || (!snapshot.name && !snapshot.username)) {
        return recordDefer(
          input,
          snapshot.hash,
          "identity_unavailable",
          dependencies.configuredModelId,
        );
      }

      try {
        const cached = await dependencies.repository.findCurrentClassification({
          igUserId: input.igUserId,
          identityHash: snapshot.hash,
          method: "nvidia_guide_audience_v1",
        });
        if (cached) return decideCurrentClassification(input, cached);
      } catch {
        return recordDefer(
          input,
          snapshot.hash,
          "persistence_failed",
          dependencies.configuredModelId,
        );
      }

      let providerResult;
      try {
        providerResult = await dependencies.provider.classify([
          {
            id: input.igUserId,
            name: snapshot.name,
            username: snapshot.username,
          },
        ]);
      } catch (error) {
        return recordDefer(
          input,
          snapshot.hash,
          providerErrorReason(error),
          dependencies.configuredModelId,
        );
      }

      const verdict = providerResult.verdicts.length === 1 ? providerResult.verdicts[0] : null;
      if (!verdict || verdict.id !== input.igUserId) {
        return recordDefer(
          input,
          snapshot.hash,
          "invalid_provider_response",
          providerResult.modelId,
        );
      }

      // The provider works on a snapshot, not a person. Re-read immediately
      // before persistence so a profile rename cannot authorize a later identity.
      try {
        const currentIdentity = await dependencies.repository.findCurrentIdentity(input.igUserId);
        const currentSnapshot = identitySnapshot(
          currentIdentity?.name ?? null,
          currentIdentity?.username ?? null,
        );
        if (!currentIdentity || currentSnapshot.hash !== snapshot.hash) {
          return recordDefer(input, snapshot.hash, "identity_changed", providerResult.modelId);
        }
      } catch {
        return recordDefer(
          input,
          snapshot.hash,
          "persistence_failed",
          providerResult.modelId,
        );
      }

      let classification: CurrentGuideAudienceClassification;
      try {
        classification = await dependencies.repository.createClassification({
          igUserId: input.igUserId,
          identityHash: snapshot.hash,
          origin: verdict.origin,
          confidence: verdict.confidence,
          evidence: verdict.evidence,
          provider: NVIDIA_AUDIENCE_PROVIDER,
          modelId: providerResult.modelId,
          method: providerResult.method,
          classifiedAt: now(),
        });
      } catch {
        return recordDefer(
          input,
          snapshot.hash,
          "persistence_failed",
          providerResult.modelId,
        );
      }

      return decideCurrentClassification(input, classification);
    },
  };
}

export const guideAudienceAuthorization = createGuideAudienceAuthorizationService({
  repository: guideAudienceAuthorizationRepository,
  provider: nvidiaAudienceClassifier,
  isEnabled: () => flags.bool("GUIDE_AUDIENCE_BLOCK_ENABLED"),
  configuredModelId: env.NVIDIA_AUDIENCE_MODEL,
});
