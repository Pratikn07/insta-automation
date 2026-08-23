import { createHash } from "node:crypto";
import type { GuideDeliveryUnitOrigin } from "@prisma/client";
import {
  INSTAGRAM_GUIDE_TEXT_LIMIT,
  countInstagramCodePoints,
} from "../../shared/guideMessagePolicy.js";

export type AuthoredGuideMessage = {
  id: string;
  order: number;
  type: "text" | "image" | "pdf";
  body: string | null;
  mediaUrl: string | null;
};

export type GuideDeliveryTriggerKind =
  | "inbound_reply"
  | "explicit_redelivery"
  | "follow_recovery";

export type PlannedGuideDeliveryUnit = {
  resourceMessageId: string | null;
  position: number;
  // Derived from the database enum rather than hand-written, so appending a label in
  // a migration cannot silently leave this union behind. That drift is exactly what
  // happened when `generated_cover` was added.
  origin: GuideDeliveryUnitOrigin;
  kind: "text" | "image" | "file";
  textSnapshot: string | null;
  mediaUrlSnapshot: string | null;
  contentFingerprint: string;
};

export type GuidePreflightError = {
  code: "text_missing" | "text_too_long" | "media_url_missing";
  resourceMessageId: string | null;
  authoredOrder: number | null;
  unitKind: "text" | "image" | "file";
  actualLength: number | null;
  limit: number | null;
};

export type GuideDeliveryPlanResult =
  | { ok: true; units: PlannedGuideDeliveryUnit[] }
  | { ok: false; error: GuidePreflightError };

export type CompileGuideDeliveryPlanInput = {
  messages: readonly AuthoredGuideMessage[];
  triggerKind: GuideDeliveryTriggerKind;
  redeliveryIntro?: string;
  /**
   * The immutable published cover snapshotted onto this access attempt. `mediaUrl` is a
   * resolved public URL, never a bucket path — the planner performs no storage work.
   *
   * The caller is responsible for having checked that this cover belongs to the same
   * guide as `messages`; the planner cannot see the resource and will happily prepend
   * whatever it is handed.
   */
  cover?: { versionId: string; mediaUrl: string };
  /**
   * True when the parent already accepted this cover during the follower gate. The cover
   * is then omitted so nobody receives it twice.
   */
  coverAlreadyShown?: boolean;
};

type CompiledGuideDeliveryUnit = PlannedGuideDeliveryUnit & {
  authoredOrder: number | null;
  /**
   * Extra identity folded into the fingerprint and nothing else. Stripped before the
   * plan is returned and never persisted.
   */
  fingerprintIdentity?: string | null;
};

type UnitWithoutPosition = Omit<CompiledGuideDeliveryUnit, "position" | "contentFingerprint">;

/**
 * Origin and identity are part of the hash, not just kind and content.
 *
 * Without origin, an authored image and a generated cover pointing at the same URL
 * produce the same fingerprint despite being structurally different units. Without the
 * cover's version id, two cover versions that happen to resolve to one URL are
 * indistinguishable.
 *
 * Fields are LENGTH-PREFIXED rather than separated by a sentinel byte. `textSnapshot` is
 * owner-authored free text, so a NUL inside it could otherwise shift the field boundaries
 * and let two different units hash alike. A length prefix is unambiguous for any content.
 *
 * Changing this formula is safe: `content_fingerprint` is written to
 * `guide_delivery_unit` and never read back anywhere in `src/`, so no replay or
 * idempotency behaviour depends on its value.
 */
function fingerprintField(value: string): string {
  return `${value.length}:${value}`;
}

function contentFingerprint(unit: UnitWithoutPosition): string {
  return createHash("sha256")
    .update(fingerprintField(unit.kind))
    .update(fingerprintField(unit.origin))
    .update(fingerprintField(unit.fingerprintIdentity ?? ""))
    .update(fingerprintField(unit.textSnapshot ?? unit.mediaUrlSnapshot ?? ""))
    .digest("hex");
}

function appendUnit(units: CompiledGuideDeliveryUnit[], unit: UnitWithoutPosition): void {
  units.push({
    ...unit,
    position: units.length,
    contentFingerprint: contentFingerprint(unit),
  });
}

