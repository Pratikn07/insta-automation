import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// One-off demo seed: write the EARLIER-PROBED follow values onto a single ig_users
// row so the dashboard follow badge renders before any post-deploy DM arrives.
// These are real values read during this session's probe — but hand-written here for
// display, NOT earned by the live resolve path. The first real DM from this user
// would overwrite them with fresh data. Scoped to one id; idempotent.
const TARGET = {
  id: "1026545877009323", // @swathi.makeover
  isFollower: true,
  followerCount: 2214,
  isVerified: false,
};

async function main() {
  const before = await prisma.igUser.findUnique({ where: { id: TARGET.id } });
  if (!before) {
    console.log(`No ig_users row for ${TARGET.id} — nothing to seed.`);
    return;
  }
  console.log(`Before: @${before.username} is_follower=${before.isFollower} follower_count=${before.followerCount}`);

  const after = await prisma.igUser.update({
    where: { id: TARGET.id },
    data: {
      isFollower: TARGET.isFollower,
      followerCount: TARGET.followerCount,
      isVerified: TARGET.isVerified,
      followCheckedAt: new Date(),
    },
  });
  console.log(`After:  @${after.username} is_follower=${after.isFollower} follower_count=${after.followerCount} verified=${after.isVerified}`);
  console.log("\nSeeded. Refresh the Users page — @swathi.makeover should show the follow badge.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
