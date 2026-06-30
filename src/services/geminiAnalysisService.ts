import axios from "axios";
import { gemini, geminiEnabled, GeminiDisabledError } from "../meta/geminiClient.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

// Bump to force re-analysis of every reel (cache key is (mediaId, promptVersion)).
export const PROMPT_VERSION = "v1";

// Inline-request ceiling. Gemini accepts inline base64 up to ~20MB of total
// request payload; base64 inflates by ~33%, so cap the raw download well under
// that. Reels above this fall back to the text path (a later enhancement could
// route them through the resumable Files API instead).
const MAX_INLINE_BYTES = 14 * 1024 * 1024;

// Gemini 2.5 Flash paid-tier pricing (per 1M tokens), used for the cost estimate
// stored per analysis and summed against the daily budget guard.
const PRICE = {
  inTextImageVideo: 0.3 / 1_000_000,
  inAudio: 1.0 / 1_000_000,
  output: 2.5 / 1_000_000,
};
const VIDEO_TOKENS_PER_SEC = 258; // frames @ 1fps, default resolution
const AUDIO_TOKENS_PER_SEC = 32;
const PROMPT_TOKENS = 900; // our instruction + schema, approx
const OUTPUT_TOKENS = 900; // structured profile, approx

/** The structured content profile Gemini returns (and we persist whole). */
export interface ContentProfile {
  transcript: string;
  onScreenText: string;
  onScreenLang: "en" | "hi" | "mixed" | "none";
  speakerAccent: "us_general" | "british" | "indian" | "other" | "none";
  accentConfidence: number; // 0..1
  visualSetting: string;
  culturalReferences: Array<{ text: string; region: "us" | "india" | "neutral" }>;
  hookArchetype: string;
  audioVibe: string;
  usCulturalFitRationale: string;
  accentScore: number; // 0..100, model self-rated US-fit of the accent
  settingScore: number; // 0..100
  culturalScore: number; // 0..100
}

export interface AnalysisResult {
  source: "gemini" | "fallback";
  profile: ContentProfile;
  costUsd: number;
  modelId: string;
  promptVersion: string;
}

// JSON schema enforced via responseSchema so Gemini returns parseable JSON, not
// prose. Field set mirrors ContentProfile.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string" },
    onScreenText: { type: "string" },
    onScreenLang: { type: "string", enum: ["en", "hi", "mixed", "none"] },
    speakerAccent: { type: "string", enum: ["us_general", "british", "indian", "other", "none"] },
    accentConfidence: { type: "number" },
    visualSetting: { type: "string" },
    culturalReferences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          region: { type: "string", enum: ["us", "india", "neutral"] },
        },
        required: ["text", "region"],
      },
    },
    hookArchetype: { type: "string" },
    audioVibe: { type: "string" },
    usCulturalFitRationale: { type: "string" },
    accentScore: { type: "integer" },
    settingScore: { type: "integer" },
    culturalScore: { type: "integer" },
  },
  required: [
    "transcript",
    "onScreenText",
    "onScreenLang",
    "speakerAccent",
    "accentConfidence",
    "visualSetting",
    "culturalReferences",
    "hookArchetype",
    "audioVibe",
    "usCulturalFitRationale",
    "accentScore",
    "settingScore",
    "culturalScore",
  ],
};

const VIDEO_PROMPT = `You are analyzing a short parenting/toddler Instagram Reel to assess how well it fits a US/Western audience versus an Indian audience. Watch the video and fill the schema.

Judge ONLY cultural/geographic fit — NOT production quality. Specifically:
- speakerAccent + accentConfidence: the dominant speaking accent, if any speech.
- onScreenLang: language of on-screen text captions.
- visualSetting: describe the physical setting and any geographic cues (e.g. US suburban home, Target/Walmart, Indian home, school-run, seasonal cues like fall/Thanksgiving).
- culturalReferences: brands, holidays, parenting norms, slang — tag each region us|india|neutral.
- hookArchetype: the format (e.g. relatable_parenting, educational_tip, humor, product, story, trend).
- audioVibe: e.g. trending_us, trending_global, original_voiceover, music_only.
- accentScore / settingScore / culturalScore (0-100): how strongly the accent / setting / references skew toward a US audience (100 = unmistakably US, 0 = unmistakably non-US/Indian, 50 = neutral/unknown).
Return JSON only.`;

