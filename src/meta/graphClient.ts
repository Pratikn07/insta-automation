import axios, { AxiosError, AxiosInstance } from "axios";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const GRAPH_VERSION = "v21.0";
const BASE_URL = `https://graph.instagram.com/${GRAPH_VERSION}`;

export const graph: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
});

graph.interceptors.request.use((config) => {
  config.params = { access_token: env.IG_ACCESS_TOKEN, ...(config.params ?? {}) };
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
