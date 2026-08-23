import { describe, expect, it } from "vitest";

import {
  classifyLifecycleReconciliation,
  lifecyclePendingLabel,
  nextLifecycleMutation,
  type PendingLifecycleAttempt,
} from "./guideCoverLifecycle";
import type { ResourceCoverVersion, ResourcePresentationResponse } from "./types";

function cover(status: ResourceCoverVersion["status"], revision = 1): ResourceCoverVersion {
  return {
    id: "cover-1",
    resourceId: "resource-1",
    revision,
    status,
    renderStatus: "not_rendered",
    categoryId: "category-1",
    editionNumber: null,
    templateKey: "template",
    paletteKey: "palette",
    illustrationKey: "illustration",
    kicker: "A TINY WIN",
    collectionLabel: "SLEEP",
    headline: "A headline",
    supportingLine: "A supporting line",
    closingLine: "A closing line",
    alternativeDescription: "A cover description",
    suggestionId: null,
    contentHash: null,
    dmStoragePath: null,
    genericStoragePath: null,
    renderErrorCode: null,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:00:00.000Z",
  };
}

function presentation(
  candidate: ResourceCoverVersion | null,
): ResourcePresentationResponse {
  return { presentation: null, coverVersions: candidate ? [candidate] : [] };
}

describe("guide cover lifecycle decisions", () => {
  const approval: PendingLifecycleAttempt = {
    stage: "approval",
    coverId: "cover-1",
    expectedRevision: 1,
  };

  it("selects approval before publication and publication for an approved draft", () => {
    expect(nextLifecycleMutation("draft")).toBe("approval");
    expect(nextLifecycleMutation("approved")).toBe("publication");
  });

  it("only accepts canonical state for the exact pending cover revision", () => {
    expect(classifyLifecycleReconciliation(presentation(cover("approved")), approval)).toBe(
      "approved",
    );
    expect(classifyLifecycleReconciliation(presentation(cover("published")), approval)).toBe(
      "published",
    );
    expect(classifyLifecycleReconciliation(presentation(cover("approved", 2)), approval)).toBe(
      "unresolved",
    );
    expect(classifyLifecycleReconciliation(presentation(null), approval)).toBe("unresolved");
  });

  it("provides an explicit uncertain status for each pending stage", () => {
    expect(lifecyclePendingLabel(approval)).toBe("Confirming approval");
    expect(
      lifecyclePendingLabel({ ...approval, stage: "publication" }),
    ).toBe("Confirming publication");
  });
});
