import { afterEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn().mockResolvedValue([]);
const disconnect = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/prisma.js", () => ({
  prisma: { resourceMessage: { findMany }, $disconnect: disconnect },
}));

const auditModule = (await import("../../scripts/audit-guide-message-lengths.js")) as unknown as {
  runGuideMessageLengthAudit: (client: {
    resourceMessage: { findMany: () => Promise<never> };
    $disconnect: () => Promise<void>;
  }) => Promise<number>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guide message length audit failures", () => {
  it("emits only a stable generic indicator when its read-only query fails", async () => {
    const privateDiagnostic = "PRIVATE-PROVIDER-AND-DATABASE-DIAGNOSTIC";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await auditModule.runGuideMessageLengthAudit({
      resourceMessage: { findMany: async () => Promise.reject(new Error(privateDiagnostic)) },
      $disconnect: async () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("guide_message_length_audit_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain(privateDiagnostic);
  });
});
