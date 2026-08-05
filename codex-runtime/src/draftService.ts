import type { AppServerClient } from "./appServerClient.js";
import {
  DM_DRAFTER_DEVELOPER_PROMPT,
  DM_DRAFTER_TURN_INPUT,
  renderBrandContext,
  renderTranscript,
} from "./prompts.js";
import {
  dmDraftOutputJsonSchema,
  dmDraftOutputSchema,
  type DmDraftRequest,
  type DmDraftSuggestion,
} from "./schemas.js";

export interface DraftService {
  generate(input: DmDraftRequest): Promise<DmDraftSuggestion>;
}

/**
 * A draft failure, categorised for the HTTP layer. The category is the ONLY thing
 * that crosses back to the caller — the underlying app-server message can embed
 * account or token detail and is never forwarded.
 */
export type DraftErrorCode =
  | "invalid_draft_output"
  | "turn_incomplete"
  | "turn_timeout"
  | "usage_limited"
  | "app_server_unauthenticated"
  | "draft_unavailable";

export class DraftGenerationError extends Error {
  readonly code: DraftErrorCode;
  readonly retryAt: Date | null;
  constructor(code: DraftErrorCode, retryAt: Date | null = null) {
    super(code);
    this.name = "DraftGenerationError";
    this.code = code;
    this.retryAt = retryAt;
  }
}

const THREAD_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 90_000;

interface ThreadStartResult {
  threadId: string;
}
interface TurnStartResult {
  turnId: string;
}
interface TurnCompletedNotification {
  turnId: string;
  status: string;
  items?: Array<{ type?: string; text?: string }>;
}

/** Categorise a raw app-server error into a safe code by its message shape. */
function classifyAppServerError(error: unknown): DraftGenerationError {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("usage limit") || message.includes("rate limit")) {
    return new DraftGenerationError("usage_limited");
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return new DraftGenerationError("turn_timeout");
  }
  if (message.includes("unauthenticated") || message.includes("requires") && message.includes("auth")) {
    return new DraftGenerationError("app_server_unauthenticated");
  }
  return new DraftGenerationError("draft_unavailable");
}

export function createDraftService(appServer: AppServerClient): DraftService {
  return {
    async generate(input: DmDraftRequest): Promise<DmDraftSuggestion> {
      // A fresh ephemeral thread per draft: no tools, no writable workspace, no
      // approval escalation, and NO item/tool/call handler (never registered
      // below). The model cannot act — it can only return text.
      const thread = (await appServer.request<ThreadStartResult>(
        "thread/start",
        {
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          runtimeWorkspaceRoots: [],
          environments: [],
          dynamicTools: null,
          developerMessage: DM_DRAFTER_DEVELOPER_PROMPT,
        },
        THREAD_TIMEOUT_MS,
      )).threadId;

      // The listener MUST be armed before turn/start, because app-server can fire
      // `turn/completed` before that request resolves — before we even know our
      // turn id. So every completion is buffered, and once the id is known we
      // either match the buffer or wait for the next one. Without the buffer, a
      // fast completion is dropped and generation hangs to the timeout.
      const buffered: TurnCompletedNotification[] = [];
      let deliver: ((note: TurnCompletedNotification) => void) | null = null;
      const off = appServer.onNotification("turn/completed", (params) => {
        const note = params as TurnCompletedNotification;
        if (deliver) deliver(note);
        else buffered.push(note);
      });

      try {
        const turn = await appServer.request<TurnStartResult>(
          "turn/start",
          {
            threadId: thread,
            input: DM_DRAFTER_TURN_INPUT,
            outputSchema: dmDraftOutputJsonSchema,
            // The transcript is the participant's own words: marked untrusted so
            // app-server treats it as data, never as instructions that could
            // change the task or the output schema.
            additionalContext: {
              dm_transcript: { kind: "untrusted", value: renderTranscript(input) },
              brand_context: { kind: "application", value: renderBrandContext(input) },
            },
          },
          TURN_TIMEOUT_MS,
        );
        const turnId = turn.turnId;

        const note = await new Promise<TurnCompletedNotification>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new DraftGenerationError("turn_timeout")),
            TURN_TIMEOUT_MS,
          );
          const accept = (n: TurnCompletedNotification) => {
            if (n.turnId !== turnId) return; // ignore some other turn
            clearTimeout(timer);
            deliver = null;
            resolve(n);
          };
          // Drain anything that arrived during turn/start first, then take live ones.
          const early = buffered.find((n) => n.turnId === turnId);
          if (early) return accept(early);
          deliver = accept;
        });

        if (note.status !== "completed") throw new DraftGenerationError("turn_incomplete");

        // The reply is the LAST agentMessage item's text.
        const agentText = [...(note.items ?? [])]
          .reverse()
          .find((i) => i.type === "agentMessage")?.text;
        if (!agentText) throw new DraftGenerationError("invalid_draft_output");

        let parsed: unknown;
        try {
          parsed = JSON.parse(agentText);
        } catch {
          throw new DraftGenerationError("invalid_draft_output");
        }
        const result = dmDraftOutputSchema.safeParse(parsed);
        if (!result.success) throw new DraftGenerationError("invalid_draft_output");

        return { ...result.data, modelId: null };
      } catch (error) {
        if (error instanceof DraftGenerationError) throw error;
        throw classifyAppServerError(error);
      } finally {
        off();
        // Ephemeral threads are always torn down — including after malformed
        // output or a mid-turn throw — so nothing accumulates in the runtime.
        await appServer
          .request("thread/delete", { threadId: thread }, THREAD_TIMEOUT_MS)
          .catch(() => {
            /* best-effort; the thread is ephemeral anyway */
          });
      }
    },
  };
}
