import { expect, test } from "@playwright/test";

const ARTIFACTS = "../docs/qa/artifacts/2026-08-22-creator-cover-console";
const APPROVED_ALTERNATIVE_DESCRIPTION =
  "Blush TinySoho sleep guide cover with a moonlit house illustration.";

function expectedMutationLog(paths: string[]) {
  return JSON.stringify({ mutations: paths });
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

  const artifactFolder = testInfo.project.name === "mobile" ? "mobile" : "desktop";
  await preview.screenshot({
    path: `${ARTIFACTS}/${artifactFolder}/bedtime-browser-preview.png`,
  });

  await closingLine.fill("Prepared for a gentler bedtime tonight.");
  await expect(panel.getByRole("button", { name: "Approve and publish" })).toBeDisabled();

  const mutationLog = page.getByTestId("guide-cover-mutation-log");
  await expect(mutationLog).toHaveText(
    expectedMutationLog(["POST /resources/resource-1/cover-suggestions"]),
  );

  await panel.getByRole("button", { name: "Save cover draft" }).click();
  await expect(panel.getByText("Draft saved")).toBeVisible();
  await expect(mutationLog).toHaveText(
    expectedMutationLog([
      "POST /resources/resource-1/cover-suggestions",
      "POST /resources/resource-1/cover-versions",
    ]),
  );

  const publish = panel.getByRole("button", { name: "Approve and publish" });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(panel.getByText("Published", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const value = JSON.parse((await mutationLog.textContent()) ?? "{}") as {
        mutations?: string[];
      };
      return value.mutations?.length;
    })
    .toBe(4);
  const mutationPaths = (
    JSON.parse((await mutationLog.textContent()) ?? "{}") as { mutations: string[] }
  ).mutations;
  expect(mutationPaths.slice(0, 2)).toEqual([
    "POST /resources/resource-1/cover-suggestions",
    "POST /resources/resource-1/cover-versions",
  ]);
  expect(mutationPaths[2]).toMatch(
    /^POST \/resources\/resource-1\/cover-versions\/[0-9a-f-]+\/approve$/u,
  );
  expect(mutationPaths[3]).toBe(mutationPaths[2]?.replace(/\/approve$/u, "/publish"));
  expect(mutationPaths.some((path) => path.includes("/messages"))).toBe(false);

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
