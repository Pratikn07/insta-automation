import axios, { AxiosError, AxiosInstance } from "axios";
import { logger } from "../lib/logger.js";
import { getAccessToken } from "./tokenStore.js";

const GRAPH_VERSION = "v21.0";
const BASE_URL = `https://graph.instagram.com/${GRAPH_VERSION}`;

export const graph: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
});

graph.interceptors.request.use((config) => {
  // Read per-request, never captured at module load: the refresh worker rotates
  // this value in place, and a token snapshotted at boot would go stale the
  // moment it did (leaving a long-running process authenticating with a token
  // that has been replaced).
  config.params = { access_token: getAccessToken(), ...(config.params ?? {}) };
  return config;
});

graph.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    const status = err.response?.status;
    const data = err.response?.data;
    logger.error({ status, data, url: err.config?.url }, "Graph API error");
    return Promise.reject(err);
  },
);