function compileUnits(input: CompileGuideDeliveryPlanInput): CompiledGuideDeliveryUnit[] {
  const units: CompiledGuideDeliveryUnit[] = [];

  if (input.triggerKind === "explicit_redelivery") {
    appendUnit(units, {
      resourceMessageId: null,
      authoredOrder: null,
      origin: "redelivery_intro",
      kind: "text",
      textSnapshot: input.redeliveryIntro ?? null,
      mediaUrlSnapshot: null,
    });
  }

  // Spec: "the guide planner prepends one image unit" — ahead of the resource steps,
  // which is satisfied here. Placed AFTER a redelivery intro on purpose: leading a
  // redelivery with a bare image gives the parent a picture before any context, and the
  // intro explains why they are receiving it again. Exactly one cover, because it is
  // appended once here and nowhere else.
  if (input.cover && input.coverAlreadyShown !== true) {
    appendUnit(units, {
      resourceMessageId: null,
      authoredOrder: null,
      origin: "generated_cover",
      kind: "image",
      textSnapshot: null,
      mediaUrlSnapshot: input.cover.mediaUrl,
      fingerprintIdentity: input.cover.versionId,
    });
  }

  const orderedMessages = [...input.messages].sort((left, right) => left.order - right.order);
  for (const message of orderedMessages) {
    if (message.type === "text") {
      appendUnit(units, {
        resourceMessageId: message.id,
        authoredOrder: message.order,
        origin: "resource_step",
        kind: "text",
        textSnapshot: message.body,
        mediaUrlSnapshot: null,
      });
      continue;
    }

    appendUnit(units, {
      resourceMessageId: message.id,
      authoredOrder: message.order,
      origin: "resource_step",
      kind: message.type === "image" ? "image" : "file",
      textSnapshot: null,
      mediaUrlSnapshot: message.mediaUrl,
    });

    if (message.body !== null && message.body !== "") {
      appendUnit(units, {
        resourceMessageId: message.id,
        authoredOrder: message.order,
        origin: "resource_step",
        kind: "text",
        textSnapshot: message.body,
        mediaUrlSnapshot: null,
      });
    }
  }

  return units;
}

function validateUnits(units: readonly CompiledGuideDeliveryUnit[]): GuidePreflightError | null {
  for (const unit of units) {
    if (unit.kind !== "text") {
      if (unit.mediaUrlSnapshot === null || unit.mediaUrlSnapshot === "") {
        return {
          code: "media_url_missing",
          resourceMessageId: unit.resourceMessageId,
          authoredOrder: unit.authoredOrder,
          unitKind: unit.kind,
          actualLength: null,
          limit: null,
        };
      }
      continue;
    }

    const actualLength = countInstagramCodePoints(unit.textSnapshot ?? "");
    if (unit.textSnapshot === null || unit.textSnapshot === "") {
      return {
        code: "text_missing",
        resourceMessageId: unit.resourceMessageId,
        authoredOrder: unit.authoredOrder,
        unitKind: unit.kind,
        actualLength,
        limit: INSTAGRAM_GUIDE_TEXT_LIMIT,
      };
    }

    if (actualLength > INSTAGRAM_GUIDE_TEXT_LIMIT) {
      return {
        code: "text_too_long",
        resourceMessageId: unit.resourceMessageId,
        authoredOrder: unit.authoredOrder,
        unitKind: unit.kind,
        actualLength,
        limit: INSTAGRAM_GUIDE_TEXT_LIMIT,
      };
    }
  }

  return null;
}

/** Compiles every outbound call before preflighting any unit; this module never sends. */
export function compileGuideDeliveryPlan(
  input: CompileGuideDeliveryPlanInput,
): GuideDeliveryPlanResult {
  const compiledUnits = compileUnits(input);
  const error = validateUnits(compiledUnits);
  if (error) return { ok: false, error };

  return {
    ok: true,
    units: compiledUnits.map(
      ({ authoredOrder: _authoredOrder, fingerprintIdentity: _identity, ...unit }) => unit,
    ),
  };
}
