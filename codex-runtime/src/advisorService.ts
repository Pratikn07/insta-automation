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
  | "advisor_unavailable"
  /**
   * This question is already in flight, or we cannot prove it is not. The caller
   * must wait and re-read rather than ask again — a model turn costs quota and
   * would put the same question in the owner's history twice.
   */
  | "advisor_outcome_pending"
  /** The same clientMessageId arrived carrying a different question. */
  | "idempotency_conflict";

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

  /**
   * What this process knows about each question it has been asked.
   *
   * `clientMessageId` is the owner's intent, so a repeat of it is the same
   * question, not a second one. While the process lives this registry is the
   * precise answer: it distinguishes a turn still running from one that completed
   * from one that failed, which no read of the thread can do.
   */
  type TurnRecord =
    | { state: "running"; question: string }
    | { state: "completed"; question: string; response: AdvisorResponse }
    | { state: "failed"; question: string; code: AdvisorErrorCode };
  const asked = new Map<string, TurnRecord>();

  /**
   * What the *thread* can tell us about a question, after a restart lost the
   * registry.
   *
   * Deliberately narrow. `thread/read`'s turn shape is pinned only as
   * `{ clientUserMessageId, input, items }` — a per-turn status field is not
   * verified against the real app-server, so this does not pretend to read one.
   * That means a turn present without a parseable answer is reported as *pending*,
   * not failed: it may still be running, and calling it failed would invite a
   * second turn for the same question.
   *
   * A failed read is likewise pending, never absence. "I could not look" and "it is
   * not there" are different answers, and only the second permits asking again.
   */
  type ReplayVerdict =
    | { kind: "absent" }
    | { kind: "completed"; response: AdvisorResponse }
    | { kind: "pending" }
    | { kind: "conflict" };

  async function replayFromThread(
    clientMessageId: string,
    question: string,
  ): Promise<ReplayVerdict> {
    const threadId = await deps.store.read();
    if (!threadId) return { kind: "absent" };

    let thread: {
      turns?: Array<{
        clientUserMessageId?: string;
        input?: string;
        items?: Array<{ type?: string; text?: string }>;
      }>;
    };
    try {
      thread = await deps.appServer.request("thread/read", { threadId, includeTurns: true }, THREAD_TIMEOUT_MS);
    } catch {
      return { kind: "pending" };
    }

    const turn = (thread.turns ?? []).find(
      (candidate) => candidate.clientUserMessageId === clientMessageId,
    );
    if (!turn) return { kind: "absent" };
    if (turn.input !== undefined && turn.input !== question) return { kind: "conflict" };

    const agentText = [...(turn.items ?? [])]
      .reverse()
      .find((item) => item.type === "agentMessage")?.text;
    if (!agentText) return { kind: "pending" };
    try {
      const parsed = advisorResponseSchema.safeParse(JSON.parse(agentText));
      return parsed.success ? { kind: "completed", response: parsed.data } : { kind: "pending" };
    } catch {
      return { kind: "pending" };
    }
  }
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

      // Has this exact question already been asked? The registry answers precisely
      // while the process lives; the thread answers what it can after a restart.
      const known = asked.get(input.clientMessageId);
      if (known) {
        if (known.question !== input.message) throw new AdvisorError("idempotency_conflict");
        if (known.state === "running") throw new AdvisorError("advisor_outcome_pending");
        if (known.state === "completed") return known.response;
        throw new AdvisorError(known.code);
      }

      const replay = await replayFromThread(input.clientMessageId, input.message);
      if (replay.kind === "conflict") throw new AdvisorError("idempotency_conflict");
      if (replay.kind === "pending") throw new AdvisorError("advisor_outcome_pending");
      if (replay.kind === "completed") {
        asked.set(input.clientMessageId, {
          state: "completed",
          question: input.message,
          response: replay.response,
        });
        return replay.response;
      }

      // Claimed before anything is awaited, so a second concurrent ask for the same
      // id sees `running` instead of starting a second turn.
      asked.set(input.clientMessageId, { state: "running", question: input.message });

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
          asked.set(input.clientMessageId, {
            state: "completed",
            question: input.message,
            response: result.data,
          });
          return result.data;
        } finally {
          off();
        }
      } catch (error) {
        const failure = classify(error);
        // A timeout is the one failure whose effect is genuinely unknown: the turn
        // may still be running, so this id stays claimed as pending rather than
        // being recorded as a definite failure the caller could retry past.
        asked.set(
          input.clientMessageId,
          failure.code === "turn_timeout"
            ? { state: "running", question: input.message }
            : { state: "failed", question: input.message, code: failure.code },
        );
        throw failure;
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
