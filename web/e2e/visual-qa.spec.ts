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
  const artifacts = name.startsWith("home")
    ? "../docs/qa/artifacts/2026-10-04-dashboard-analytics-removal"
    : ARTIFACTS;
  await page.screenshot({ path: `${artifacts}/${folder}/${name}.png`, fullPage: true });
}

test.describe("visual QA artifacts", () => {
  test("home shows operational evidence without follower reporting", async ({ page }, testInfo) => {
    await open(page, "home");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await expect(page.getByText("System pulse", { exact: true })).toBeVisible();
    await expect(page.getByText("What needs attention", { exact: true })).toBeVisible();
    await expect(page.getByText("Gate DM sent to Replied DONE", { exact: true })).toBeVisible();
    await expect(page.getByText("Total followers", { exact: true })).toHaveCount(0);
    await expect(page.getByText("US followers this week", { exact: true })).toHaveCount(0);
    await capture(page, testInfo.project.name, "home");
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
    // The cover panel resolves on its OWN query, after the cohort funnel. `fullPage`
    // measures the document height once, so without this wait the panel's numbers landed
    // below the measured height and the mobile artifact ended mid-blurb — capturing the
    // heading of the one surface the screenshot exists to check, and none of its content.
    // Any of the panel's four terminal states will do; what must not happen is capturing
    // while it is still growing.
    await expect(
      page
        .getByText(
          /in the follow gate|no cover has been considered|does not report cover numbers|could not be loaded/i,
        )
        .first(),
    ).toBeVisible();
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
   * The switch list. A screenshot is the only thing that can show it is scannable:
   * the page it replaced carried three sentences on every one of sixteen rows, and
   * "too overwhelming" is a judgment about the whole page at once.
   */
  test("switches", async ({ page }, testInfo) => {
    await open(page, "switches");
    await expect(page.getByRole("heading", { level: 1, name: "Switches" })).toBeVisible();

    // The rewrite's whole point: no descriptions and no controls in the list.
    await expect(page.getByText("Who it affects:")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Stop / })).toHaveCount(0);

    // Grouped loudest-first, so the group that can reach a real person is the one
    // you land on during an incident.
    const outbound = page.getByText("Reaches real people");
    const assistive = page.getByText("Nothing leaves the app");
    await expect(outbound).toBeVisible();
    await expect(assistive).toBeVisible();
    const outboundBox = await outbound.boundingBox();
    const assistiveBox = await assistive.boundingBox();
    expect(outboundBox!.y).toBeLessThan(assistiveBox!.y);

    // Five switches move together and nothing used to say so.
    await expect(page.getByText("part of Recovery reminder — 2 vs 6 hours").first()).toBeVisible();

    await settleAnimations(page);
    await capture(page, testInfo.project.name, "switches");
  });

  /**
   * One switch, where the safety model is visible rather than described: a Stop now
   * with no matching start beside it, and the drift warning, which only a screenshot
   * can show is legible on paper.
   */
  test("switch detail", async ({ page }, testInfo) => {
    await open(page, "switch-detail");
    await expect(
      page.getByRole("heading", { level: 1, name: "Recovery reminders" }),
    ).toBeVisible();

    // All three questions, now with room for them.
    await expect(page.getByText("Who it affects:")).toBeVisible();
    await expect(page.getByText("If you turn it off:")).toBeVisible();

    await expect(page.getByRole("button", { name: "Stop Recovery reminders" })).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByText("Turning this back on needs a deploy")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Recovery reminder — 2 vs 6 hours" }),
    ).toBeVisible();

    await settleAnimations(page);
    await capture(page, testInfo.project.name, "switch-detail");
  });

  /** Active is intentionally quiet; planned and concluded work stay one tab away. */
  test("experiments", async ({ page }, testInfo) => {
    await open(page, "experiments");
    await expect(page.getByRole("heading", { level: 1, name: "Experiments" })).toBeVisible();

    await expect(page.getByRole("tab", { name: /Active/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Recovery reminder — 2 vs 6 hours")).toBeVisible();
    await expect(page.getByText("Recovery reminder — 10 hours vs none")).toHaveCount(0);
    await expect(page.getByText("Guide delivery rollout")).toHaveCount(0);

    await settleAnimations(page);
    await capture(page, testInfo.project.name, "experiments");
  });

  /** The approved option-A detail: one comparison table across all three arms. */
  test("experiment detail", async ({ page }, testInfo) => {
    await open(page, "experiment-detail");
    await expect(
      page.getByRole("heading", { level: 1, name: "Recovery reminder — 2 vs 6 hours" }),
    ).toBeVisible();

    const comparison = page.getByRole("table", { name: "Experiment comparison" });
    await expect(comparison).toBeVisible();
    await expect(comparison.getByRole("columnheader", { name: "2 hours" })).toBeVisible();
    await expect(comparison.getByRole("columnheader", { name: "6 hours" })).toBeVisible();
    await expect(comparison.getByRole("columnheader", { name: "No reminder" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Direct comparisons" }).getByText("2 vs 6 hours", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/Still collecting complete 48-hour results/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Safety checks" })).toBeVisible();

    await settleAnimations(page);
    await capture(page, testInfo.project.name, "experiment-detail");
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
