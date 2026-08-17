import {
  countInstagramCodePoints,
  INSTAGRAM_GUIDE_TEXT_LIMIT,
  INSTAGRAM_GUIDE_WARNING_AT,
} from "@shared/guideMessagePolicy";

/** @deprecated Import the shared guide-message policy directly in production code. */
export const IG_TEXT_CHAR_LIMIT = INSTAGRAM_GUIDE_TEXT_LIMIT;
/** @deprecated Import the shared guide-message policy directly in production code. */
export const IG_TEXT_CHAR_WARN = INSTAGRAM_GUIDE_WARNING_AT;
/** @deprecated Import countInstagramCodePoints directly in production code. */
export const textChars = countInstagramCodePoints;

export type BudgetLevel = "ok" | "near" | "over";

export interface MessageBudget {
  chars: number;
  limit: number;
  level: BudgetLevel;
  /** Characters beyond the limit; 0 when within it. */
  over: number;
}

export function messageBudget(text: string): MessageBudget {
  const chars = textChars(text);
  const level: BudgetLevel =
    chars > IG_TEXT_CHAR_LIMIT ? "over" : chars >= IG_TEXT_CHAR_WARN ? "near" : "ok";
  return {
    chars,
    limit: IG_TEXT_CHAR_LIMIT,
    level,
    over: Math.max(0, chars - IG_TEXT_CHAR_LIMIT),
  };
}
