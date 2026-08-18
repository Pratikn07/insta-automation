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

  test("assistant", async ({ page }, testInfo) => {
    await open(page, "advisor");
    await expect(page.getByPlaceholder("What should I focus on this week?")).toBeVisible();
    await capture(page, testInfo.project.name, "assistant");
  });
});
