import axios, { AxiosError, AxiosInstance } from "axios";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { describeGraphError } from "../services/eventLogger.js";
import { resolveAccessToken } from "./tokenStore.js";

// A SECOND Graph client, deliberately separate from graphClient.ts.
//
// graphClient.ts is pinned to v21.0 and carries the rate-limit-sensitive
// messaging / comment / private-reply flow — the load-bearing path we must not
// disturb. Insights, audience demographics, and media_audio_type are newer and
// need v22.0+ (we default to v23.0, proven against this account in
// scripts/probe-geo-demographics.mjs). Isolating them here means a version bump
// for analytics can never regress the gate.
const BASE_URL = `https://graph.instagram.com/${env.INSIGHTS_GRAPH_VERSION}`;

export const insightsGraph: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
});

insightsGraph.interceptors.request.use(async (config) => {
  // Per-request read, same reason as graphClient: the refresh worker rotates the
  // token in place and a boot-time snapshot would silently go stale. Awaited for
  // the same reason too — a short-lived script would otherwise spend its whole
  // life authenticating with the stale env seed. See resolveAccessToken.
  config.params = { access_token: await resolveAccessToken(), ...(config.params ?? {}) };
  return config;
});

insightsGraph.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    logger.error(describeGraphError(err), "Insights Graph API error");
    return Promise.reject(err);
  },
);
