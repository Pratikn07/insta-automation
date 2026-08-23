export const GUIDE_COVER_CANVAS = { width: 1200, height: 916 } as const;

export const GUIDE_COVER_TEXT_RULES = {
  kicker: { maxCodePoints: 32, maxLines: 1 },
  collectionLabel: { maxCodePoints: 16, maxLines: 1 },
  headline: { maxCodePoints: 56, maxLines: 2 },
  supportingLine: { maxCodePoints: 90, maxLines: 2 },
  closingLine: { maxCodePoints: 64, maxLines: 2 },
  alternativeDescription: { maxCodePoints: 240, maxLines: 0 },
} as const;

export type GuideCoverTextField = keyof typeof GUIDE_COVER_TEXT_RULES;
export type GuideCoverDraftField = Exclude<
  GuideCoverTextField,
  "kicker" | "collectionLabel"
>;
export type GuideCoverRendition = "dm_cover" | "generic_card";
export type GuideCoverStableErrorCode =
  | "cover_invalid_input"
  | "cover_invalid_visual_key"
  | "cover_text_overflow";

export interface GuideCoverDraft {
  headline: string;
  supportingLine: string;
  closingLine: string;
  alternativeDescription: string;
}

export interface GuideCoverRenderInput extends GuideCoverDraft {
  categorySlug: string;
  editionNumber: number;
  kicker: string;
  collectionLabel: string;
  templateKey: string;
  paletteKey: string;
  illustrationKey: string;
}

export interface GuideCoverValidationError {
  code: GuideCoverStableErrorCode;
  field: GuideCoverTextField | "editionNumber";
  reason:
    | "character_limit"
    | "control_character"
    | "edition_range"
    | "markup"
    | "required";
}

export type GuideCoverValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GuideCoverValidationError };

const DRAFT_FIELDS = [
  "headline",
  "supportingLine",
  "closingLine",
  "alternativeDescription",
] as const satisfies readonly GuideCoverDraftField[];

const ENTITY_PATTERN = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/iu;
const MARKUP_PATTERN = /[<>]/u;

export function normalizeGuideCoverText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function hasDisallowedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;

    const isPermittedWhitespace =
      codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
    const isControl =
      (codePoint >= 0x00 && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f);
    const isFormattingControl =
      codePoint === 0x200b ||
      codePoint === 0x200c ||
      codePoint === 0x200d ||
      codePoint === 0x2060 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);

    if ((isControl && !isPermittedWhitespace) || isFormattingControl) {
      return true;
    }
  }

  return false;
}

function validateTextField(
  field: GuideCoverTextField,
  rawValue: string,
): GuideCoverValidationResult<string> {
  if (hasDisallowedControlCharacter(rawValue)) {
    return {
      ok: false,
      error: { code: "cover_invalid_input", field, reason: "control_character" },
    };
  }

  if (MARKUP_PATTERN.test(rawValue) || ENTITY_PATTERN.test(rawValue)) {
    return {
      ok: false,
      error: { code: "cover_invalid_input", field, reason: "markup" },
    };
  }

  const value = normalizeGuideCoverText(rawValue);
  if (value.length === 0) {
    return {
      ok: false,
      error: { code: "cover_invalid_input", field, reason: "required" },
    };
  }

  if ([...value].length > GUIDE_COVER_TEXT_RULES[field].maxCodePoints) {
    return {
      ok: false,
      error: { code: "cover_text_overflow", field, reason: "character_limit" },
    };
  }

  return { ok: true, value };
}

export function validateGuideCoverDraft(
  input: GuideCoverDraft,
): GuideCoverValidationResult<GuideCoverDraft> {
  const normalized = {} as GuideCoverDraft;

  for (const field of DRAFT_FIELDS) {
    const result = validateTextField(field, input[field]);
    if (!result.ok) return result;
    normalized[field] = result.value;
  }

  return { ok: true, value: normalized };
}

export function validateGuideCoverCategoryText(input: {
  kicker: string;
  collectionLabel: string;
}): GuideCoverValidationResult<{ kicker: string; collectionLabel: string }> {
  const kicker = validateTextField("kicker", input.kicker);
  if (!kicker.ok) return kicker;

  const collectionLabel = validateTextField(
    "collectionLabel",
    input.collectionLabel,
  );
  if (!collectionLabel.ok) return collectionLabel;

  return {
    ok: true,
    value: {
      kicker: kicker.value.toLocaleUpperCase("en-US"),
      collectionLabel: collectionLabel.value.toLocaleUpperCase("en-US"),
    },
  };
}

export function validateGuideCoverEdition(
  editionNumber: number,
): GuideCoverValidationResult<number> {
  if (
    !Number.isSafeInteger(editionNumber) ||
    editionNumber < 1 ||
    editionNumber > 999
  ) {
    return {
      ok: false,
      error: {
        code: "cover_invalid_input",
        field: "editionNumber",
        reason: "edition_range",
      },
    };
  }

  return { ok: true, value: editionNumber };
}
