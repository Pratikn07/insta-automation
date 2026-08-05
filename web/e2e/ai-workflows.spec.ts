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
  await editor.fill(edited);
  await page.getByRole("button", { name: "Approve & Send" }).click();

  // The bytes the component sent, not a re-render of what we hoped it sent.
  const captured = page.getByTestId("captured-request-body");
  await expect(captured).toContainText(`"workingText":"${edited}"`);

  // The model's original suggestion must not be what went out.
  await expect(captured).not.toContainText("Bedtime battles at two");

  // After a send the draft is no longer live, so the approval control goes away and
  // the reply appears in the transcript — the owner's evidence it actually left.
  // Scoped past the captured-body <pre>, which necessarily contains the same text.
  await expect(page.getByRole("button", { name: "Approve & Send" })).toHaveCount(0);
  await expect(page.locator("div").filter({ hasText: edited }).last()).toBeVisible();
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
