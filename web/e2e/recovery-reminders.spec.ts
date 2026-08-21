import { expect, test } from "@playwright/test";

/**
 * Browser coverage for the DM recovery destination.
 *
 * Only the HTTP boundary is mocked (see e2e/main.tsx) — the real page, the real
 * React Query cache, and the real components run, so a broken query key or a
 * mislabelled state fails here rather than in a unit test that mocked past it.
 */

async function openRecovery(page: import("@playwright/test").Page, scenario: string) {
  await page.clock.install({ time: new Date("2026-08-07T06:00:00.000Z") });
  await page.goto(`/e2e/index.html?scenario=${scenario}`);
  await expect(page.getByRole("heading", { name: "DM recovery" })).toBeVisible();
}

test.describe("timing experiment dashboard", () => {
  test("keeps summary cards, badges, and rows on one date scope", async ({ page }) => {
    await openRecovery(page, "recovery-timing-arms");

    await expect(page.getByRole("heading", { name: "2-hour reminder" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "6-hour reminder" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No reminder" })).toBeVisible();
    await expect(page.getByText(/56 followers are still collecting/)).toBeVisible();

    for (const label of ["7d", "14d", "30d", "Custom"]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }
    const allDates = page.locator('button[aria-pressed]').filter({ hasText: /^All$/ });
    await expect(allDates).toBeVisible();
    await expect(page.getByRole("button", { name: "30d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page.getByText("Showing guide requests received Jul 18 to Aug 16."),
    ).toBeVisible();

    await page.getByRole("button", { name: "7d" }).click();
    await expect(
      page.getByText("Showing guide requests received Aug 10 to Aug 16."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Scheduled: 1 people, 1 journeys" })).toBeVisible();

    await page.getByRole("button", { name: "14d" }).click();
    await expect(
      page.getByText("Showing guide requests received Aug 3 to Aug 16."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Scheduled: 1 people, 1 journeys" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Due: 1 people, 1 journeys" })).toBeVisible();
    await expect(page.getByRole("button", { name: "All: 4 people, 4 journeys" })).toBeVisible();

    await page.getByRole("button", { name: "30d" }).click();
    await expect(
      page.getByText("Showing guide requests received Jul 18 to Aug 16."),
    ).toBeVisible();

    await allDates.click();
    await expect(
      page.getByText("Showing guide requests received Jul 1 to Aug 16."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Custom" }).click();
    const calendar = page.getByRole("dialog", { name: "Choose a date range" });
    await calendar.getByRole("button", { name: "2026-08-01" }).click();
    await calendar.getByRole("button", { name: "2026-08-05" }).click();
    await expect(
      page.getByText("Showing guide requests received Aug 1 to Aug 5."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Scheduled: 0 people, 0 journeys" })).toBeVisible();
  });

  test("filters rows with user-facing timing labels", async ({ page }) => {
    await openRecovery(page, "recovery-timing-arms");
    await page.getByRole("button", { name: /^All:/ }).click();

    await page.getByRole("combobox", { name: /Timing/i }).selectOption("no_reminder");

    await expect(page.getByRole("button", { name: /@nora/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /@tanya/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "All: 1 people, 1 journeys" })).toBeVisible();
  });

  test("shows persisted details for every arm and locks the no-reminder control", async ({
    page,
  }) => {
    await openRecovery(page, "recovery-timing-arms");
    await page.getByRole("button", { name: /^All:/ }).click();

    for (const [username, label] of [
      ["tanya", "2-hour reminder"],
      ["sima", "6-hour reminder"],
    ] as const) {
      await page.getByRole("button", { name: new RegExp(`@${username}`) }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByText("Timing experiment")).toBeVisible();
      await expect(drawer.getByText(new RegExp(label))).toBeVisible();
      await drawer.getByText("Close", { exact: true }).click();
    }

    await page.getByRole("button", { name: /@nora/ }).click();
    const controlDrawer = page.getByRole("dialog");
    await expect(controlDrawer.getByText("No-reminder experiment arm")).toBeVisible();
    await expect(controlDrawer.getByText(/intentionally held back for measurement/i)).toBeVisible();
    await expect(controlDrawer.getByRole("button", { name: /send now/i })).toHaveCount(0);
    await expect(controlDrawer.getByRole("button", { name: "Cancel reminder" })).toHaveCount(0);
  });
});

test.describe("evidence language", () => {
  test("explains that recovery can automatically publish a public comment", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await expect(
      page.getByText(/Tiny Soho may automatically post one public reminder/i),
    ).toContainText("original Instagram comment");
  });

  test("a due reminder reports no confirmed read, never Unread", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /^Due:/ }).click();

    await expect(page.getByText("No confirmed read").first()).toBeVisible();
    // The claim the whole feature is built to avoid.
    await expect(page.getByText(/^Unread$/)).toHaveCount(0);
  });

  test("a future reminder is visibly Scheduled", async ({ page }) => {
    await openRecovery(page, "recovery-scheduled");
    await page.getByRole("button", { name: /^Scheduled/ }).click();

    await expect(page.getByRole("button", { name: /@sarah/ })).toContainText("Scheduled");
  });

  test("a claimed public-comment attempt is visibly Sending", async ({ page }) => {
    await openRecovery(page, "recovery-sending");
    await page.getByRole("button", { name: /^All/ }).click();

    await expect(page.getByRole("button", { name: /@sarah/ })).toContainText("Sending");
  });

  test("a definitive rejection is visibly Failed", async ({ page }) => {
    await openRecovery(page, "recovery-failed");
    await page.getByRole("button", { name: /^Attention/ }).click();

    await expect(page.getByRole("button", { name: /@sarah/ })).toContainText(
      "Failed—public reminder not posted",
    );
  });

  test("the drawer explains why a receipt may be missing", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /^Due:/ }).click();
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
    await expect(page.getByText("Sent publicly—late after worker delay")).toBeVisible();
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
    await page.getByRole("button", { name: /^Due:/ }).click();
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
    await page.getByRole("button", { name: /^Due:/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    const link = page.getByRole("dialog").getByRole("link", { name: "View post" });
    await expect(link).toHaveAttribute("href", "https://instagram.com/p/sleep");
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("offers no way to force a send", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /^Due:/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    await expect(page.getByRole("button", { name: /send now/i })).toHaveCount(0);
  });
});

test.describe("owner actions", () => {
  test("cancelling posts, confirms, and refreshes the row", async ({ page }) => {
    await openRecovery(page, "recovery-ready");
    await page.getByRole("button", { name: /^Due:/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    await page.getByRole("button", { name: "Cancel reminder" }).click();
    await expect(
      page.getByText(/cannot remove a comment that Instagram already accepted/i),
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
    await page.getByRole("button", { name: /^Due:/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    await page.getByRole("button", { name: "Cancel reminder" }).click();
    await page.getByRole("button", { name: "Keep reminder" }).click();

    // The confirmation is an alertdialog inside the Drawer; the Drawer itself
    // stays open and stays role="dialog", so this asserts the confirmation went
    // away rather than that every dialog did.
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByText("Cancelled by owner")).toHaveCount(0);
  });

  test("an uncertain send can be marked reviewed", async ({ page }) => {
    await openRecovery(page, "recovery-uncertain");
    await page.getByRole("button", { name: /Attention/ }).click();
    await page.getByRole("button", { name: /@sarah/ }).click();

    await expect(page.getByText("Outcome uncertain—check Instagram").first()).toBeVisible();

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
    await page.getByRole("button", { name: /^Due:/ }).click();
    await expect(page.getByRole("button", { name: /@sarah/ })).toBeVisible();
  });

});
