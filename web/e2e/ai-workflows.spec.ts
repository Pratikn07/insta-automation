import { expect, test } from "@playwright/test";

/**
 * The two journeys that matter: what actually gets sent to a person, and whether
 * the advisor can trigger an action.
 *
 * Both run at desktop and 390x844, because the DM drawer is where the owner reviews
 * a reply and it is usually reviewed on a phone.
 */

test("edited DM text is the exact approved payload", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=dm-approval");

  const editor = page.getByLabel("Reply draft");
  await expect(editor).toBeVisible();

  const edited = "Yes — try the first step tonight 💛";
  await editor.fill(`  ${edited}  `);
  await page.getByRole("button", { name: "Approve & Send" }).click();

  // The bytes the component sent, not a re-render of what we hoped it sent.
  const captured = page.getByTestId("captured-request-body");
  await expect(captured).toContainText(`"workingText":"${edited}"`);
  await expect(captured).not.toContainText(`"workingText":"  ${edited}  "`);

  // The model's original suggestion must not be what went out.
  await expect(captured).not.toContainText("Bedtime battles at two");

  // After a send the draft is no longer live, so the approval control goes away and
  // the reply appears in the transcript — the owner's evidence it actually left.
  // Scoped past the captured-body <pre>, which necessarily contains the same text.
  await expect(page.getByRole("button", { name: "Approve & Send" })).toHaveCount(0);
  await expect(page.locator("div").filter({ hasText: edited }).last()).toBeVisible();
});

test("server capabilities keep sending disabled and cause no action", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=capabilities");
  await page.getByRole("button", { name: /@geri/ }).click();

  const approve = page.getByRole("button", { name: "Approve & Send" });
  await expect(approve).toBeVisible();
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute(
    "title",
    "Sending is turned off for this environment.",
  );
  await expect(page.getByTestId("captured-request-body")).toHaveText("");
});

test("server capability enables the existing owner approval action", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=capabilities-enabled");
  await page.getByRole("button", { name: /@geri/ }).click();

  await expect(page.getByRole("button", { name: "Approve & Send" })).toBeEnabled();
});

test("follow-up scheduled countdown crosses its eligibility boundary", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-05T21:59:30.000Z") });
  await page.goto("/e2e/index.html?scenario=follow-up-scheduled");

  await expect(page.getByText("Follow-up scheduled")).toBeVisible();
  await expect(page.getByText("Ready in 30s")).toBeVisible();
  await expect(page.getByText(/Eligible at/)).toBeVisible();

  await page.clock.fastForward(30_000);
  await expect(page.getByText("Ready now")).toBeVisible();
});

test("follow-up ready shows deadline and current prompt policy", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-05T22:00:00.000Z") });
  await page.goto("/e2e/index.html?scenario=follow-up-ready");

  await expect(page.getByText("Follow-up ready")).toBeVisible();
  await expect(page.getByText(/Send by/)).toBeVisible();
  await expect(page.getByText("Prompt policy v2")).toBeVisible();
  await expect(page.getByLabel("Follow-up draft")).toHaveValue(
    "How did bedtime go after trying the guide?",
  );
  await expect(page.getByRole("button", { name: "Approve & Send" })).toBeEnabled();
});

test("follow-up expiry disables an already open editor at the deadline", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-05T22:00:00.000Z") });
  await page.goto("/e2e/index.html?scenario=follow-up-expiry");

  const editor = page.getByLabel("Follow-up draft");
  await expect(editor).toBeEnabled();
  await expect(page.getByRole("button", { name: "Approve & Send" })).toBeEnabled();

  await page.clock.fastForward(30_000);
  await expect(editor).toBeDisabled();
  await expect(page.getByText("The Instagram reply window has closed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & Send" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try another" })).toHaveCount(0);
});

test("follow-up window race refreshes to the controlled expired state", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-05T22:00:00.000Z") });
  await page.goto("/e2e/index.html?scenario=follow-up-window-race");

  await page.getByRole("button", { name: "Approve & Send" }).click();
  await expect(
    page.getByText("The Instagram reply window closed before this could be sent."),
  ).toBeVisible();
  await expect(page.getByText("Follow-up expired")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & Send" })).toHaveCount(0);
});

test("follow-up cancelled by new inbound offers a fresh reply only", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-05T22:00:00.000Z") });
  await page.goto("/e2e/index.html?scenario=follow-up-cancelled");

  await expect(page.getByText("Follow-up cancelled")).toBeVisible();
  await expect(page.getByText("Actually, can I ask something else?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft a reply" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & Send" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try another" })).toHaveCount(0);
});

test("stale reply blocks approval but keeps new-draft regeneration available", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=stale-reply");

  await expect(page.getByText("New message received — generate a new draft.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & Send" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Try another" })).toBeEnabled();
});

test("the DM drawer fits a phone with its actions reachable", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=dm-approval");
  await expect(page.getByLabel("Reply draft")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  for (const name of ["Approve & Send", "Try another", "Dismiss"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
});

test("advisor recommendation is structured and has no action control", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=advisor");

  const composer = page.getByLabel("Ask Tiny SOHO");
  await expect(composer).toBeVisible();
  await composer.fill("What should I focus on this week?");
  await page.getByRole("button", { name: "Ask" }).click();

  await expect(page.getByText("Improve the SLEEP follow-up")).toBeVisible();
  await expect(page.getByText("Suggested next step")).toBeVisible();
  await expect(page.getByText("High confidence")).toBeVisible();
  // A gap that was not measured is stated, not hidden.
  await expect(page.getByText("Circle joins are not instrumented")).toBeVisible();

  // The advisor is read-only. Only "Ask" and the connection card's own controls may
  // exist — nothing that sends or approves.
  await expect(page.getByRole("button", { name: /send|approve/i })).toHaveCount(0);
});

test("the advisor blocks a second question while one is in flight", async ({ page }) => {
  await page.goto("/e2e/index.html?scenario=advisor");

  const ask = page.getByRole("button", { name: "Ask" });
  // Empty composer: nothing to send, so the button is not offered.
  await expect(ask).toBeDisabled();

  await page.getByLabel("Ask Tiny SOHO").fill("What should I focus on this week?");
  await expect(ask).toBeEnabled();
});
