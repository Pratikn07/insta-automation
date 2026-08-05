import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AdvisorResponse } from "@/lib/types";
import { AdvisorMessage } from "./AdvisorMessage";

function response(overrides: Partial<AdvisorResponse> = {}): AdvisorResponse {
  return {
    answer: "Your reply rate is the thing to fix first.",
    recommendation: "Improve the SLEEP follow-up before adding new keywords.",
    evidence: [
      { label: "Needs reply", value: "3 threads", href: "/conversations" },
      { label: "Top keyword", value: "SLEEP — 14 triggers", href: null },
    ],
    confidence: "high",
    nextStep: "Open Conversations and clear the needs-reply queue.",
    nextStepHref: "/conversations",
    dataGaps: [],
    ...overrides,
  };
}

function render(value: AdvisorResponse): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AdvisorMessage response={value} />
    </MemoryRouter>,
  );
}

describe("AdvisorMessage", () => {
  it("renders every part of a structured answer in named sections", () => {
    const html = render(response());
    expect(html).toContain("Recommendation");
    expect(html).toContain("Why");
    expect(html).toContain("Suggested next step");
    expect(html).toContain("High confidence");
    expect(html).toContain('href="/conversations"');
    expect(html).toContain("Improve the SLEEP follow-up");
  });

  // The advisor is read-only. A send or approve control here would put an
  // unreviewed AI message one click from a real person.
  it("exposes no send, approve or settings control", () => {
    const html = render(response());
    expect(html).not.toContain("Approve &amp; Send");
    expect(html).not.toMatch(/<button/i);
    expect(html).not.toMatch(/send|approve|delete|disconnect/i);
  });

  it("renders non-navigable evidence as plain text, not a link", () => {
    const html = render(
      response({
        evidence: [{ label: "Top keyword", value: "SLEEP", href: null }],
        // Also null, so any anchor left in the markup would come from the evidence.
        nextStepHref: null,
      }),
    );
    expect(html).toContain("Top keyword");
    expect(html).not.toContain("<a ");
  });

  it("states low confidence rather than presenting the answer as settled", () => {
    const html = render(response({ confidence: "low" }));
    expect(html).toContain("Low confidence");
    expect(html).not.toContain("High confidence");
  });

  // Silently omitting a gap would make a partial answer look complete.
  it("shows what could not be measured", () => {
    const html = render(
      response({ dataGaps: ["Circle joins are not instrumented, so conversion is unknown."] }),
    );
    expect(html).toContain("Not measured");
    expect(html).toContain("Circle joins are not instrumented");
  });

  it("omits the evidence and gap sections when there is nothing to show", () => {
    const html = render(response({ evidence: [], dataGaps: [] }));
    expect(html).not.toContain("Why");
    expect(html).not.toContain("Not measured");
    // The recommendation is never optional.
    expect(html).toContain("Recommendation");
  });

  it("renders answer text literally, so a quoted DM cannot inject markup", () => {
    const html = render(
      response({ answer: 'A parent wrote "<script>alert(1)</script>" in a DM.' }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
