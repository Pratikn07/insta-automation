import type { AdvisorHistoryItem, AdvisorResponse, AiConnectionStatus } from "@/lib/types";

/**
 * The Assistant page's rules, kept free of any data-fetching import so they can be
 * tested without app env (same convention as connectionView.ts and
 * replyDraftView.ts — importing a component that pulls in @/lib/api throws
 * without VITE_SUPABASE_*).
 */

export const MAX_QUESTION_LENGTH = 2000;

export const CONFIDENCE_LABEL = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
} as const;

export type AssistantView =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "disconnected" }
  | { kind: "needs-reauth" }
  | { kind: "disabled" }
  | { kind: "ready" };

/**
 * Which state the page is in.
 *
 * Order matters. A disconnected account is checked before the rollout flag,
 * because "connect ChatGPT" is the action the owner can actually take; telling
 * them the feature is off first would send them looking for a switch that is not
 * the problem.
 */
export function assistantView(input: {
  isLoading: boolean;
  error: unknown;
  status: AiConnectionStatus | undefined;
  advisorEnabled: boolean;
}): AssistantView {
  if (input.isLoading) return { kind: "loading" };

  if (input.error) {
    const code = errorCode(input.error);
    if (code === "ai_not_configured") {
      return {
        kind: "unavailable",
        reason: "The Assistant isn't set up on this environment yet.",
      };
    }
    return {
      kind: "unavailable",
      reason: "Couldn't reach the Assistant. Your automations are unaffected.",
    };
  }

  if (!input.status?.connected) return { kind: "disconnected" };
  if (input.status.requiresOpenaiAuth) return { kind: "needs-reauth" };
  if (!input.advisorEnabled) return { kind: "disabled" };
  return { kind: "ready" };
}

/** Pull a stable error code out of whatever the fetch layer threw. */
function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const body = (error as { body?: { error?: unknown } }).body;
    if (body && typeof body.error === "string") return body.error;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.includes("ai_not_configured")) {
      return "ai_not_configured";
    }
  }
  return null;
}

export interface ComposerState {
  canSubmit: boolean;
  reason: null | "empty" | "too_long" | "in_flight" | "not_ready";
}

/** Can the owner send this question right now? */
export function composerState(input: {
  text: string;
  pending: boolean;
  ready: boolean;
}): ComposerState {
  if (!input.ready) return { canSubmit: false, reason: "not_ready" };
  // One question at a time: a second concurrent turn would interleave with the
  // first in a single persistent thread.
  if (input.pending) return { canSubmit: false, reason: "in_flight" };
  if (input.text.trim().length === 0) return { canSubmit: false, reason: "empty" };
  if (input.text.length > MAX_QUESTION_LENGTH) return { canSubmit: false, reason: "too_long" };
  return { canSubmit: true, reason: null };
}

/**
 * What to tell the owner when a question fails.
 *
 * A rate limit keeps their text in the composer, because retyping a question they
 * already wrote is the wrong thing to ask of them.
 */
export function askErrorMessage(error: unknown, retryAt: string | null): string {
  const code = errorCode(error);
  if (code === "runtime_rate_limited" || code === "usage_limited") {
    const when = retryAt ? new Date(retryAt) : null;
    return when && !Number.isNaN(when.getTime())
      ? `ChatGPT usage limit reached — try again after ${when.toLocaleTimeString()}.`
      : "ChatGPT usage limit reached — try again shortly.";
  }
  if (code === "ai_advisor_disabled") return "The Assistant isn't enabled on this environment.";
  if (code === "not_connected" || code === "runtime_unauthorized") {
    return "ChatGPT needs reconnecting before the Assistant can answer.";
  }
  if (code === "invalid_advisor_output") {
    return "The answer came back malformed, so nothing is shown. Try asking again.";
  }
  return "Couldn't get an answer just now. Your question is still here — try again.";
}

/** Read `retryAt` off a failed ask, when the server sent one. */
export function retryAtOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const body = (error as { body?: { retryAt?: unknown } }).body;
    if (body && typeof body.retryAt === "string") return body.retryAt;
  }
  return null;
}

/**
 * Merge the runtime's persistent history with turns answered in this session.
 *
 * History is the record of truth, but an answer must never disappear because a
 * refetch was slow or failed — the owner has already spent quota on it. Keyed on
 * clientMessageId so a refetch that catches up does not show the answer twice.
 */
export function mergeTurns(
  history: AdvisorHistoryItem[],
  answered: Array<{ clientMessageId: string; question: string; response: AdvisorResponse }>,
): AdvisorHistoryItem[] {
  const seen = new Set(
    history.map((item) => item.clientMessageId).filter((id): id is string => id !== null),
  );
  return [
    ...history,
    ...answered
      .filter((turn) => !seen.has(turn.clientMessageId))
      .flatMap((turn): AdvisorHistoryItem[] => [
        { role: "user", clientMessageId: turn.clientMessageId, text: turn.question, response: null },
        {
          role: "assistant",
          clientMessageId: turn.clientMessageId,
          text: null,
          response: turn.response,
        },
      ]),
  ];
}
