import { createHash } from "node:crypto";
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
  origin: "resource_step" | "redelivery_intro";
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
};

type CompiledGuideDeliveryUnit = PlannedGuideDeliveryUnit & {
  authoredOrder: number | null;
};

type UnitWithoutPosition = Omit<CompiledGuideDeliveryUnit, "position" | "contentFingerprint">;

function contentFingerprint(unit: UnitWithoutPosition): string {
  return createHash("sha256")
    .update(unit.kind)
    .update("\0")
    .update(unit.textSnapshot ?? unit.mediaUrlSnapshot ?? "")
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
    units: compiledUnits.map(({ authoredOrder: _authoredOrder, ...unit }) => unit),
  };
}
