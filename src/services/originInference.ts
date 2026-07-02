// Infer a user's audience ORIGIN from their username + display name.
//
// This is an explicit PROXY, never ground truth: Meta exposes no per-user
// country, so we lean on linguistic cues. Every origin call requires a POSITIVE
// signal — we NEVER guess a residual (validated on real data: treating
// "Latin name, no SA cue" as us_western mislabeled many diaspora S-Asian names
// like "Shravya Rachakonda"/"Anusha Ram" as American). Outcomes:
//   - south_asian (high): a non-Latin S-Asian/Arabic script, OR a distinctive
//     S-Asian name token.
//   - us_western (low): a distinctive Western given-name/surname token.
//   - unknown (low): no recognizable cue — name-only genuinely can't place it
//     (~70% of this audience; a later bio pass could upgrade some). Shown as
//     "unknown" in the UI, never faked into a country.
//
// Pure function (no DB, no IO) so it's trivially testable and shared by the
// backfill script and any live resolver.

export type Origin = "us_western" | "south_asian" | "other" | "unknown";

export interface OriginResult {
  origin: Origin;
  confidence: "high" | "low";
  method: "name"; // name-only for now; "name_bio" reserved for a future pass
  evidence: string; // what drove the call, for auditability in the UI
}

// Unicode ranges for South-Asian + Arabic/Urdu scripts. A hit here is a strong,
// high-confidence signal the account is South-Asian (or SA-diaspora).
const SASIAN_SCRIPTS: Array<{ label: string; re: RegExp }> = [
  { label: "tamil", re: /[஀-௿]/ },
  { label: "telugu", re: /[ఀ-౿]/ },
  { label: "devanagari", re: /[ऀ-ॿ]/ },
  { label: "kannada", re: /[ಀ-೿]/ },
  { label: "malayalam", re: /[ഀ-ൿ]/ },
  { label: "bengali", re: /[ঀ-৿]/ },
  { label: "gurmukhi", re: /[਀-੿]/ },
  { label: "gujarati", re: /[઀-૿]/ },
  { label: "arabic_urdu", re: /[؀-ۿ]/ },
];

// Distinctive South-Asian name tokens (given names + surnames + honorifics).
// Deliberately high-precision — only tokens that are overwhelmingly S-Asian, to
// avoid false-tagging Western names. Missing a name just yields low confidence.
const SASIAN_TOKENS = [
  // surnames / community markers
  "reddy", "sharma", "nair", "iyer", "patel", "kumar", "singh", "gupta", "devi",
  "krishna", "ramesh", "suresh", "mahesh", "sandeep", "kaur", "rao", "menon",
  "pillai", "chowdhury", "banerjee", "mukherjee", "agarwal", "agrawal", "jain",
  "shah", "mehta", "desai", "naidu", "chandra", "prasad", "venkat", "subramani",
  "raghu", "murugan", "selvakumar", "balaji", "vairamuthu", "manjunath",
  // given names
  "priya", "divya", "swetha", "shruti", "anjali", "haripriya", "nithya", "madhuri",
  "mahima", "yamini", "vachana", "kratika", "nirmitha", "afrin", "mehak", "swati",
  "aishwarya", "bhavya", "pooja", "neha", "sneha", "priyanka", "deepika", "lakshmi",
  "harshitha", "spandana", "sravya", "bharathi", "kayalvizhi", "madhumitha",
  "aarthi", "hemalatha", "jeevitha", "akhila", "poovizha", "dharshini",
];

// Distinctive Anglo/Western given names + surnames. High-precision: only names
// that are overwhelmingly Western, so a hit is a real (if low-confidence) signal
// rather than a residual guess. A name absent from BOTH lists stays `unknown`.
const WESTERN_TOKENS = [
  // given names
  "elaine", "angelina", "irena", "debbie", "emily", "kathy", "natasha", "sarah",
  "jessica", "jennifer", "ashley", "amanda", "megan", "lauren", "hannah", "rachel",
  "rebecca", "nicole", "stephanie", "heather", "brittany", "kayla", "chloe",
  "abigail", "madison", "taylor", "brooke", "courtney", "danielle", "kelly",
  // surnames
  "robbins", "cochran", "murphy", "smith", "johnson", "williams", "brown", "jones",
  "miller", "davis", "wilson", "moore", "taylor", "anderson", "thomas", "jackson",
  "white", "harris", "martin", "thompson", "garcia", "clark", "carr", "marsh",
  "cowell", "sherry",
];

// Light diacritic fold so "Nataša"/"Māgi" style Western names aren't mistaken
// for anything, and token matching is accent-insensitive.
function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function inferOrigin(username: string | null, name: string | null): OriginResult {
  const raw = `${name ?? ""} ${username ?? ""}`.trim();

  // 1. Script hit → high-confidence South Asian.
  for (const s of SASIAN_SCRIPTS) {
    if (s.re.test(raw)) {
      return { origin: "south_asian", confidence: "high", method: "name", evidence: `${s.label} script` };
    }
  }

  // Nothing to go on at all.
  if (!raw) return { origin: "unknown", confidence: "low", method: "name", evidence: "no name/username" };

  // 2. Distinctive token hit → high-confidence South Asian.
  const folded = fold(raw);
  const words = folded.split(/[^a-z]+/).filter(Boolean);
  const wordSet = new Set(words);
  for (const tok of SASIAN_TOKENS) {
    // whole-word match OR substring for the longer, unambiguous surnames
    if (wordSet.has(tok) || (tok.length >= 5 && folded.includes(tok))) {
      return { origin: "south_asian", confidence: "high", method: "name", evidence: `token: ${tok}` };
    }
  }

  // 3. Western requires a POSITIVE signal — never a residual guess. Validated on
  //    real data: treating "Latin name, no SA cue" as us_western mislabels the
  //    many Latin-script South-Asian names (Meenakshi Selvam, Shravya Rachakonda,
  //    Anusha Ram…) as American. So a Western call needs an actual Western
  //    given-name/surname token; everything else is honestly `unknown` (a
  //    name-only pass can't place it — a later bio pass might).
  for (const tok of WESTERN_TOKENS) {
    if (wordSet.has(tok)) {
      return { origin: "us_western", confidence: "low", method: "name", evidence: `western token: ${tok}` };
    }
  }
  return { origin: "unknown", confidence: "low", method: "name", evidence: "no name cue (name-only can't place)" };
}