const TEXT_PROMPT = `You are assessing how well a short parenting/toddler Instagram Reel fits a US/Western vs Indian audience, but the VIDEO IS UNAVAILABLE — judge from the caption and audio type alone. Be conservative: set unknowable fields (transcript, onScreenText, speakerAccent) to "none"/empty and accentConfidence to 0. Infer onScreenLang, culturalReferences, hookArchetype, and the three 0-100 scores from the caption text where possible; default scores to 50 (neutral) when the caption gives no signal. Return JSON only.`;

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

function estimateVideoCost(durationSec: number): number {
  const videoTokens = durationSec * VIDEO_TOKENS_PER_SEC + PROMPT_TOKENS;
  const audioTokens = durationSec * AUDIO_TOKENS_PER_SEC;
  return (
    videoTokens * PRICE.inTextImageVideo +
    audioTokens * PRICE.inAudio +
    OUTPUT_TOKENS * PRICE.output
  );
}

function parseProfile(res: GenerateResponse): ContentProfile {
  const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return JSON.parse(text) as ContentProfile;
}

/** Lift the queryable sub-scores out of the profile for the dedicated columns. */
export function computeProfileColumns(p: ContentProfile) {
  return {
    accentScore: p.accentScore,
    settingScore: p.settingScore,
    culturalScore: p.culturalScore,
    hookArchetype: p.hookArchetype,
    onScreenLang: p.onScreenLang,
    audioVibe: p.audioVibe,
  };
}

async function generate(parts: unknown[], prompt: string): Promise<GenerateResponse> {
  const { data } = await gemini.post<GenerateResponse>(
    `/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
    {
      contents: [{ parts: [{ text: prompt }, ...parts] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    },
  );
  return data;
}

/** Text-only degrade path: caption + audio type, low confidence. */
async function analyzeText(caption: string | null, audioType: string | null): Promise<AnalysisResult> {
  const context = `Caption: ${caption ?? "(none)"}\nAudio type: ${audioType ?? "unknown"}`;
  const res = await generate([{ text: context }], TEXT_PROMPT);
  return {
    source: "fallback",
    profile: parseProfile(res),
    costUsd: (PROMPT_TOKENS + 200) * PRICE.inTextImageVideo + OUTPUT_TOKENS * PRICE.output,
    modelId: env.GEMINI_MODEL,
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * Analyze one reel. media_url present & small enough → inline video analysis;
 * otherwise → text/caption degrade path. Never re-runs caching (the caller owns
 * the cache check). Throws GeminiDisabledError when the key is unset so the
 * worker can no-op cleanly.
 */
export async function analyzeReel(input: {
  mediaUrl: string | null;
  caption: string | null;
  mediaAudioType: string | null;
}): Promise<AnalysisResult> {
  if (!geminiEnabled) throw new GeminiDisabledError();

  if (!input.mediaUrl) {
    return analyzeText(input.caption, input.mediaAudioType);
  }

  // Download the video (CDN links are short-lived, so fetch + analyze in one go).
  let bytes: Buffer;
  try {
    const resp = await axios.get<ArrayBuffer>(input.mediaUrl, {
      responseType: "arraybuffer",
      timeout: 60_000,
      maxContentLength: MAX_INLINE_BYTES,
    });
    bytes = Buffer.from(resp.data);
  } catch (err) {
    logger.warn({ err }, "video download failed; falling back to text analysis");
    return analyzeText(input.caption, input.mediaAudioType);
  }

  if (bytes.byteLength > MAX_INLINE_BYTES) {
    logger.info({ bytes: bytes.byteLength }, "video too large for inline; text fallback");
    return analyzeText(input.caption, input.mediaAudioType);
  }

  const res = await generate(
    [{ inlineData: { mimeType: "video/mp4", data: bytes.toString("base64") } }],
    VIDEO_PROMPT,
  );

  // Cost estimate from payload size (we don't know exact duration here): approximate
  // duration from bytes is unreliable, so use a fixed-15s estimate as the budget
  // unit — accurate enough for the daily-budget guard.
  return {
    source: "gemini",
    profile: parseProfile(res),
    costUsd: estimateVideoCost(15),
    modelId: env.GEMINI_MODEL,
    promptVersion: PROMPT_VERSION,
  };
}
