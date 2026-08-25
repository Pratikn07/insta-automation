import axios, { AxiosError, AxiosInstance } from "axios";
import { logger } from "../lib/logger.js";
import { describeGraphError } from "../services/eventLogger.js";
import { resolveAccessToken } from "./tokenStore.js";

export const GRAPH_VERSION = "v21.0";
const BASE_URL = `https://graph.instagram.com/${GRAPH_VERSION}`;

export const graph: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
});

graph.interceptors.request.use(async (config) => {
  // Read per-request, never captured at module load: the refresh worker rotates
  // this value in place, and a token snapshotted at boot would go stale the
  // moment it did (leaving a long-running process authenticating with a token
  // that has been replaced).
  //
  // Awaited, and async on purpose. Axios supports a promise-returning request
  // interceptor natively, so this changes nothing at the ~219 call sites. It buys
  // the one thing the synchronous read could not give a short-lived process: the
  // FIRST call waits for the ig_token cache to warm rather than authenticating
  // with the stale env seed. Only the first call pays; the rest hit the cache.
  config.params = { access_token: await resolveAccessToken(), ...(config.params ?? {}) };
  return config;
});

graph.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    // Provider payloads, request URLs, and Axios error strings can all contain
    // access tokens or private message text. Keep this log entry numeric and
    // allowlist-only so logging cannot become a second data-exfiltration path.
    logger.error(describeGraphError(err), "Graph API error");
    return Promise.reject(err);
  },
);
