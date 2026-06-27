import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.IG_ACCESS_TOKEN;
const VERSION = "v21.0";

// FEASIBILITY PROBE (read-only, no DB writes). Asks Instagram for the messaging
// User Profile fields — including is_user_follow_business — on real users who have
// DM'd us. Tells us definitively whether THIS account/token can read follow status
// in a messaging context, before we design any follow-based routing.
//
// We test fields incrementally so a single unsupported field doesn't mask the rest.
const USERS = [
  { id: "2115093355888598", username: "christinacharles248" },
  { id: "1026545877009323", username: "swathi.makeover" },
  { id: "763038003536693", username: "__kavitha.__" },
  { id: "897238570069570", username: "meghashreehsdec7" },
  { id: "2178818986305956", username: "kavii.vk" },
];

// Field sets to try, from richest to safest.
const FIELD_SETS = [
  "name,username,is_user_follow_business,is_business_follow_user,is_verified_user,follower_count",
  "name,username,is_user_follow_business",
  "name,username",
];

async function tryFields(id, fields) {
  const url = `https://graph.instagram.com/${VERSION}/${id}?fields=${encodeURIComponent(fields)}&access_token=${TOKEN}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  return { ok: !body.error, status: res.status, body };
}

async function main() {
  if (!TOKEN) {
    console.error("IG_ACCESS_TOKEN missing — run from project root so .env loads.");
    process.exit(1);
  }

  let followFieldWorks = false;

  for (const u of USERS) {
    console.log(`\n=== @${u.username} (${u.id}) ===`);
    let resolved = false;
    for (const fields of FIELD_SETS) {
      const { ok, status, body } = await tryFields(u.id, fields);
      if (ok) {
        console.log(`  ✓ fields [${fields}]`);
        console.log(`    ${JSON.stringify(body)}`);
        if ("is_user_follow_business" in body) followFieldWorks = true;
        resolved = true;
        break; // got a working field set for this user
      } else {
        console.log(
          `  ✗ [${fields.split(",").slice(2).join(",") || "basic"}] → ${status} ${body.error?.code}/${body.error?.error_subcode ?? "-"}: ${body.error?.message}`,
        );
      }
    }
    if (!resolved) console.log("  (no field set succeeded for this user)");
  }

  console.log(`\n=== VERDICT ===`);
  if (followFieldWorks) {
    console.log("  ✅ is_user_follow_business IS returned on this account — follow-based");
    console.log("     routing is viable (when the user is in a messaging context).");
  } else {
    console.log("  ❌ is_user_follow_business was NOT returned for any user — either the");
    console.log("     permission/tier doesn't allow it, or the field isn't available here.");
    console.log("     Follow-based routing is NOT feasible right now; rely on the");
    console.log("     'any reply -> send guide' fix instead.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
