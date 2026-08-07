import { expect, test } from "@playwright/test";

/**
 * Browser coverage for the DM recovery lens.
 *
 * Only the HTTP boundary is mocked (see e2e/main.tsx) — the real page, the real
 * React Query cache, and the real components run, so a broken query key or a
 * mislabelled state fails here rather than in a unit test that mocked past it.
 */

async function openRecovery(page: import("@playwright/test").Page, scenario: string) {
  await page.goto(`/e2e/index.html?scenario=${scenario}`);
  await page.getByRole("button", { name: "DM recovery" }).click();
}

test.describe("evidence language", () => {
  test("a ready reminder reports no confirmed read, never Unread", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /Ready/ }).click();

    await expect(page.getByText("No confirmed read").first()).toBeVisible();
    // The claim the whole feature is built to avoid.
    await expect(page.getByText(/^Unread$/)).toHaveCount(0);
  });

  test("the drawer explains why a receipt may be missing", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /Ready/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    await expect(
      page.getByText(/It may be unread, in Requests or Hidden Requests/),
    ).toBeVisible();
    await expect(page.getByText("No read confirmation received")).toBeVisible();
  });

  test("a seen reminder is suppressed rather than sent", async ({ page }) => {
    await openRecovery(page, "recovery-seen");
    await page.getByRole("button", { name: /Suppressed/ }).click();
    await expect(page.getByText("Seen—reminder not needed")).toBeVisible();
  });

  test("a reply suppresses the reminder", async ({ page }) => {
    await openRecovery(page, "recovery-replied");
    await page.getByRole("button", { name: /Suppressed/ }).click();
    await expect(page.getByText("Replied—reminder not needed")).toBeVisible();
  });

  test("a reminder posted long after eligibility is marked late", async ({ page }) => {
    await openRecovery(page, "recovery-sent-late");
    await page.getByRole("button", { name: /^Sent/ }).click();
    await expect(page.getByText("Reminder sent late after worker delay")).toBeVisible();
  });

  test("a withheld control row says so explicitly", async ({ page }) => {
    await openRecovery(page, "recovery-control");
    await page.getByRole("button", { name: /Control/ }).click();
    await expect(
      page.getByText("Control group—reminder intentionally withheld"),
    ).toBeVisible();
  });

  test("a settings rejection takes trigger-specific copy", async ({ page }) => {
    await openRecovery(page, "recovery-settings");
    await page.getByRole("button", { name: /Ready/ }).click();
    await expect(page.getByText("Settings blocked")).toBeVisible();
  });

  test("an uncorrelated send appears as tracking unavailable", async ({ page }) => {
    await openRecovery(page, "recovery-tracking");
    await page.getByRole("button", { name: /Attention/ }).click();
    await expect(page.getByText("Tracking unavailable")).toBeVisible();
  });

  test("one person with two keywords sends once and suppresses the rest", async ({ page }) => {
    await openRecovery(page, "recovery-cooldown");
    await page.getByRole("button", { name: /Suppressed/ }).click();
    await expect(page.getByText("Another reminder was recently sent")).toBeVisible();
  });
});

test.describe("the drawer", () => {
  test("orders the story from comment to outcome", async ({ page }) => {
    await openRecovery(page, "recovery-seen");
    await page.getByRole("button", { name: /Suppressed/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    const comment = page.getByText(/“sleep”/);
    const accepted = page.getByText("Gate DM accepted");
    const seen = page.getByText("Seen", { exact: true });
    await expect(comment).toBeVisible();

    const [c, a, s] = await Promise.all([
      comment.boundingBox(),
      accepted.boundingBox(),
      seen.boundingBox(),
    ]);
    expect(c!.y).toBeLessThan(a!.y);
    expect(a!.y).toBeLessThan(s!.y);
  });

  test("links to the original post in a new tab", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /Ready/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    const link = page.getByRole("link", { name: "View post" });
    await expect(link).toHaveAttribute("href", "https://instagram.com/p/sleep");
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("offers no way to force a send", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /Ready/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    await expect(page.getByRole("button", { name: /send now/i })).toHaveCount(0);
  });
});

test.describe("owner actions", () => {
  test("cancelling posts, confirms, and refreshes the row", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /Ready/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    await page.getByRole("button", { name: "Cancel reminder" }).click();
    await expect(
      page.getByText(/cannot remove a comment that has already been posted/i),
    ).toBeVisible();

    await page.getByRole("button", { name: "Yes, cancel it" }).click();

    // The harness stubs window.fetch, so there is no wire request to observe.
    // Asserting the rendered outcome proves more anyway: the POST reached the
    // handler, the handler changed state, the cache was invalidated, and the
    // list re-read the server's answer rather than patching its own.
    await expect(page.getByText("Cancelled by owner").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel reminder" })).toHaveCount(0);
  });

  test("dismissing the dialog leaves the reminder alone", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /Ready/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    await page.getByRole("button", { name: "Cancel reminder" }).click();
    await page.getByRole("button", { name: "Keep reminder" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Cancelled by owner")).toHaveCount(0);
  });

  test("an uncertain send can be marked reviewed", async ({ page }) => {
    await openRecovery(page, "recovery-uncertain");
    await page.getByRole("button", { name: /Attention/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    await expect(page.getByText("Send outcome uncertain—check Instagram").first()).toBeVisible();

    await page.getByRole("button", { name: "Mark reviewed" }).click();

    // Once reviewed the control retires itself, which is only true if the POST
    // landed and the refetched row carries reviewedAt.
    await expect(page.getByRole("button", { name: "Mark reviewed" })).toHaveCount(0);
  });
});

test.describe("health and the rest of the page", () => {
  test("an open circuit reassures rather than alarms, and keeps the rows", async ({ page }) => {
    await openRecovery(page, "recovery-circuit");

    await expect(
      page.getByText(
        "Public recovery is paused. Pending reminders are safe and will be re-evaluated after the issue is resolved.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/auth_or_permission/)).toBeVisible();
    await page.getByRole("button", { name: /Ready/ }).click();
    await expect(page.getByRole("button", { name: /@sarah/ })).toBeVisible();
  });

  test("the legacy lenses still work after visiting recovery", async ({ page }) => {
    await page.goto("/e2e/index.html?scenario=recovery-ready");
    await page.getByRole("button", { name: "DM recovery" }).click();
    await page.getByRole("button", { name: /Ready/ }).click();

    await page.getByRole("button", { name: "Needs reply" }).click();
    await expect(page.getByRole("button", { name: "DM recovery" })).toBeVisible();

    await page.getByRole("button", { name: "DMs" }).click();
    await expect(page.getByRole("button", { name: "Needs reply" })).toBeVisible();
  });

  test("an expired journey no longer claims the person never replied", async ({ page }) => {
    await page.goto("/e2e/index.html?scenario=recovery-ready");
    await expect(page.getByRole("button", { name: /No confirmed reply/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^No reply/ })).toHaveCount(0);
  });
});
