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
