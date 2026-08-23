import { expect, test, type Locator, type Page } from "@playwright/test";

const ARTIFACTS = "../docs/qa/artifacts/2026-08-22-creator-cover-console";
const APPROVED_ALTERNATIVE_DESCRIPTION =
  "Blush TinySoho sleep guide cover with a moonlit house illustration.";

interface CapturedMutation {
  method: string;
  path: string;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
}

const nonLocalRequests = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const blocked: string[] = [];
  nonLocalRequests.set(page, blocked);
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (["localhost", "127.0.0.1", "::1"].includes(requestUrl.hostname)) {
      await route.continue();
      return;
    }
    blocked.push(`${route.request().method()} ${requestUrl.href}`);
    await route.abort("blockedbyclient");
  });
});

test.afterEach(async ({ page }) => {
  expect(nonLocalRequests.get(page) ?? []).toEqual([]);
});

async function mutationReceipt(log: Locator, count: number): Promise<CapturedMutation[]> {
  await expect
    .poll(async () => {
      const value = JSON.parse((await log.textContent()) ?? "{}") as {
        mutations?: CapturedMutation[];
      };
      return value.mutations?.length;
    })
    .toBe(count);
  return (
    JSON.parse((await log.textContent()) ?? "{}") as {
      mutations: CapturedMutation[];
    }
  ).mutations;
}

test("authors and publishes a responsive guide cover without touching messages", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/index.html?scenario=guide-cover-authoring");

  const panel = page.getByRole("region", { name: "Presentation and cover" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("heading", { level: 2, name: "Presentation & cover" }),
  ).toBeVisible();
  await expect(panel.getByRole("region", { name: "Presentation category" })).toBeVisible();
  await expect(panel.getByPlaceholder("Search categories")).toBeVisible();

  const placement = await page
    .getByText("Presentation & cover")
    .evaluate((coverHeading) => {
      const identity = document.querySelector('[placeholder="Guide name"]');
      const stepsHeading = [...document.querySelectorAll("h3")].find(
        (heading) => heading.textContent === "Steps",
      );
      return {
        followsIdentity: Boolean(
          identity &&
            identity.compareDocumentPosition(coverHeading) &
              Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        precedesSteps: Boolean(
          stepsHeading &&
            coverHeading.compareDocumentPosition(stepsHeading) &
              Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      };
    });
  expect(placement).toEqual({ followsIdentity: true, precedesSteps: true });

  const headline = panel.getByLabel("Cover headline");
  const closingLine = panel.getByLabel("Closing line");
  await expect(headline).toHaveValue("Bedtime can feel softer");
  await panel.getByText("Recipes", { exact: true }).click();
  await expect(headline).toHaveValue("Something lovely for lunch");

  await panel.getByRole("button", { name: "Suggest from guide" }).click();
  await expect(headline).toHaveValue("Bedtime can feel softer");
  const preview = panel.getByRole("img", {
    name: APPROVED_ALTERNATIVE_DESCRIPTION,
  });
  await expect(preview).toBeVisible();
  expect(
    await page.evaluate(() => document.fonts.check("600 16px 'Source Serif 4'")),
  ).toBe(true);
  expect(
    await preview.locator("text").nth(2).evaluate((text) => getComputedStyle(text).fontFamily),
  ).toContain("Source Serif 4");
  expect(
    await preview.locator("text").nth(0).evaluate((text) => getComputedStyle(text).fontFamily),
  ).toContain("Inter");
  expect(
    await preview.locator("text").nth(3).evaluate((text) => getComputedStyle(text).fontFamily),
  ).toContain("Inter");

  const artifactFolder = testInfo.project.name === "mobile" ? "mobile" : "desktop";
  await preview.screenshot({
    path: `${ARTIFACTS}/${artifactFolder}/bedtime-browser-preview.png`,
  });

  await closingLine.fill("Prepared for a gentler bedtime tonight.");
  await expect(panel.getByRole("button", { name: "Approve and publish" })).toBeDisabled();

  const mutationLog = page.getByTestId("guide-cover-mutation-log");
  const [suggestionMutation] = await mutationReceipt(mutationLog, 1);
  expect(suggestionMutation).toMatchObject({
    method: "POST",
    path: "/resources/resource-1/cover-suggestions",
    idempotencyKey: expect.any(String),
    body: {
      id: expect.any(String),
      selectedCategoryId: "10000000-0000-4000-8000-000000000002",
    },
  });
  expect(suggestionMutation?.body?.id).toBe(suggestionMutation?.idempotencyKey);

  await panel.getByRole("button", { name: "Save cover draft" }).click();
  await expect(panel.getByText("Draft saved")).toBeVisible();
  const [, saveMutation] = await mutationReceipt(mutationLog, 2);
  expect(saveMutation).toMatchObject({
    method: "POST",
    path: "/resources/resource-1/cover-versions",
    idempotencyKey: expect.any(String),
    body: {
      id: expect.any(String),
      categoryId: "10000000-0000-4000-8000-000000000001",
      suggestionId: suggestionMutation?.body?.id,
      copy: { closingLine: "Prepared for a gentler bedtime tonight." },
    },
  });
  expect(saveMutation?.body?.id).toBe(saveMutation?.idempotencyKey);
  const savedCoverId = String(saveMutation?.body?.id);

  const publish = panel.getByRole("button", { name: "Approve and publish" });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(panel.getByText("Published", { exact: true })).toBeVisible();
  const mutations = await mutationReceipt(mutationLog, 4);
  expect(mutations[2]).toEqual({
    method: "POST",
    path: `/resources/resource-1/cover-versions/${savedCoverId}/approve`,
    idempotencyKey: null,
    body: { expectedRevision: 1 },
  });
  expect(mutations[3]).toEqual({
    method: "POST",
    path: `/resources/resource-1/cover-versions/${savedCoverId}/publish`,
    idempotencyKey: null,
    body: { expectedRevision: 1 },
  });
  expect(mutations.some(({ path }) => path.includes("/messages"))).toBe(false);

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await expect(page.getByText("Steps", { exact: true })).toBeVisible();
  await expect(page.getByText("Preview", { exact: true })).toBeVisible();

  await page.screenshot({
    path: `${ARTIFACTS}/${artifactFolder}/creator-console-published.png`,
    fullPage: true,
  });
});

test("mock cover API rejects publication until the saved revision is approved", async ({
  page,
}) => {
  await page.goto("/e2e/index.html?scenario=guide-cover-authoring");

  const outcome = await page.evaluate(async () => {
    const coverId = "30000000-0000-4000-8000-000000000099";
    const create = await fetch("/api/resources/resource-1/cover-versions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": coverId,
      },
      body: JSON.stringify({
        id: coverId,
        categoryId: "10000000-0000-4000-8000-000000000001",
        suggestionId: null,
        copy: {
          headline: "Bedtime can feel softer",
          supportingLine: "A calmer bedtime, one small shift at a time.",
          closingLine: "Prepared for calmer evenings.",
          alternativeDescription:
            "Blush TinySoho sleep guide cover with a moonlit house illustration.",
        },
      }),
    });
    const publish = await fetch(
      `/api/resources/resource-1/cover-versions/${coverId}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    );
    return {
      createStatus: create.status,
      publishStatus: publish.status,
      publishBody: await publish.json(),
    };
  });

  expect(outcome).toEqual({
    createStatus: 201,
    publishStatus: 409,
    publishBody: { error: "cover_not_approved" },
  });
});
