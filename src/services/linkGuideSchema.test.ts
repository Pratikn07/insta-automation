import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

function block(name: string): string {
  return schema.match(new RegExp(`(?:model|enum) ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

describe("link guide schema", () => {
  it("defaults every guide to gated", () => {
    expect(block("Resource")).toMatch(
      /deliveryMode\s+GuideDeliveryMode\s+@default\(gated\)\s+@map\("delivery_mode"\)/,
    );
  });

  it("keeps the button label within Meta's 20 characters", () => {
    expect(block("Resource")).toMatch(
      /linkButtonLabel\s+String\?\s+@map\("link_button_label"\)\s+@db\.VarChar\(20\)/,
    );
  });

  it("adds link_sent as the last conversation state", () => {
    expect(block("ConversationState")).toMatch(/expired\s+link_sent\s+@@map/);
  });

  it("makes the click token unique", () => {
    expect(block("GuideLinkSend")).toMatch(/token\s+String\s+@unique\s+@db\.VarChar\(16\)/);
  });
});
