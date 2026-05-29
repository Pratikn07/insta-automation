import { prisma } from "../src/lib/prisma.js";

async function main() {
  const playResource = await prisma.resource.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Toddler Activity Guide",
      description: "Sample seed — replace media URLs with real Supabase Storage URLs",
      messages: {
        create: [
          {
            order: 0,
            type: "text",
            body: "Yay! Here is your toddler activity guide ❤️",
          },
          {
            order: 1,
            type: "image",
            mediaUrl: "https://example.com/replace-me.jpg",
            body: "Save this card and try one activity today!",
          },
        ],
      },
    },
  });

  await prisma.keyword.upsert({
    where: { keyword: "PLAY" },
    update: {},
    create: {
      keyword: "PLAY",
      resourceId: playResource.id,
      publicReply: "Check your DMs ❤️",
      gateMessage:
        "Hi! ❤️\n\nBefore I send the activity guide, please follow @tinysoho and reply DONE once you've followed.\n\nI share toddler activities, learning ideas, and parenting tips almost every day.",
    },
  });

  console.log("Seeded keyword PLAY");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
