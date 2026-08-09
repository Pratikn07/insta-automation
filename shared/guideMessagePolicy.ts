export const INSTAGRAM_GUIDE_TEXT_LIMIT = 1_000;
export const INSTAGRAM_GUIDE_WARNING_AT = 900;
export const MESSAGE_BODY_TOO_LONG_ERROR = "message_body_too_long" as const;

export function countInstagramCodeUnits(value: string): number {
  return value.length;
}

export function isInstagramGuideTextTooLong(value: string): boolean {
  return countInstagramCodeUnits(value) > INSTAGRAM_GUIDE_TEXT_LIMIT;
}

export const GUIDE_MESSAGE_LIMIT_GUIDANCE =
  "Instagram allows 1,000 characters per message. Shorten this message or add another Text step.";
