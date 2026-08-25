import dotenv from "dotenv";
import { liveToken } from "./lib/live-token.mjs";

dotenv.config();

// READ-ONLY DRY RUN (writes nothing to the DB). Validates the Gemini reel-analysis
// path end to end on ONE reel before we let the queue worker loose on the catalog:
//   1. fetch the reel's media_url + media_audio_type from the Graph API (v23)
//   2. download the video, send it inline to Gemini 2.5 Flash with our schema
//   3. print the structured content profile + an estimated cost
//
// Usage:  node scripts/probe-gemini-reel.mjs <MEDIA_ID>
// If no MEDIA_ID is given, it uses the first reel from the account media list.

const TOKEN = await liveToken();
const IG_USER_ID = process.env.IG_USER_ID;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const VERSION = process.env.INSIGHTS_GRAPH_VERSION ?? "v23.0";
const MAX_INLINE_BYTES = 14 * 1024 * 1024;

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
        properties: { text: { type: "string" }, region: { type: "string", enum: ["us", "india", "neutral"] } },
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
    "transcript", "onScreenText", "onScreenLang", "speakerAccent", "accentConfidence",
    "visualSetting", "culturalReferences", "hookArchetype", "audioVibe",
    "usCulturalFitRationale", "accentScore", "settingScore", "culturalScore",
  ],
};

const PROMPT = `You are analyzing a short parenting/toddler Instagram Reel to assess how well it fits a US/Western audience versus an Indian audience. Watch the video and fill the schema. Judge ONLY cultural/geographic fit, NOT production quality. accentScore/settingScore/culturalScore are 0-100 where 100 = unmistakably US, 0 = unmistakably non-US/Indian, 50 = neutral. Return JSON only.`;

async function getReel(mediaId) {
  const fields = "id,caption,media_url,media_audio_type,media_product_type,timestamp";
  if (mediaId) {
    const url = `https://graph.instagram.com/${VERSION}/${mediaId}?fields=${fields}&access_token=${TOKEN}`;
    const r = await fetch(url);
    const b = await r.json();
    if (b.error) throw new Error(`Graph: ${b.error.message}`);
    return b;
  }
  const url = `https://graph.instagram.com/${VERSION}/${IG_USER_ID}/media?fields=${fields}&limit=10&access_token=${TOKEN}`;
  const r = await fetch(url);
  const b = await r.json();
  if (b.error) throw new Error(`Graph: ${b.error.message}`);
  const reel = (b.data ?? []).find((m) => m.media_product_type === "REELS" && m.media_url);
  if (!reel) throw new Error("No reel with a media_url found in the first page.");
  return reel;
}

function estimateCost(durationSec = 15) {
  const video = durationSec * 258 + 900;
  const audio = durationSec * 32;
  return video * (0.3 / 1e6) + audio * (1.0 / 1e6) + 900 * (2.5 / 1e6);
}

async function main() {
  if (!TOKEN || !IG_USER_ID) { console.error("IG_ACCESS_TOKEN / IG_USER_ID missing."); process.exit(1); }
  if (!GEMINI_KEY) { console.error("GEMINI_API_KEY missing — set it in .env to run this probe."); process.exit(1); }

  const mediaId = process.argv[2];
  console.log(`Fetching reel ${mediaId ?? "(first with video)"} …`);
  const reel = await getReel(mediaId);
  console.log(`  id=${reel.id}  audio=${reel.media_audio_type ?? "?"}  caption="${(reel.caption ?? "").slice(0, 60)}"`);

  if (!reel.media_url) {
    console.log("  ⚠ media_url absent (licensed audio) — this reel would take the TEXT fallback path. Pick another id to test video.");
    process.exit(0);
  }

  console.log("Downloading video …");
  const vid = await fetch(reel.media_url);
  const buf = Buffer.from(await vid.arrayBuffer());
  console.log(`  ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB`);
  if (buf.byteLength > MAX_INLINE_BYTES) { console.log("  ⚠ too large for inline; would fall back to text. Stopping."); process.exit(0); }

  console.log(`Sending to Gemini ${MODEL} …`);
  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inlineData: { mimeType: "video/mp4", data: buf.toString("base64") } }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const json = await res.json();
  if (json.error) { console.error("Gemini error:", json.error.message); process.exit(1); }

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  console.log("\n=== CONTENT PROFILE ===");
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  console.log(`\nEstimated cost (15s assumption): $${estimateCost().toFixed(4)}`);
  console.log("Done. (read-only — nothing written to the DB)\n");
}

main().catch((e) => { console.error("Probe crashed:", e.message); process.exit(1); });
