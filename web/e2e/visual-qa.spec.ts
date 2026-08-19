import { expect, test } from "@playwright/test";

/**
 * Visual QA artifacts, from fixtures only.
 *
 * These exist so the release record contains something a person can look at, not
 * just counts. Everything is stubbed at the HTTP boundary by e2e/main.tsx — the
 * local backend is never started and never points at production — and every
 * fixture is synthetic, so no real follower count or username reaches a committed
 * PNG.
 *
 * Not assertions about layout. The one thing asserted here is what a screenshot
 * cannot prove on its own: that the chart's marks are opaque and none of them is
 * white.
 */

const ARTIFACTS = "../docs/qa/artifacts/2026-08-16-maison-editorial";

async function open(page: import("@playwright/test").Page, scenario: string) {
  // A fixed clock keeps "provisional" and every relative label deterministic.
  await page.clock.install({ time: new Date("2026-08-18T06:00:00.000Z") });
  await page.goto(`/e2e/index.html?scenario=${scenario}`);
}

/**
 * Advance the frozen clock past any entrance animation before capturing.
 *
 * `clock.install` stops time, and framer-motion drives its transitions from it, so
 * a staggered list stays permanently mid-fade. Content's grid caps its stagger at
 * 11 * 0.03s + 0.2s, so half a second settles every tile. Without this the artifact
 * showed a 300px void where the third post should be — a screenshot that
 * misrepresents the page is worse than no screenshot, because it gets believed.
 */
async function settleAnimations(page: import("@playwright/test").Page) {
  await page.clock.runFor(600);
}

async function capture(
  page: import("@playwright/test").Page,
  project: string,
  name: string,
) {
  const folder = project === "mobile" ? "mobile" : "desktop";
  await page.screenshot({ path: `${ARTIFACTS}/${folder}/${name}.png`, fullPage: true });
}

