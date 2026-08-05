import type { AiConnectionStatus, AiLoginStart } from "@/lib/types";

/**
 * The connection card's state machine, kept free of any data-fetching import.
 *
 * It lives apart from AiConnectionCard.tsx because that file imports `@/lib/api`,
 * which imports `@/lib/supabase` and throws without VITE_SUPABASE_* at module
 * load. Every other component test in this app follows the same rule: the pure
 * logic is importable on its own, so it can be tested without app env.
 */
export type ConnectionView =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "disconnected" }
  | { kind: "awaiting-code"; login: AiLoginStart }
  | { kind: "connected"; status: AiConnectionStatus };

export function connectionView(input: {
  isLoading: boolean;
  error: unknown;
  status: AiConnectionStatus | undefined;
  login: AiLoginStart | null;
}): ConnectionView {
  if (input.isLoading) return { kind: "loading" };

  if (input.error) {
    const code =
      typeof input.error === "object" && input.error && "body" in input.error
        ? (input.error as { body?: { error?: string } }).body?.error
        : undefined;
    return {
      kind: "unavailable",
      // "Not configured" is an environment gap the owner can act on; anything
      // else is a runtime that may simply be restarting. Different sentences.
      reason:
        code === "ai_not_configured"
          ? "The AI runtime isn't configured for this environment yet."
          : "The AI runtime isn't reachable right now.",
    };
  }

  // A completed connection outranks an outstanding code, so the 3-second poll
  // noticing redemption cannot leave a stale code on screen for a frame.
  if (input.status?.connected) return { kind: "connected", status: input.status };
  if (input.login) return { kind: "awaiting-code", login: input.login };
  return { kind: "disconnected" };
}
