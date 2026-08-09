import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import {
  describeCanonicalChoice,
  partitionIntoWindows,
  reconcileWindow,
  type ReconcileCandidate,
} from "./journeyReconciliationCore.js";
import {
  applyReconciledWindow,
  inspectReconciliationPreflight,
  loadReconciliationRows,
  type ReconciliationRow,
} from "./journeyReconciliationRepository.js";

export const JOURNEY_RECONCILIATION_QUERY_VERSION = "journey-reconciliation-v2";

type RunOptions = {
  write: boolean;
  approvedManifestRunId?: string;
  resumeRunId?: string;
  sourceCutoff?: Date;
  /** Contract-only scope; the production CLI never supplies it. */
  testIgUserPrefix?: string;
  hooks?: {
    beforePosition?: (position: number) => Promise<void>;
  };
};

export type ReconciliationRunSummary = {
  runId: string;
  mode: "dry_run" | "write";
  status: "completed";
  sourceCutoff: Date;
  windows: number;
  results: Record<string, number>;
};

export class JourneyReconciliationRunError extends Error {
  constructor(
    message: string,
    readonly runId: string | null,
  ) {
    super(message);
  }
}

function groupRows(rows: ReconciliationRow[]): ReconciliationRow[][] {
  const groups = new Map<string, ReconciliationRow[]>();
  for (const row of rows) {
    const key = `${row.igUserId}\u0000${row.keywordId}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()];
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorCode(error: unknown): string {
  if (error instanceof JourneyReconciliationRunError) return error.message;
  if (error instanceof Error && /^[a-z0-9_:-]{1,160}$/i.test(error.message)) return error.message;
  return "journey_reconciliation_failed";
}

export async function runJourneyReconciliation(
  options: RunOptions,
): Promise<ReconciliationRunSummary> {
  const requestedMode = options.write ? "write" : "dry_run";
  let run = options.resumeRunId
    ? await prisma.journeyReconciliationRun.findUnique({ where: { id: options.resumeRunId } })
    : null;

  if (options.resumeRunId && !run) {
    throw new JourneyReconciliationRunError("reconciliation_run_not_found", null);
  }
  if (run && run.mode !== requestedMode) {
    throw new JourneyReconciliationRunError("reconciliation_resume_mode_mismatch", run.id);
  }
  if (run?.status === "completed") {
    throw new JourneyReconciliationRunError("reconciliation_run_already_completed", run.id);
  }
  if (run?.lastError === "manifest_input_changed") {
    throw new JourneyReconciliationRunError("reconciliation_manifest_conflict_is_terminal", run.id);
  }

  let approvedManifest = null;
  if (options.write) {
    const approvedId = run?.approvedManifestRunId ?? options.approvedManifestRunId;
    if (!approvedId) {
      throw new JourneyReconciliationRunError("approved_dry_run_required", run?.id ?? null);
    }
    approvedManifest = await prisma.journeyReconciliationRun.findFirst({
      where: { id: approvedId, mode: "dry_run", status: "completed" },
    });
    if (!approvedManifest) {
      throw new JourneyReconciliationRunError("approved_dry_run_invalid", run?.id ?? null);
    }
  }

  if (!run) {
    run = await prisma.journeyReconciliationRun.create({
      data: {
        sourceCutoff: approvedManifest?.sourceCutoff ?? options.sourceCutoff ?? new Date(),
        queryVersion: JOURNEY_RECONCILIATION_QUERY_VERSION,
        mode: requestedMode,
        status: "running",
        approvedManifestRunId: approvedManifest?.id ?? null,
      },
    });
  } else {
    run = await prisma.journeyReconciliationRun.update({
      where: { id: run.id },
      data: { status: "running", completedAt: null, lastError: null },
    });
  }

  const runId = run.id;
  try {
    let rows = await loadReconciliationRows(run.sourceCutoff);
    if (options.testIgUserPrefix) {
      rows = rows.filter((row) => row.igUserId.startsWith(options.testIgUserPrefix!));
    }

    const plans: Array<{
      first: ReconciliationRow;
      window: ReconciliationRow[];
      result: ReturnType<typeof reconcileWindow>;
      choice: string;
      preflight: Awaited<ReturnType<typeof inspectReconciliationPreflight>>;
      windowKey: string;
      inputFingerprint: string;
    }> = [];

    for (const group of groupRows(rows)) {
      for (const window of partitionIntoWindows(group)) {
        const candidates: ReconcileCandidate[] = window.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          completed: row.state === "completed",
          hasSentGate: row.hasSentGate,
          completedAt: row.completedAt,
        }));
        const result = reconcileWindow(candidates);
        const choice = describeCanonicalChoice(candidates);
        const first = window[0]!;
        const preflight = await inspectReconciliationPreflight(
          {
            igUserId: first.igUserId,
            keywordId: first.keywordId,
            windowStartedAt: result.windowStartedAt,
            windowExpiresAt: result.windowExpiresAt,
          },
          result.aliases.map((alias) => alias.id),
        );
        const identity = {
          igUserId: first.igUserId,
          keywordId: first.keywordId,
          windowStartedAt: result.windowStartedAt.toISOString(),
          windowExpiresAt: result.windowExpiresAt.toISOString(),
          conversationIds: window.map((row) => row.id).sort(),
        };
        const input = {
          queryVersion: run.queryVersion,
          sourceCutoff: run.sourceCutoff.toISOString(),
          identity,
          candidates: candidates.map((candidate) => ({
            ...candidate,
            createdAt: candidate.createdAt.toISOString(),
            completedAt: candidate.completedAt?.toISOString() ?? null,
          })),
          proposedCanonicalId: result.canonicalId,
          choice,
          preflight,
        };
        plans.push({
          first,
          window,
          result,
          choice,
          preflight,
          windowKey: hash(identity),
          inputFingerprint: hash(input),
        });
      }
    }

    for (let position = run.resumePosition; position < plans.length; position++) {
      await options.hooks?.beforePosition?.(position);
      const plan = plans[position]!;

      if (!options.write) {
        const dryResult = plan.preflight
          ? `skipped_${plan.preflight}`
          : "planned";
        await prisma.$transaction([
          prisma.journeyReconciliationWindow.create({
            data: {
              runId,
              position,
              windowKey: plan.windowKey,
              inputFingerprint: plan.inputFingerprint,
              proposedCanonicalId: plan.result.canonicalId,
              evidenceChoice: plan.choice,
              result: dryResult,
              conflictReason: plan.preflight,
            },
          }),
          prisma.journeyReconciliationRun.update({
            where: { id: runId },
            data: { resumePosition: position + 1, resumeCursor: plan.windowKey },
          }),
        ]);
        continue;
      }

      const approved = await prisma.journeyReconciliationWindow.findUnique({
        where: {
          runId_position: {
            runId: approvedManifest!.id,
            position,
          },
        },
      });
      if (
        !approved ||
        approved.windowKey !== plan.windowKey ||
        approved.inputFingerprint !== plan.inputFingerprint
      ) {
        await prisma.$transaction([
          prisma.journeyReconciliationWindow.create({
            data: {
              runId,
              position,
              windowKey: plan.windowKey,
              inputFingerprint: plan.inputFingerprint,
              proposedCanonicalId: plan.result.canonicalId,
              evidenceChoice: plan.choice,
              result: "manifest_conflict",
              conflictReason: "manifest_input_changed",
            },
          }),
          prisma.journeyReconciliationRun.update({
            where: { id: runId },
            data: { status: "failed", lastError: "manifest_input_changed" },
          }),
        ]);
        throw new JourneyReconciliationRunError("manifest_input_changed", runId);
      }

      await applyReconciledWindow(
        {
          igUserId: plan.first.igUserId,
          keywordId: plan.first.keywordId,
          canonicalId: plan.result.canonicalId,
          windowStartedAt: plan.result.windowStartedAt,
          lastTriggerAt: plan.result.lastTriggerAt,
          windowExpiresAt: plan.result.windowExpiresAt,
          completedAt: plan.result.completedAt,
          choice: plan.choice,
          aliases: plan.result.aliases.map((alias) => ({
            id: alias.id,
            state: alias.state,
            reason: alias.reason,
          })),
        },
        new Date(),
        {},
        {
          runId,
          position,
          windowKey: plan.windowKey,
          inputFingerprint: plan.inputFingerprint,
          proposedCanonicalId: plan.result.canonicalId,
          evidenceChoice: plan.choice,
        },
      );
    }

    const completed = await prisma.journeyReconciliationRun.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date(), lastError: null },
      include: { windows: { select: { result: true } } },
    });
    const results: Record<string, number> = {};
    for (const window of completed.windows) {
      results[window.result] = (results[window.result] ?? 0) + 1;
    }
    return {
      runId,
      mode: requestedMode,
      status: "completed",
      sourceCutoff: completed.sourceCutoff,
      windows: completed.windows.length,
      results,
    };
  } catch (error) {
    const code = errorCode(error);
    await prisma.journeyReconciliationRun.updateMany({
      where: { id: runId, status: "running" },
      data: { status: "failed", lastError: code },
    });
    if (error instanceof JourneyReconciliationRunError) throw error;
    throw new JourneyReconciliationRunError(code, runId);
  }
}