test.describe("visual QA artifacts", () => {
  test("home and its follower chart", async ({ page }, testInfo) => {
    await open(page, "home");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    // The chart is the surface this release repainted. Today's Read is deliberately
    // not required here: it withholds itself unless two contiguous settled Pacific
    // windows exist, which is a measurement rule rather than a rendering one.
    const chart = page.locator("svg").first();
    await expect(chart).toBeVisible();
    await capture(page, testInfo.project.name, "home");

    const svg = (await chart.innerHTML()) + (await chart.getAttribute("class") ?? "");
    // What the eye cannot check from a PNG: the two strokes that used to be a
    // semi-transparent white, invisible on paper.
    expect(svg).not.toContain("255 255 255");
    // And that no mark is faded below the contrast its colour was chosen to clear.
    expect(svg).not.toMatch(/\sopacity="0(\.\d+)?"/);
  });

  test("conversations, needs reply", async ({ page }, testInfo) => {
    await open(page, "canonical-conversations");
    await expect(page.getByRole("button", { name: "Needs reply" })).toBeVisible();
    await capture(page, testInfo.project.name, "conversations-needs-reply");
  });

  test("conversations, people lens", async ({ page }, testInfo) => {
    await open(page, "canonical-conversations");
    await page.getByRole("button", { name: "People" }).click();
    await expect(page.getByPlaceholder("Search by @username or name…")).toBeVisible();
    await capture(page, testInfo.project.name, "conversations-people");
  });

  test("dm recovery", async ({ page }, testInfo) => {
    await open(page, "recovery-ready");
    await expect(page.getByRole("heading", { name: "DM recovery" })).toBeVisible();
    await capture(page, testInfo.project.name, "dm-recovery");
  });

  test("historical recovery", async ({ page }, testInfo) => {
    await open(page, "historical-dashboard");
    await expect(page.getByRole("heading").first()).toBeVisible();
    await capture(page, testInfo.project.name, "historical-recovery");
  });

  test("funnels", async ({ page }, testInfo) => {
    await open(page, "funnels");
    await expect(page.getByRole("heading").first()).toBeVisible();
    await capture(page, testInfo.project.name, "funnels");
  });

  test("sequence editor", async ({ page }, testInfo) => {
    await open(page, "sequence-editor");
    await expect(page.getByRole("heading").first()).toBeVisible();
    await capture(page, testInfo.project.name, "sequence-editor");
  });

  test("insights", async ({ page }, testInfo) => {
    await open(page, "insights");
    await expect(page.getByRole("button", { name: "Leaderboard" })).toBeVisible();
    await capture(page, testInfo.project.name, "insights");
  });

  test("sequences list", async ({ page }, testInfo) => {
    await open(page, "sequences");
    await expect(page.getByRole("heading").first()).toBeVisible();
    await capture(page, testInfo.project.name, "sequences");
  });

  test("assistant", async ({ page }, testInfo) => {
    await open(page, "advisor");
    await expect(page.getByPlaceholder("What should I focus on this week?")).toBeVisible();
    await capture(page, testInfo.project.name, "assistant");
  });

  /**
   * Content, which the Maison QA never captured — so its dark-shell leftovers
   * survived a release that looked at ten other surfaces. The status chips are the
   * point: their predecessors measured 1.2:1 on this paper and no test could see it.
   */
  test("content and its upcoming setups", async ({ page }, testInfo) => {
    await open(page, "content");
    await expect(page.getByRole("heading", { level: 1, name: "Content" })).toBeVisible();

    // All three chips in one frame — the failure, the wait, and the receipt.
    // `exact` because each row's sentence also contains its status word.
    await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
    await expect(page.getByText("Waiting", { exact: true })).toBeVisible();
    await expect(page.getByText("Attached", { exact: true })).toBeVisible();

    // Pending setups come FIRST, above the grid. Worth failing on: the earlier
    // order read fine against four fixture tiles and buried the whole feature
    // fifty rows down against a real account of 197 posts.
    const grid = page.getByRole("tab", { name: /All/ });
    const upcoming = page.getByRole("heading", { name: "Set up in advance" });
    await expect(grid).toBeVisible();
    await expect(upcoming).toBeVisible();
    const gridBox = await grid.boundingBox();
    const upcomingBox = await upcoming.boundingBox();
    expect(upcomingBox!.y).toBeLessThan(gridBox!.y);

    // And it must be reachable without scrolling, which is the whole point.
    expect(upcomingBox!.y).toBeLessThan(page.viewportSize()!.height);

    await settleAnimations(page);
    await capture(page, testInfo.project.name, "content");
  });

  /**
   * Every switch in the system, with the safety model visible rather than
   * described: a Stop now that has no matching start beside it, and a flag the
   * console cannot touch at all.
   */
  test("things we're testing", async ({ page }, testInfo) => {
    await open(page, "flags");
    await expect(
      page.getByRole("heading", { level: 1, name: "Things we're testing" }),
    ).toBeVisible();

    // Grouped loudest-first, so the group that can reach a real parent is the one
    // you land on during an incident.
    const outbound = page.getByText("Reaches real people");
    const assistive = page.getByText("Nothing leaves the app");
    await expect(outbound).toBeVisible();
    await expect(assistive).toBeVisible();
    const outboundBox = await outbound.boundingBox();
    const assistiveBox = await assistive.boundingBox();
    expect(outboundBox!.y).toBeLessThan(assistiveBox!.y);

    // A stop with no start, and a row offering neither.
    await expect(page.getByRole("button", { name: "Stop Recovery reminders" })).toBeVisible();
    await expect(page.getByText("changed in Railway")).toBeVisible();
    // The drift warning, which only a screenshot can show is legible on paper.
    await expect(page.getByText(/a restart would change this back/i)).toBeVisible();

    await settleAnimations(page);
    await capture(page, testInfo.project.name, "flags");
  });

  /**
   * The same failure as Home sees it. Content is where she fixes an unattached
   * keyword; this is the surface that tells her to go there at all.
   */
  test("home surfaces an unattached keyword as the best next move", async ({ page }, testInfo) => {
    await open(page, "home");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

    await expect(page.getByText("Best next move")).toBeVisible();
    // `exact` targets the hero's own CTA. The same item also renders as row 01 of
    // the attention list below, whose accessible name carries the "01" prefix.
    await expect(
      page.getByRole("link", {
        name: "A keyword didn't attach to your new post",
        exact: true,
      }),
    ).toBeVisible();

    await capture(page, testInfo.project.name, "home-unattached-keyword");
  });
});
