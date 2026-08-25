/**
 * One reviewed policy for every guide-access entry point.
 *
 * The action lifetime follows Meta's complete messaging window. The check and response
 * budgets are deliberately larger than the visible recovery ladder so the final promise
 * to "take one more look" always has a real follow check behind it.
 */
export const GUIDE_ACCESS_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const GUIDE_ACCESS_MAX_FOLLOW_CHECKS = 5;
export const GUIDE_ACCESS_MAX_FOLLOW_RESPONSES = 3;
