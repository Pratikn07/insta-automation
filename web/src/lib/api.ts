import { supabase } from "./supabase";
import type {
  RecoveryCounts,
  RecoveryMetrics,
  RecoveryReminderDetail,
  RecoveryReminderRow,
} from "./types";

const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
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

async function fetchOnce(path: string, init: RequestInit, token: string | undefined) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${apiBase}/api${path}`, { ...init, headers });
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let token = await getAccessToken(false);
  let res = await fetchOnce(path, init, token);

  if (res.status === 401) {
    token = await getAccessToken(true);
    if (token) res = await fetchOnce(path, init, token);
  }

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) {
    const message = extractErrorMessage(body, res.status);
    throw new ApiError(res.status, body, message);
  }

  return body as T;
}

// ── DM recovery ───────────────────────────────────────────────────────────

export const recoveryApi = {
  list: (query: string) =>
    // `asOf` is the eligibleAt boundary this page was read at. Echo it back with
    // the cursor so a paginated run stays on one boundary.
    api<{ rows: RecoveryReminderRow[]; nextCursor: string | null; asOf: string }>(
      `/recovery-reminders${query ? `?${query}` : ""}`,
    ),
  counts: () => api<RecoveryCounts>("/recovery-reminders/counts"),
  metrics: () => api<RecoveryMetrics>("/recovery-reminders/metrics"),
  detail: (id: string) => api<RecoveryReminderDetail>(`/recovery-reminders/${id}`),
  cancel: (id: string) => api<void>(`/recovery-reminders/${id}/cancel`, { method: "POST" }),
  markReviewed: (id: string) =>
    api<void>(`/recovery-reminders/${id}/mark-reviewed`, { method: "POST" }),
};
