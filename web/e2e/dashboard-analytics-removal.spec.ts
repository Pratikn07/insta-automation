import { expect, test, type Page } from "@playwright/test";

async function navigate(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("link", { name, exact: true }).filter({ visible: true }).click();
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.describe("dashboard removal", () => {
  test("Home keeps operational evidence and navigation without audience reporting", async ({ page }, testInfo) => {
    await page.goto("/e2e/index.html?scenario=dashboard-removal");
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(page.getByText("System pulse", { exact: true })).toBeVisible();
    await expect(page.getByText("Gate DM sent to Replied DONE", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "A keyword didn't attach to your new post", exact: true })).toBeVisible();
    await expect(page.getByText("Total followers", { exact: true })).toHaveCount(0);
    await expect(page.getByText("US followers this week", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Where are your followers coming from/)).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: `../docs/qa/artifacts/2026-10-04-dashboard-analytics-removal/${testInfo.project.name}/home-shell.png`, fullPage: true });

    if (testInfo.project.name === "mobile") {
      await page.getByText("System pulse", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: "../docs/qa/artifacts/2026-10-04-dashboard-analytics-removal/mobile/home-system-pulse.png" });
    }
    await navigate(page, "Funnels");
    await expect(page.getByText(/Funnels · Guide/)).toBeVisible();
    await noOverflow(page);
    await navigate(page, "Content");
    await expect(page.getByRole("heading", { name: "Content", exact: true })).toBeVisible();
    await navigate(page, "Experiments");
    await expect(page.getByRole("heading", { name: "Experiments", exact: true })).toBeVisible();
    await navigate(page, "Activity");
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await navigate(page, "Historical recovery");
    await expect(page.getByRole("heading", { name: "Historical recovery", exact: true })).toBeVisible();
    const paths = await page.evaluate(() => (window as unknown as { __dashboardReadPaths: string[] }).__dashboardReadPaths);
    expect(paths).toContain("/stats");
    expect(paths).toContain("/funnels/guide-follow");
    expect(paths.some(path => path.includes("follower-daily-adds") || path.includes("feed-follow-attribution"))).toBe(false);
  });

  test("Insights retains analysis, conversion and Recipe without duplicate metrics", async ({ page }, testInfo) => {
    await page.goto("/e2e/index.html?scenario=dashboard-removal");
    await navigate(page, "Insights");
    await expect(page.getByRole("heading", { name: "Insights", exact: true })).toBeVisible();
    await expect(page.getByText("Audience geography (account-wide)")).toHaveCount(0);
    await expect(page.getByText("Which reels should I repeat?")).toHaveCount(0);
    await page.getByRole("button", { name: /Quiet time basket that actually works/ }).click();
    await expect(page.getByText("What it converted", { exact: true })).toBeVisible();
    await expect(page.getByText("Why it fits a US audience", { exact: true })).toBeVisible();
    await expect(page.getByText("How it performed", { exact: true })).toHaveCount(0);
    const dialog = page.getByRole("dialog");
    await expect.poll(() => dialog.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= -1 && Math.abs(bounds.right - window.innerWidth) < 1;
    })).toBe(true);
    await noOverflow(page);
    await page.screenshot({ path: `../docs/qa/artifacts/2026-10-04-dashboard-analytics-removal/${testInfo.project.name}/insights-detail.png`, fullPage: true });
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Recipe", exact: true }).click();
    await expect(page.getByText("Show everyday breakfast routines", { exact: true })).toBeVisible();
    await expect(page.getByText("Gate audience by reel (keyword-commenters)")).toBeVisible();
    await expect(page.getByText("Median reach", { exact: true })).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: `../docs/qa/artifacts/2026-10-04-dashboard-analytics-removal/${testInfo.project.name}/insights-recipe.png`, fullPage: true });
    await page.getByRole("button", { name: "Experiments", exact: true }).click();
    await expect(page.getByText("Recommended next test", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /New experiment/ })).toBeVisible();
    await expect(page.getByText("Reached-US% over time", { exact: true })).toHaveCount(0);
    await noOverflow(page);
    const paths = await page.evaluate(() => (window as unknown as { __dashboardReadPaths: string[] }).__dashboardReadPaths);
    expect(paths).toContain("/insights/recipe");
    expect(paths.some(path => ["/insights/geo", "/insights/us-reach-trend", "/insights/geo-window-trend"].includes(path))).toBe(false);
  });
});
