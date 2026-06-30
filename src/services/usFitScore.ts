import type { ContentProfile } from "./geminiAnalysisService.js";

// ── TUNING SURFACE ───────────────────────────────────────────────────────────
// This is the wedge's lever. After eyeballing the Leaderboard against reels the
// creator KNOWS are US- vs India-resonant, adjust these weights (pure function,
// no schema change, no re-analysis) until the ranking matches their gut.
const WEIGHTS = {
  accent: 0.35,
  setting: 0.25,
  cultural: 0.25,
  language: 0.15,
} as const;

// Many tinysoho reels are text-overlay + music with NO speech (their signature
// format). Gemini then returns speakerAccent "none" and a neutral accentScore —
// including that neutral 50 at the heaviest weight would drag a clearly-US reel
// toward the middle. So when there's no speech we DROP accent and renormalize its
// weight across the signals we CAN actually read: setting, cultural, language.
const NO_SPEECH_WEIGHTS = (() => {
  const sum = WEIGHTS.setting + WEIGHTS.cultural + WEIGHTS.language;
  return {
    setting: WEIGHTS.setting / sum,
    cultural: WEIGHTS.cultural / sum,
    language: WEIGHTS.language / sum,
  };
})();

// onScreenLang → a 0..100 language-fit score.
const LANGUAGE_SCORE: Record<ContentProfile["onScreenLang"], number> = {
  en: 100,
  mixed: 50,
  hi: 0,
  none: 60, // no on-screen text is mildly US-neutral, not a penalty
};

// Audio nudge keys on META's media_audio_type — the RELIABLE audio signal. (We do
// NOT trust Gemini's audioVibe for geo: it returns free text like "upbeat pop"
// and cannot know what's "trending in the US" from the video alone.) Licensed
// MUSIC skews slightly toward trending/Western-catalog audio; ORIGINAL_SOUND is
// neutral. Small additive nudge, then clamped.
const AUDIO_NUDGE: Record<string, number> = {
  MUSIC: 4,
  ORIGINAL_SOUND: 0,
};

export interface UsFitResult {
  score: number; // 0..100
  confidence: "high" | "low";
  breakdown: {
    accent: number | null; // null when the reel has no speech
    setting: number;
    cultural: number;
    language: number;
    audioNudge: number;
    speechAnalyzed: boolean;
  };
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute the 0..100 US-cultural-fit score from a Gemini content profile.
 * PURE — no I/O — so it's trivially re-runnable during the calibration loop and
 * unit-testable.
 *
 * `source` distinguishes a real video analysis ("gemini") from the caption-only
 * fallback. `mediaAudioType` is Meta's MUSIC|ORIGINAL_SOUND (the manual override
 * if the operator set one, else the API value).
 */
export function computeUsFit(
  profile: ContentProfile,
  source: "gemini" | "fallback",
  mediaAudioType?: string | null,
): UsFitResult {
  const setting = clamp(profile.settingScore ?? 50);
  const cultural = clamp(profile.culturalScore ?? 50);
  const language = LANGUAGE_SCORE[profile.onScreenLang] ?? 50;
  const audioNudge = AUDIO_NUDGE[mediaAudioType ?? ""] ?? 0;

  // Was there speech to judge an accent on? speakerAccent "none" / zero confidence
  // means no — common for this account's text-overlay reels.
  const speechAnalyzed = profile.speakerAccent !== "none" && (profile.accentConfidence ?? 0) > 0;
  const accent = speechAnalyzed ? clamp(profile.accentScore ?? 50) : null;

  const weighted =
    accent !== null
      ? accent * WEIGHTS.accent +
        setting * WEIGHTS.setting +
        cultural * WEIGHTS.cultural +
        language * WEIGHTS.language
      : setting * NO_SPEECH_WEIGHTS.setting +
        cultural * NO_SPEECH_WEIGHTS.cultural +
        language * NO_SPEECH_WEIGHTS.language;

  const score = Math.round(clamp(weighted + audioNudge));

  // Confidence keys on whether we actually ANALYZED THE VIDEO — not on whether
  // there was speech. A text-overlay reel analyzed by Gemini is still a confident
  // read of its setting/cultural cues. Only the caption-only fallback (no video
  // seen) is inherently low-confidence.
  const confidence: "high" | "low" = source === "gemini" ? "high" : "low";

  return {
    score,
    confidence,
    breakdown: { accent, setting, cultural, language, audioNudge, speechAnalyzed },
  };
}
