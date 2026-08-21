import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVED_PUBLIC_REPLY,
  standardizePublicReplies,
  type PublicReplyRolloutPrisma,
} from "./standardize-public-replies.js";

type KeywordRow = { active: boolean; publicReply: string };
type UpcomingAutomationRow = {
  active: boolean;
  publicReply: string;
  status: "waiting" | "bound" | "needs_attention" | "cancelled";
};

function matches(where: Record<string, unknown>, row: object): boolean {
  const values = row as Record<string, unknown>;
  return Object.entries(where).every(([key, condition]) => {
    const value = values[key];
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      const filter = condition as { in?: unknown[]; not?: unknown };
      if (filter.in) return filter.in.includes(value);
      if ("not" in filter) return value !== filter.not;
    }
    return value === condition;
  });
}

function stubPrisma(keywords: KeywordRow[], upcomingAutomations: UpcomingAutomationRow[]) {
  let transactionCalls = 0;
  let updateCalls = 0;
  let countCallsInFlight = 0;
  let maximumCountCallsInFlight = 0;

  const prisma: PublicReplyRolloutPrisma = {
    keyword: {
      count: async ({ where }) => {
        countCallsInFlight += 1;
        maximumCountCallsInFlight = Math.max(maximumCountCallsInFlight, countCallsInFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        countCallsInFlight -= 1;
        return keywords.filter((row) => matches(where, row)).length;
      },
      updateMany: async ({ where, data }) => {
        const rows = keywords.filter((row) => matches(where, row));
        rows.forEach((row) => Object.assign(row, data));
        updateCalls += 1;
        return { count: rows.length };
      },
    },
    upcomingAutomation: {
      count: async ({ where }) => {
        countCallsInFlight += 1;
        maximumCountCallsInFlight = Math.max(maximumCountCallsInFlight, countCallsInFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        countCallsInFlight -= 1;
        return upcomingAutomations.filter((row) => matches(where, row)).length;
      },
      updateMany: async ({ where, data }) => {
        const rows = upcomingAutomations.filter((row) => matches(where, row));
        rows.forEach((row) => Object.assign(row, data));
        updateCalls += 1;
        return { count: rows.length };
      },
    },
    $transaction: async (work) => {
      transactionCalls += 1;
      return work(prisma);
    },
  };

  return {
    prisma,
    transactionCalls: () => transactionCalls,
    updateCalls: () => updateCalls,
    maximumCountCallsInFlight: () => maximumCountCallsInFlight,
  };
}

describe("standardizePublicReplies", () => {
  it("previews eligible rows without writing", async () => {
    const keywords: KeywordRow[] = [
      { active: true, publicReply: "old keyword copy" },
      { active: false, publicReply: "inactive keyword copy" },
      { active: true, publicReply: APPROVED_PUBLIC_REPLY },
    ];
    const upcomingAutomations: UpcomingAutomationRow[] = [
      { active: true, status: "waiting", publicReply: "old waiting copy" },
      { active: true, status: "needs_attention", publicReply: "old attention copy" },
      { active: true, status: "bound", publicReply: "bound copy" },
      { active: false, status: "waiting", publicReply: "inactive waiting copy" },
      { active: true, status: "waiting", publicReply: APPROVED_PUBLIC_REPLY },
    ];
    const database = stubPrisma(keywords, upcomingAutomations);

    assert.deepEqual(await standardizePublicReplies(database.prisma), {
      keywords: 1,
      upcomingAutomations: 2,
    });

    assert.deepEqual(keywords.map((row) => row.publicReply), [
      "old keyword copy",
      "inactive keyword copy",
      APPROVED_PUBLIC_REPLY,
    ]);
    assert.deepEqual(upcomingAutomations.map((row) => row.publicReply), [
      "old waiting copy",
      "old attention copy",
      "bound copy",
      "inactive waiting copy",
      APPROVED_PUBLIC_REPLY,
    ]);
    assert.equal(database.transactionCalls(), 0);
    assert.equal(database.updateCalls(), 0);
  });

  it("reads preview counts serially", async () => {
    const database = stubPrisma(
      [{ active: true, publicReply: "old keyword copy" }],
      [{ active: true, status: "waiting", publicReply: "old waiting copy" }],
    );

    await standardizePublicReplies(database.prisma);

    assert.equal(database.maximumCountCallsInFlight(), 1);
  });

  it("writes only active keywords and active waiting or needs-attention upcoming automations", async () => {
    const keywords: KeywordRow[] = [
      { active: true, publicReply: "old keyword copy" },
      { active: false, publicReply: "inactive keyword copy" },
    ];
    const upcomingAutomations: UpcomingAutomationRow[] = [
      { active: true, status: "waiting", publicReply: "old waiting copy" },
      { active: true, status: "needs_attention", publicReply: "old attention copy" },
      { active: true, status: "bound", publicReply: "bound copy" },
      { active: true, status: "cancelled", publicReply: "cancelled copy" },
      { active: false, status: "waiting", publicReply: "inactive waiting copy" },
    ];
    const database = stubPrisma(keywords, upcomingAutomations);

    assert.deepEqual(await standardizePublicReplies(database.prisma, { write: true }), {
      keywords: 1,
      upcomingAutomations: 2,
    });

    assert.deepEqual(keywords.map((row) => row.publicReply), [
      APPROVED_PUBLIC_REPLY,
      "inactive keyword copy",
    ]);
    assert.deepEqual(upcomingAutomations.map((row) => row.publicReply), [
      APPROVED_PUBLIC_REPLY,
      APPROVED_PUBLIC_REPLY,
      "bound copy",
      "cancelled copy",
      "inactive waiting copy",
    ]);
    assert.equal(database.transactionCalls(), 1);
    assert.equal(database.updateCalls(), 2);
  });

  it("reports zero remaining changes when write mode is repeated", async () => {
    const keywords: KeywordRow[] = [{ active: true, publicReply: "old keyword copy" }];
    const upcomingAutomations: UpcomingAutomationRow[] = [
      { active: true, status: "waiting", publicReply: "old waiting copy" },
    ];
    const database = stubPrisma(keywords, upcomingAutomations);

    await standardizePublicReplies(database.prisma, { write: true });

    assert.deepEqual(await standardizePublicReplies(database.prisma, { write: true }), {
      keywords: 0,
      upcomingAutomations: 0,
    });
  });
});
