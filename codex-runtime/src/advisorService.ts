import type { AppServerClient } from "./appServerClient.js";
import type { RuntimeConfig } from "./config.js";
import type { AdvisorSessionStore } from "./advisorSessionStore.js";
import { InternalApiError, isAdvisorToolName } from "./internalApiClient.js";
import type { InternalApiClient } from "./internalApiClient.js";
import {
  ADVISOR_BASE_INSTRUCTIONS,
  ADVISOR_DEVELOPER_INSTRUCTIONS,
} from "./prompts.js";
import {
  ADVISOR_TOOLS,
  advisorResponseJsonSchema,
  advisorResponseSchema,
  type AdvisorHistoryItem,
  type AdvisorRequest,
  type AdvisorResponse,
} from "./schemas.js";

/**
 * The owner's persistent advisor conversation.
 *
 * One long-lived app-server thread (so context carries across questions and across
 * restarts), exactly three read-only dynamic tools, and a strict output schema.
 *
 * The security-critical part is the tool-call handler: it checks the requesting
 * threadId against the CURRENT advisor thread before dispatching, so a DM-draft
 * thread can never reach these tools — and DM-draft threads register no handler at
 * all, so there are two independent barriers.
 */

export type AdvisorErrorCode =
  | "advisor_not_configured"
  | "not_connected"
  | "usage_limited"
  | "turn_timeout"
  | "invalid_advisor_output"
  | "advisor_unavailable";

export class AdvisorError extends Error {
  readonly code: AdvisorErrorCode;
  readonly retryAt: Date | null;
  constructor(code: AdvisorErrorCode, retryAt: Date | null = null) {
    super(code);
    this.name = "AdvisorError";
    this.code = code;
    this.retryAt = retryAt;
  }
}

export interface AdvisorService {
  ask(input: AdvisorRequest): Promise<AdvisorResponse>;
  history(): Promise<AdvisorHistoryItem[]>;
}

const THREAD_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 120_000;

/**
 * app-server nests the turn: `{ threadId, turn: { id, status, items } }`.
 * There is no top-level turnId/status/items — verified against the real binary in
 * appServerContract.test.ts.
 */
interface TurnCompletedNotification {
  threadId?: string;
  turn?: {
    id?: string;
    status?: string;
    items?: Array<{ type?: string; text?: string }>;
  };
}

