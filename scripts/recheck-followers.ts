import { prisma } from "../src/lib/prisma.js";
import { resolveUsername, getIgUsers } from "../src/services/igUserService.js";
import { logEvent } from "../src/services/eventLogger.js";

// One-off (safe to re-run): establish a follower-yield baseline immediately by
// clearing the historical recheck backlog in one pass, with no delay/age bounds.
// Mirrors runFollowRecheckTick exactly — known followers are stamped without an
// API call; only the convertible pool (isFollower not yet true) costs a Graph
// call. Also confirms at scale that the follow flag stays readable after the
// messaging window closes (expect ~0 consent errors).
const PER_CALL_GAP_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const due = await prisma.conversation.findMany({
    where: { state: "completed", followRecheckedAt: null },
    orderBy: { completedAt: "asc" },
    select: { id: true, igUserId: true },
  });

  const convosByUser = new Map<string, string[]>();
  for (const c of due) {
    const list = convosByUser.get(c.igUserId) ?? [];
    list.push(c.id);
    convosByUser.set(c.igUserId, list);
  }

  const users = await getIgUsers([...convosByUser.keys()]);
  const convertible = [...convosByUser.keys()].filter((id) => users[id]?.isFollower !== true).length;
  console.log(
    `${due.length} completed conversations across ${convosByUser.size} users; ` +
      `${convosByUser.size - convertible} already-following (no API call), ${convertible} to re-read`,
  );

  let apiCalls = 0;
  let converted = 0;
  let unreadable = 0;
  let processed = 0;

  for (const [igUserId, convoIds] of convosByUser) {
    const cached = users[igUserId];
    let isFollowerNow: boolean | null;
    let apiCall: boolean;

    if (cached?.isFollower === true) {
      isFollowerNow = true;
      apiCall = false;
    } else {
      const profile = await resolveUsername(igUserId);
      isFollowerNow = profile.isFollower;
      apiCall = true;
      apiCalls++;
      if (profile.isFollower === null) unreadable++;
    }

    const didConvert = isFollowerNow === true;
    if (didConvert) converted++;

    await prisma.conversation.updateMany({
      where: { id: { in: convoIds } },
      data: { followRecheckedAt: new Date() },
    });
    await logEvent("follow_recheck", {
      igUserId,
      conversationIds: convoIds,
      isFollowerNow,
      converted: didConvert,
      apiCall,
      source: "baseline_script",
    });

    processed++;
    if (apiCall && processed % 25 === 0) console.log(`  …${processed}/${convosByUser.size} users`);
    if (apiCall) await sleep(PER_CALL_GAP_MS);
  }

  console.log(
    `\nBaseline complete — ${convosByUser.size} users measured (${apiCalls} API calls), ` +
      `${converted} now follow, ${unreadable} unreadable (consent/dead IGSID)`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
