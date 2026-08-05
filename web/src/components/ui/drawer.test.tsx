import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Drawer } from "./drawer";

function renderDrawer(modal?: boolean): string {
  return renderToStaticMarkup(
    <Drawer
      open
      onClose={() => undefined}
      modal={modal}
      title="August 5, 2026"
      description="Feed-post follow attribution"
    >
      Drawer content
    </Drawer>,
  );
}

describe("Drawer accessibility", () => {
  it("programmatically names the dialog and makes it focusable on open", () => {
    const html = renderDrawer();
    const titleId = html.match(/<h2 id="([^"]+)"/)?.[1];
    const descriptionId = html.match(/<p id="([^"]+)"[^>]*>Feed-post follow attribution/)?.[1];

    expect(titleId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${titleId}"`);
    expect(html).toContain(`aria-describedby="${descriptionId}"`);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-modal="true"');
  });

  it("keeps a non-modal dialog named without claiming modal behavior", () => {
    const html = renderDrawer(false);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("aria-labelledby=");
    expect(html).not.toContain('aria-modal="true"');
  });
});
