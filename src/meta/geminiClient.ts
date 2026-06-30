import axios, { AxiosError, AxiosInstance } from "axios";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

// Thin axios client for the Gemini API (Google Generative Language). Matches the
// project's external-client convention (cf. graphClient.ts) rather than pulling in
// the @google/genai SDK. Key is passed as a query param per Gemini's REST API.
//
// Optional by design: when GEMINI_API_KEY is unset, `geminiEnabled` is false and
// the queue worker no-ops, so the app boots and serves everything else.
export const geminiEnabled = Boolean(env.GEMINI_API_KEY);

export const gemini: AxiosInstance = axios.create({
  baseURL: "https://generativelanguage.googleapis.com",
  timeout: 120_000, // video analysis can be slow
  headers: { "Content-Type": "application/json" },
});

gemini.interceptors.request.use((config) => {
  config.params = { key: env.GEMINI_API_KEY, ...(config.params ?? {}) };
  return config;
});

gemini.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    const status = err.response?.status;
    // Never log the body verbatim — the request params carry the API key.
    const data = err.response?.data as { error?: { message?: string } } | undefined;
    logger.error({ status, message: data?.error?.message ?? err.message }, "Gemini API error");
    return Promise.reject(err);
  },
);

export class GeminiDisabledError extends Error {
  constructor() {
    super("gemini_disabled");
    this.name = "GeminiDisabledError";
  }
}
