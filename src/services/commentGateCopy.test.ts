import { describe, expect, it } from "vitest";
import { selectCommentGate } from "./commentGateCopy.js";

describe("selectCommentGate", () => {
  it.each([
    {
      isFollower: true,
      expected: {
        variant: "known_follower",
        text: "So lovely to see you again 💛 Reply DONE and I’ll send your guide right over.",
      },
    },
    {
      isFollower: false,
      expected: {
        variant: "default",
        text: "Reply DONE and I’ll send your guide.",
      },
    },
    {
      isFollower: null,
      expected: {
        variant: "default",
        text: "Reply DONE and I’ll send your guide.",
      },
    },
  ] as const)("selects the expected gate for cached isFollower=$isFollower", ({ isFollower, expected }) => {
    expect(
      selectCommentGate({
        isFollower,
        defaultMessage: "Reply DONE and I’ll send your guide.",
      }),
    ).toEqual(expected);
  });
});
