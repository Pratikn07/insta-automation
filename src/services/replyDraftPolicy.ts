export const CURRENT_DM_PROMPT_VERSION = 2;
export const FOLLOW_UP_DELAY_MS = 12 * 60 * 60 * 1000;
export const FOLLOW_UP_WINDOW_MS = 23.5 * 60 * 60 * 1000;

export function computeFollowUpSchedule(input: {
  deliveredAt: Date;
  inboundAt: Date;
}): { eligibleAt: Date; expiresAt: Date } | null {
  const eligibleAt = new Date(input.deliveredAt.getTime() + FOLLOW_UP_DELAY_MS);
  const expiresAt = new Date(input.inboundAt.getTime() + FOLLOW_UP_WINDOW_MS);
  return eligibleAt < expiresAt ? { eligibleAt, expiresAt } : null;
}

export function isCurrentPromptVersion(value: number | null): boolean {
  return value === CURRENT_DM_PROMPT_VERSION;
}
