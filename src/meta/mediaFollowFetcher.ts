import { isAxiosError } from "axios";
import { insightsGraph } from "./insightsGraphClient.js";

interface FollowsDatum {
  name?: string;
  total_value?: { value?: unknown };
  values?: Array<{ value?: unknown }>;
}

interface FollowsResponse {
  data?: FollowsDatum[];
}

export type FeedFollowMetricResult =
  | { status: "ok"; follows: number }
  | { status: "unavailable"; follows: null };

/** Fetch Meta's cumulative lifetime follow attribution for one FEED post. */
export async function fetchFeedFollowCount(mediaId: string): Promise<FeedFollowMetricResult> {
  const { data } = await insightsGraph.get<FollowsResponse>(`/${mediaId}/insights`, {
    params: { metric: "follows" },
  });
  const metric = data.data?.find((datum) => datum.name === "follows");
  const value = metric?.total_value?.value ?? metric?.values?.[0]?.value;

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { status: "unavailable", follows: null };
  }
  return { status: "ok", follows: value };
}

/** Meta OAuth/session failures invalidate the account token, not one media row. */
export function isGraphAuthenticationError(err: unknown): boolean {
  if (!isAxiosError(err)) return false;
  const body = err.response?.data as { error?: { code?: number } } | undefined;
  const code = body?.error?.code;
  return code === 190 || code === 102;
}
