import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Stats } from "@/lib/types";
import { AutomationHealthStrip } from "./AutomationHealthStrip";

const stats: Stats = {
  activeKeywords: 8,
  totalKeywords: 10,
  dmsSentToday: 16,
  conversationsAwaiting: 5,
  completedToday: 12,
  lastError: null,
  gateQueuePending: 2,
  gateQueueExhausted: 0,
};

describe("AutomationHealthStrip", () => {
  it("shows the delivery loop counters", () => {
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={stats} isLoading={false} />,
    );

    expect(html).toContain("Automation health");
    expect(html).toContain("12");
    expect(html).toContain("Sequences today");
    expect(html).toContain("5");
    expect(html).toContain("Awaiting reply");
    expect(html).toContain("2");
    expect(html).toContain("Retries queued");
  });

  it("degrades to a message when stats are unavailable", () => {
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={undefined} isLoading={false} />,
    );
    expect(html).toContain("temporarily unavailable");
  });
});

describe("AutomationHealthStrip token alarm", () => {
  const withToken = (
    status: "healthy" | "warning" | "critical" | "expired",
    daysUntilExpiry: number,
  ): Stats => ({
    ...stats,
    tokenHealth: {
      status,
      daysUntilExpiry,
      expiresAt: "2026-09-25T03:00:00.000Z",
      lastRefreshedAt: "2026-07-27T03:00:00.000Z",
    },
  });

  it("stays silent while the token is healthy", () => {
    // The refresh worker should hold this state forever; a permanent "token is
    // fine" banner would just be noise nobody reads.
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={withToken("healthy", 59)} isLoading={false} />,
    );
    expect(html).not.toContain("Instagram token");
  });

  it("warns with the day count once the token is inside the warning band", () => {
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={withToken("warning", 12)} isLoading={false} />,
    );
    expect(html).toContain("Instagram token");
    expect(html).toContain("12 days");
  });

  it("names the fix rather than just reporting the problem", () => {
    // Whoever sees this needs to know it is a Meta App Dashboard re-mint, not
    // something they can fix in this app.
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={withToken("critical", 3)} isLoading={false} />,
    );
    expect(html).toContain("Meta App Dashboard");
  });

  it("says expired, not '0 days left', once the deadline has passed", () => {
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={withToken("expired", 0)} isLoading={false} />,
    );
    expect(html).toContain("expired");
    expect(html).not.toContain("0 days");
  });

  it("uses the singular for a single day", () => {
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={withToken("critical", 1)} isLoading={false} />,
    );
    expect(html).toContain("1 day");
    expect(html).not.toContain("1 days");
  });

  it("stays silent when the backend omits token health entirely", () => {
    // Older backend, or the row not yet seeded — absence must not render a
    // scary empty warning.
    const html = renderToStaticMarkup(
      <AutomationHealthStrip stats={stats} isLoading={false} />,
    );
    expect(html).not.toContain("Instagram token");
  });
});
