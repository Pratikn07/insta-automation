import { expect, test } from "@playwright/test";

const SECOND_CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";

test("selects, approves, and advances a phase-safe campaign", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=historical-dashboard");

  await page.getByRole("combobox", { name: "Campaign" }).selectOption(SECOND_CAMPAIGN_ID);
  await expect(page.getByText(/original guide could not be delivered/i)).toBeVisible();

  await page.getByRole("button", { name: "Approve 2 people" }).click();
  await page.getByRole("button", { name: "Approve and start" }).click();
  await expect(page.getByText("Approved by owner@example.com")).toBeVisible();

  await page.getByRole("button", { name: "Advance stage" }).click();
  await page.getByRole("spinbutton", { name: "Batch size" }).fill("2");
  await page.getByRole("spinbutton", { name: "Hourly cap" }).fill("6");
  await page.getByRole("spinbutton", { name: "Daily cap" }).fill("20");
  await page.getByRole("button", { name: "Save stage" }).click();

  await expect(page.getByText("Posting up to 6 reminders an hour, 2 at a time.")).toBeVisible();
});

test("keeps a stable snapshot while loading candidate pages", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=historical-dashboard");

  await expect(page.getByRole("button", { name: "Open @sarah SLEEP" })).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();

  await expect(page.getByRole("button", { name: "Open @maria SLEEP" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open @sarah SLEEP" })).toHaveCount(1);
});

test("shows curated evidence and retires a reviewed uncertain action", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=historical-dashboard");
  await page.getByRole("button", { name: /Needs review/ }).click();
  await page.getByRole("button", { name: "Open @zoe SLEEP" }).click();

  const drawer = page.getByRole("dialog", { name: "Historical recovery evidence" });
  await expect(drawer.getByText("canonical-conversation-1")).toBeVisible();
  await expect(drawer.getByText("alias-conversation-1")).toBeVisible();
  await expect(drawer.getByText("trigger-comment-1")).toBeVisible();
  await expect(drawer.getByText("historical candidate selected")).toBeVisible();
  await expect(drawer.getByRole("link", { name: "View source post" })).toHaveAttribute(
    "href",
    "https://www.instagram.com/reel/exact-stored-source/",
  );

  await drawer.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(drawer.getByRole("button", { name: "Mark reviewed" })).toHaveCount(0);
  await expect(drawer.getByText("Reviewed", { exact: true })).toBeVisible();
});

test("switches from canonical conversations to raw alias history", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=canonical-conversations");
  await page.getByRole("button", { name: /Waiting/ }).click();

  await expect(page.getByText("Canonical · 1 alias")).toBeVisible();
  await page.getByRole("button", { name: "Raw history" }).click();

  await expect(page.getByText("Alias", { exact: true })).toBeVisible();
  await expect(page.getByText("Canonical owner canonical-conversation-1")).toBeVisible();
});
