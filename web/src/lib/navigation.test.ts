import { describe, expect, it } from "vitest";
import {
  HOME_DESTINATION,
  NAV_DESTINATIONS,
  NAV_GROUPS,
  titleForPath,
} from "./navigation";

describe("navigation metadata", () => {
  it("keeps Home above the four agreed rail groups", () => {
    expect(HOME_DESTINATION).toMatchObject({ path: "/", label: "Home" });
    expect(NAV_GROUPS.map((group) => group.heading)).toEqual([
      "Measure",
      "Publish",
      "Audience",
      "System",
    ]);
  });

  it("defines every rail destination once", () => {
    expect(NAV_GROUPS.map((group) => group.items.map((item) => item.label))).toEqual([
      ["Insights", "Funnels"],
      ["Content", "Keywords", "Guides"],
      ["Conversations", "DM recovery", "Historical recovery"],
      ["Things we're testing", "Activity", "Assistant"],
    ]);

    const paths = NAV_DESTINATIONS.map((destination) => destination.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it.each([
    ["/", "Home"],
    ["/insights", "Insights"],
    ["/funnels", "Funnels"],
    ["/content", "Content"],
    ["/keywords", "Keywords"],
    ["/guides", "Guides"],
    ["/conversations", "Conversations"],
    ["/dm-recovery", "DM recovery"],
    ["/historical-recovery", "Historical recovery"],
    // Shorter on mobile than in the rail: the rail has room for the sentence, a
    // mobile title bar does not.
    ["/flags", "Testing"],
    ["/activity", "Activity"],
    ["/assistant", "Assistant"],
    ["/guides/sequence-1", "Guide editor"],
    ["/unknown", "Tiny Soho"],
  ])("maps %s to the mobile title %s", (path, expected) => {
    expect(titleForPath(path)).toBe(expected);
  });
});
