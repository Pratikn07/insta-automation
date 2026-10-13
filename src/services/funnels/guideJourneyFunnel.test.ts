import { describe, expect, it } from "vitest";
import { summarizeGuideJourney, type GuideJourneyRow } from "./guideJourneyFunnel.js";

const WINDOW = { from: "2026-09-14T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" };
let n = 0;
function person(over: Partial<GuideJourneyRow> = {}): GuideJourneyRow {
  n += 1;
  return {
    igUserId: `ig-${n}`,
    username: null,
    lastKeyword: null,
    cards: 1,
    lastAskedAt: new Date("2026-10-01T00:00:00.000Z"),
    reached: true,
    saidYes: false,
    hitWall: false,
    followed: false,
    gotGuide: false,
    d21Read: false,
    d21Following: false,
    d21Due: false,
    quietBucket: null,
    wallBucket: null,
    ...over,
  };
}
const many = (count: number, over: Partial<GuideJourneyRow>) =>
  Array.from({ length: count }, () => person(over));

describe("summarizeGuideJourney", () => {
  const rows = [
    ...many(4, { quietBucket: "cannot_tell" }),
    ...many(2, { quietBucket: "still_has_time" }),
    // Already following: said yes, never hit the wall.
    ...many(6, { saidYes: true, gotGuide: true }),
    // New followers, five of them read at 21 days and still following.
    ...many(5, {
      saidYes: true,
      hitWall: true,
      followed: true,
      gotGuide: true,
      d21Read: true,
      d21Following: true,
      d21Due: true,
    }),
    ...many(1, { saidYes: true, hitWall: true, followed: true, gotGuide: true, d21Due: true }),
    ...many(3, { saidYes: true, hitWall: true, wallBucket: "never_came_back" }),
    ...many(1, { saidYes: true, hitWall: true, wallBucket: "said_followed" }),
    // Asked, but no card reached them (an audience block, say).
    person({ reached: false }),
  ];
  const s = summarizeGuideJourney(rows, WINDOW);

  it("counts the trunk per person and keeps the reply rate Home reads", () => {
    expect(s.cohortSize).toBe(23);
    expect(s.stages.map((x) => [x.key, x.count])).toEqual([
      ["asked", 23],
      ["reached", 22],
      ["saidYes", 16],
    ]);
    expect(s.headline.label).toBe("Reply rate");
    expect(s.headline.rate).toMatchObject({ numerator: 16, denominator: 22 });
  });

  it("splits everyone who said yes into exactly one lane", () => {
    expect(s.lanes.alreadyFollowing.people + s.lanes.notFollowing.people).toBe(16);
    expect(s.lanes.alreadyFollowing).toMatchObject({
      people: 6,
      gotGuide: { numerator: 6, denominator: 6 },
    });
    expect(s.lanes.notFollowing.people).toBe(10);
  });

  it("leads with new followers out of those not following, and guides out of everyone who asked", () => {
    expect(s.newFollowers).toMatchObject({ numerator: 6, denominator: 10, pct: 60 });
    expect(s.gotGuide).toMatchObject({ numerator: 12, denominator: 23 });
  });

  it("makes each leak add up to the gap it explains", () => {
    expect(s.leaks.neverSaidYes.total).toBe(22 - 16);
    expect(s.leaks.neverSaidYes.buckets).toEqual({
      still_has_time: 2,
      wrote_not_yes: 0,
      opened_ignored: 0,
      no_sign_opened: 0,
      cannot_tell: 4,
    });
    expect(s.leaks.stuckAtWall.total).toBe(10 - 6);
    expect(s.leaks.stuckAtWall.buckets).toEqual({
      still_has_time: 0,
      said_followed: 1,
      never_came_back: 3,
    });
  });

  it("reports retention over new followers who were read, never over everyone", () => {
    // The old page drew this against the whole cohort and printed "2%" while 67 of
    // 69 converts were still following.
    expect(s.retention.due).toBe(6);
    expect(s.retention.rate).toMatchObject({ numerator: 5, denominator: 5, pct: 100 });
  });

  it("suppresses a rate below the minimum sample", () => {
    const thin = summarizeGuideJourney(
      many(3, { saidYes: true, hitWall: true, followed: true }),
      WINDOW,
    );
    expect(thin.newFollowers).toMatchObject({
      numerator: 3,
      denominator: 3,
      pct: null,
      belowMinSample: true,
    });
  });
});