export function createAdvisorService(deps: {
  appServer: AppServerClient;
  internalApi: InternalApiClient;
  store: AdvisorSessionStore;
  config: RuntimeConfig;
}): AdvisorService {
  // The thread the tool handler will serve. Set before any turn starts, and
  // compared on every tool call.
  let currentThreadId: string | null = null;
  let handlerRegistered = false;

  /**
   * One global item/tool/call handler. Registered once, and it refuses anything
   * that is not (a) for the current advisor thread and (b) one of the three names.
   * A tool failure is returned as `success: false` text rather than thrown, so the
   * model can say "I couldn't read that" instead of the turn dying.
   */
  function ensureToolHandler(): void {
    if (handlerRegistered) return;
    handlerRegistered = true;

    deps.appServer.onRequest("item/tool/call", async (params) => {
      const call = params as { threadId?: string; tool?: string; arguments?: unknown };

      // A DM-draft thread must never reach a data tool. Those threads register no
      // handler, so this is the second barrier, not the only one.
      if (!call.threadId || call.threadId !== currentThreadId) {
        return {
          success: false,
          contentItems: [{ type: "inputText", text: "Tool calls are not available here" }],
        };
      }
      if (!call.tool || !isAdvisorToolName(call.tool)) {
        return {
          success: false,
          contentItems: [{ type: "inputText", text: "Unknown read-only tool" }],
        };
      }

      try {
        const result = await deps.internalApi.callTool(call.tool, call.arguments);
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
      } catch (error) {
        // Only the category — an internal API message could name a host or a table.
        const code = error instanceof InternalApiError ? error.code : "internal_api_unavailable";
        return { success: false, contentItems: [{ type: "inputText", text: code }] };
      }
    });
  }

  /**
   * Resume the stored advisor thread, or start and persist a new one.
   *
   * Serialized through `opening` below: two questions asked at once must not each
   * create a thread, since only one id can be stored and the other's context would
   * be orphaned.
   */
  async function openThreadOnce(): Promise<string> {
    const stored = await deps.store.read();
    if (stored) {
      try {
        await deps.appServer.request("thread/resume", { threadId: stored }, THREAD_TIMEOUT_MS);
        return stored;
      } catch {
        // The thread is gone from app-server (pruned, or a different CODEX_HOME).
        // Start fresh rather than failing the owner's question.
      }
    }

    const created = await deps.appServer.request<{ thread?: { id?: string } }>(
      "thread/start",
      {
        ephemeral: false,
        approvalPolicy: "never",
        sandbox: "read-only",
        cwd: deps.config.CODEX_WORKSPACE,
        runtimeWorkspaceRoots: [],
        environments: [],
        dynamicTools: ADVISOR_TOOLS,
        baseInstructions: ADVISOR_BASE_INSTRUCTIONS,
        developerInstructions: ADVISOR_DEVELOPER_INSTRUCTIONS,
      },
      THREAD_TIMEOUT_MS,
    );
    const threadId = created?.thread?.id;
    if (!threadId) throw new AdvisorError("advisor_unavailable");
    await deps.store.write(threadId);
    return threadId;
  }

  let opening: Promise<string> | null = null;
  function openThread(): Promise<string> {
    if (!opening) {
      opening = openThreadOnce().finally(() => {
        opening = null;
      });
    }
    return opening;
  }

  function classify(error: unknown): AdvisorError {
    if (error instanceof AdvisorError) return error;
    if (error instanceof InternalApiError && error.code === "advisor_not_configured") {
      return new AdvisorError("advisor_not_configured");
    }
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("usage limit") || message.includes("rate limit")) {
      return new AdvisorError("usage_limited");
    }
    if (message.includes("timed out") || message.includes("timeout")) {
      return new AdvisorError("turn_timeout");
    }
    if (message.includes("unauthenticated") || message.includes("not connected")) {
      return new AdvisorError("not_connected");
    }
    return new AdvisorError("advisor_unavailable");
  }

  return {
    async ask(input: AdvisorRequest): Promise<AdvisorResponse> {
      if (!deps.config.TINY_SOHO_API_URL || !deps.config.TINY_SOHO_INTERNAL_TOKEN) {
        // Without the data tools the advisor could only speculate, which is worse
        // than saying it is unavailable.
        throw new AdvisorError("advisor_not_configured");
      }

      ensureToolHandler();
      try {
        currentThreadId = await openThread();

        // Same early-completion race as the DM drafter: arm the listener and buffer
        // notifications before turn/start resolves.
        const buffered: TurnCompletedNotification[] = [];
        let deliver: ((note: TurnCompletedNotification) => void) | null = null;
        const off = deps.appServer.onNotification("turn/completed", (params) => {
          const note = params as TurnCompletedNotification;
          if (deliver) deliver(note);
          else buffered.push(note);
        });

        try {
          const started = await deps.appServer.request<{ turn?: { id?: string } }>(
            "turn/start",
            {
              threadId: currentThreadId,
              // An ARRAY of content items. A bare string is rejected with
              // "invalid type: string, expected a sequence", and the variant is
              // `text` — not `inputText`, which app-server rejects by name.
              input: [{ type: "text", text: input.message }],
              clientUserMessageId: input.clientMessageId,
              outputSchema: advisorResponseJsonSchema,
            },
            TURN_TIMEOUT_MS,
          );
          const turnId = started?.turn?.id;
          if (!turnId) throw new AdvisorError("advisor_unavailable");

          const note = await new Promise<TurnCompletedNotification>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new AdvisorError("turn_timeout")),
              TURN_TIMEOUT_MS,
            );
            const accept = (n: TurnCompletedNotification) => {
              if (n.turn?.id !== turnId) return;
              clearTimeout(timer);
              deliver = null;
              resolve(n);
            };
            const early = buffered.find((n) => n.turn?.id === turnId);
            if (early) return accept(early);
            deliver = accept;
          });

          if (note.turn?.status !== "completed") throw new AdvisorError("advisor_unavailable");

          const text = [...(note.turn.items ?? [])]
            .reverse()
            .find((i) => i.type === "agentMessage")?.text;
          if (!text) throw new AdvisorError("invalid_advisor_output");

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new AdvisorError("invalid_advisor_output");
          }
          const result = advisorResponseSchema.safeParse(parsed);
          if (!result.success) throw new AdvisorError("invalid_advisor_output");
          return result.data;
        } finally {
          off();
        }
      } catch (error) {
        throw classify(error);
      }
    },

    /**
     * The owner's chat history.
     *
     * Returns only their own text and successfully-parsed advisor responses.
     * Reasoning, tool arguments and raw tool output are deliberately dropped — the
     * owner asked a business question, not to read the model's scratchpad, and the
     * raw tool output is the un-rendered version of data they can already see.
     */
    async history(): Promise<AdvisorHistoryItem[]> {
      const threadId = await deps.store.read();
      if (!threadId) return [];

      try {
        const thread = await deps.appServer.request<{
          turns?: Array<{
            clientUserMessageId?: string;
            input?: string;
            items?: Array<{ type?: string; text?: string }>;
          }>;
        }>("thread/read", { threadId, includeTurns: true }, THREAD_TIMEOUT_MS);

        const items: AdvisorHistoryItem[] = [];
        for (const turn of thread.turns ?? []) {
          if (turn.input) {
            items.push({
              role: "user",
              clientMessageId: turn.clientUserMessageId ?? null,
              text: turn.input,
              response: null,
            });
          }
          const agentText = [...(turn.items ?? [])]
            .reverse()
            .find((i) => i.type === "agentMessage")?.text;
          if (!agentText) continue;
          try {
            const parsed = advisorResponseSchema.safeParse(JSON.parse(agentText));
            if (parsed.success) {
              items.push({
                role: "assistant",
                clientMessageId: turn.clientUserMessageId ?? null,
                text: null,
                response: parsed.data,
              });
            }
          } catch {
            // An unparseable turn is skipped rather than shown raw.
          }
        }
        return items;
      } catch {
        return [];
      }
    },
  };
}
