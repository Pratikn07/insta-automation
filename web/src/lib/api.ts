import { supabase } from "./supabase";
import type { DayRange } from "./dateRange";
import { awaitWithSignal, withDeadline } from "./requestDeadline";
import { MutationNotDispatchedError, MutationOutcomeUnknownError } from "./mutationOutcome";
import type {
  RecoveryCounts,
  RecoveryMetrics,
  RecoveryReminderDetail,
  RecoveryReminderRow,
  SettingsBlockedVerificationRecord,
} from "./types";

const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

/**
 * The default deadline for one request.
 *
 * Generous enough not to fire on a slow cohort scan, and short enough that a page
 * settles into a real error state rather than holding skeletons forever. The
 * deadline is enforced by aborting the request, not by abandoning it — see
 * requestDeadline.ts for why that distinction matters.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return null;
  const code = (error.body as { error?: unknown }).error;
  return typeof code === "string" ? code : null;
}

function extractErrorMessage(body: unknown, status: number): string {
  if (typeof body === "string" && body) return body;
  if (typeof body === "object" && body && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const fieldErrors = (err as { fieldErrors?: Record<string, string[]> }).fieldErrors;
      if (fieldErrors) {
        const first = Object.entries(fieldErrors)
          .flatMap(([k, msgs]) => (msgs ?? []).map((m) => `${k}: ${m}`))[0];
        if (first) return first;
      }
      const formErrors = (err as { formErrors?: string[] }).formErrors;
      if (formErrors?.[0]) return formErrors[0];
    }
  }
  return `HTTP ${status}`;
}

async function getAccessToken(forceRefresh: boolean): Promise<string | undefined> {
  if (forceRefresh) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error) return undefined;
    return data.session?.access_token;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

/**
 * The Supabase auth client takes no signal, so its promise is the one thing we
 * can only stop waiting on rather than cancel. Everything downstream of it is
 * genuinely abortable.
 */
async function getAccessTokenBounded(
  forceRefresh: boolean,
  signal: AbortSignal,
): Promise<string | undefined> {
  return awaitWithSignal(getAccessToken(forceRefresh), signal);
}

async function fetchOnce(path: string, init: RequestInit, token: string | undefined) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${apiBase}/api${path}`, { ...init, headers });
}

export interface ReadOptions {
  /** TanStack Query supplies this; forwarding it makes cancellation real. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * A GET whose deadline aborts the request instead of merely abandoning it.
 *
 * Reads are safe to abandon and safe to repeat, which is exactly what makes a
 * deadline the right answer for them — and exactly what is not true of the
 * mutations that live in `apiMutation`.
 */
export async function apiRead<T>(path: string, options: ReadOptions = {}): Promise<T> {
  const deadline = withDeadline(options.signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const token = await getAccessTokenBounded(false, deadline.signal);
    let res = await fetchOnce(path, { signal: deadline.signal }, token);

    if (res.status === 401) {
      // One refresh, one retry. More than that turns an expired session into a
      // loop against the auth server.
      const refreshed = await getAccessTokenBounded(true, deadline.signal);
      if (refreshed) res = await fetchOnce(path, { signal: deadline.signal }, refreshed);
    }

    return await readBody<T>(res);
  } finally {
    deadline.dispose();
  }
}

export interface MutationOptions {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body?: string;
  /** Stable across explicit retries of the same owner intent. */
  operationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * A non-GET request whose failures are classified by dispatch phase.
 *
 * Everything before `fetch` is provably harmless: the request never left, so the
 * caller may repeat it. Everything from `fetch` onward is `unknown` unless the
 * server returned a definite answer, because a timeout after dispatch and a
 * success we never heard about look identical from here.
 *
 * There is exactly one exception, and it is not a retry of an unknown: a 401 is a
 * definite response proving `requireAdmin` rejected the request before any route
 * ran, so refreshing the session and sending once more cannot duplicate an
 * effect.
 */
export async function apiMutation<T>(path: string, options: MutationOptions): Promise<T> {
  if ((options.method as string) === "GET") {
    throw new Error(`apiMutation cannot be used for a GET (${path}); use apiRead.`);
  }

  const deadline = withDeadline(options.signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let dispatched = false;
  try {
    const token = await getAccessTokenBounded(false, deadline.signal);

    const send = (bearer: string | undefined) => {
      const headers = new Headers();
      if (options.operationId) headers.set("idempotency-key", options.operationId);
      dispatched = true;
      return fetchOnce(
        path,
        { method: options.method, headers, signal: deadline.signal, ...(options.body ? { body: options.body } : {}) },
        bearer,
      );
    };

    let res = await send(token);

    if (res.status === 401) {
      const refreshed = await getAccessTokenBounded(true, deadline.signal);
      if (refreshed) res = await send(refreshed);
    }

    // A 5xx is a response, but not an answer: the route behind the proxy may have
    // completed. Only a definite 4xx or a success settles the question.
    if (res.status >= 500) {
      throw new MutationOutcomeUnknownError(path, options.operationId);
    }

    return await readBody<T>(res);
  } catch (error) {
    if (error instanceof ApiError || error instanceof MutationOutcomeUnknownError) throw error;
    throw dispatched
      ? new MutationOutcomeUnknownError(path, options.operationId)
      : new MutationNotDispatchedError(path);
  } finally {
    deadline.dispose();
  }
}

async function readBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) throw new ApiError(res.status, body, extractErrorMessage(body, res.status));

  return body as T;
}

// ── DM recovery ───────────────────────────────────────────────────────────

/**
 * Reads here take the same optional `ReadOptions` as `apiRead`, so a recovery
 * query cancelled by its component stops rather than finishing into a discarded
 * cache entry. The actions do not: a cancelled mutation is an unknown outcome,
 * not a cancelled effect, and Task 7 gives each one a reconciliation rule.
 */
export const recoveryApi = {
  list: (query: string, options: ReadOptions = {}) =>
    // `asOf` is the eligibleAt boundary this page was read at. Echo it back with
    // the cursor so a paginated run stays on one boundary.
    apiRead<{
      rows: RecoveryReminderRow[];
      nextCursor: string | null;
      asOf: string;
      range: DayRange | null;
    }>(
      `/recovery-reminders${query ? `?${query}` : ""}`,
      options,
    ),
  counts: (query = "", options: ReadOptions = {}) =>
    apiRead<RecoveryCounts>(
      `/recovery-reminders/counts${query ? `?${query}` : ""}`,
      options,
    ),
  metrics: (query = "", options: ReadOptions = {}) =>
    apiRead<RecoveryMetrics>(
      `/recovery-reminders/metrics${query ? `?${query}` : ""}`,
      options,
    ),
  settingsVerifications: (options: ReadOptions = {}) =>
    apiRead<{ records: SettingsBlockedVerificationRecord[] }>(
      "/recovery-reminders/settings-verifications",
      options,
    ),
  activateSettingsVerification: (id: string) =>
    apiMutation<void>(`/recovery-reminders/settings-verifications/${id}/activate`, { method: "POST" }),
  retireSettingsVerification: (id: string, reason: string) =>
    apiMutation<void>(`/recovery-reminders/settings-verifications/${id}/retire`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  detail: (id: string, options: ReadOptions = {}) =>
    apiRead<RecoveryReminderDetail>(`/recovery-reminders/${id}`, options),
  cancel: (id: string) => apiMutation<void>(`/recovery-reminders/${id}/cancel`, { method: "POST" }),
  markReviewed: (id: string) =>
    apiMutation<void>(`/recovery-reminders/${id}/mark-reviewed`, { method: "POST" }),
};
