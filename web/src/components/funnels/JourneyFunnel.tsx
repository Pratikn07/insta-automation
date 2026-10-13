import { useState } from "react";
import type {
  FunnelStageCount,
  GuardedRate,
  GuideJourneyLeakList,
  GuideJourneyResult,
} from "@/lib/types";
import { FunnelStages } from "./FunnelStages";
import { JourneyLeakTable } from "./JourneyLeakTable";
import {
  QUIET_BUCKET_LABELS,
  QUIET_BUCKET_ORDER,
  WALL_BUCKET_LABELS,
  WALL_BUCKET_ORDER,
} from "./journeyLabels";

// The guide journey as a parent lives it: one trunk (asked → got the card → said yes) that
// forks at the follow check into "already following" and "not following yet".
//
// Counted per person, so someone who comments on seven reels is one person, and their
// untapped cards are not losses. Each lane's bars are drawn against that lane, so "43% of
// the people asked to follow did" reads as itself instead of as a sliver of everyone.
// Every leak is broken down where it happens; the counts add up to the gap exactly.

const nf = (n: number) => n.toLocaleString();

function laneStage(
  key: string,
  label: string,
  definition: string,
  count: number,
  ofPrevPct: number | null,
): FunnelStageCount {
  return { key, label, definition, count, ofEntryPct: null, ofPrevPct };
}

function HeadlineCount({ rate, label, of }: { rate: GuardedRate; label: string; of: string }) {
  return (
    <div>
      <div className="figure-lead text-funnel-mark">{nf(rate.numerator)}</div>
      <p className="mt-1 text-sm font-medium text-foreground">{label}</p>
      <p className="mt-1 max-w-[40ch] text-[13px] text-muted-foreground">
        {rate.pct === null
          ? `of the ${nf(rate.denominator)} ${of} · too few to rate`
          : `${rate.pct}% of the ${nf(rate.denominator)} ${of}`}
      </p>
    </div>
  );
}

function LeakBlock({
  label,
  total,
  buckets,
  list,
  kind,
}: {
  label: string;
  total: number;
  buckets: [string, number][];
  list: GuideJourneyLeakList | undefined;
  kind: "quiet" | "wall";
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label={label}
      className="mt-3 rounded-sm border-l-[3px] border-urgent bg-urgent/5 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        <span className="font-medium text-foreground">
          {nf(total)} {label.toLowerCase()}
        </span>
        <span className="text-muted-foreground">—</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="border-b border-current text-funnel-mark hover:opacity-80"
        >
          {open ? "hide who" : "see who"}
        </button>
      </div>
      <ul className="mt-2 grid max-w-[60ch] gap-1 text-[12.5px]">
        {buckets.map(([bucketLabel, count]) => (
          <li key={bucketLabel} className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">{bucketLabel}</span>
            <span className="tabular-nums text-foreground">{nf(count)}</span>
          </li>
        ))}
      </ul>
      {open ? (
        <div className="mt-3">
          {list ? (
            <JourneyLeakTable rows={list.rows} leak={kind} />
          ) : (
            <p className="text-[12.5px] text-muted-foreground">Loading the list…</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function RetentionRow({ rate, due }: { rate: GuardedRate; due: number }) {
  const read = rate.denominator;
  const width = rate.pct ?? 0;
  const coverage =
    due === 0
      ? "Nobody who followed in this window is 21 days past their guide yet."
      : read >= due
        ? `All ${nf(due)} people due a 21-day reading have been read.`
        : `${nf(read)} of the ${nf(due)} people due a 21-day reading have been read so far.`;
  return (
    <div className="border-t border-border/60 pt-4">
      <div className="mb-2.5 flex items-baseline justify-between gap-5">
        <span className="text-sm font-medium">Still following at 21 days</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {nf(rate.numerator)} of {nf(read)} read
          {rate.pct === null ? " · too few to rate" : ` · ${rate.pct}%`}
        </span>
      </div>
      <div
        className="relative h-2.5 overflow-hidden rounded-sm bg-[color:var(--color-funnel-track)]"
        role="img"
        aria-label={`Still following at 21 days: ${nf(rate.numerator)} of ${nf(read)} read`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-sm bg-[color:var(--color-funnel-mark)]"
          style={{ width: `${width}%` }}
        />
      </div>
      <p className="mt-2 text-[12.5px] text-muted-foreground">{coverage}</p>
    </div>
  );
}

export interface JourneyFunnelProps {
  data: GuideJourneyResult;
  neverSaidYes: GuideJourneyLeakList | undefined;
  stuckAtWall: GuideJourneyLeakList | undefined;
}

export function JourneyFunnel({ data, neverSaidYes, stuckAtWall }: JourneyFunnelProps) {
  const { lanes, leaks } = data;
  const already = lanes.alreadyFollowing;
  const notFollowing = lanes.notFollowing.people;

  const alreadyStages = [
    laneStage(
      "alreadySaidYes",
      "Said yes, already following",
      "Following when they said yes, so they skipped the follow wall.",
      already.people,
      null,
    ),
    laneStage(
      "alreadyGotGuide",
      "Got the guide",
      "Their guide was delivered. The gap is people whose delivery failed or is waiting for review.",
      already.gotGuide.numerator,
      already.gotGuide.pct,
    ),
  ];
  const growthStages = [
    laneStage(
      "wall",
      "Shown the follow wall",
      "Not following at the follow check after they said yes, so they were asked to follow first.",
      notFollowing,
      null,
    ),
    laneStage(
      "followed",
      "Followed and got the guide",
      "Followed, passed the recheck and got a guide. These are the new followers in the headline.",
      data.newFollowers.numerator,
      data.newFollowers.pct,
    ),
  ];

  return (
    <>
      <section aria-label="Headline" className="grid gap-8 border-b pb-9 sm:grid-cols-2 md:gap-14">
        <HeadlineCount
          rate={data.newFollowers}
          label="new followers"
          of="who weren't following when they said yes"
        />
        <HeadlineCount rate={data.gotGuide} label="got their guide" of="who asked" />
      </section>

      <section aria-label="The trunk" className="pt-2">
        <FunnelStages
          stages={data.stages}
          cohortSize={data.cohortSize}
          renderLoss={(stage, lost) =>
            stage.key === "saidYes" ? (
              <LeakBlock
                label="Never said yes"
                total={leaks.neverSaidYes.total}
                buckets={QUIET_BUCKET_ORDER.map((bucket) => [
                  QUIET_BUCKET_LABELS[bucket],
                  leaks.neverSaidYes.buckets[bucket],
                ])}
                list={neverSaidYes}
                kind="quiet"
              />
            ) : (
              <p className="mt-2.5 text-[12.5px] text-muted-foreground">
                {nf(lost)} never got a card
              </p>
            )
          }
        />
      </section>

      <p className="py-5 text-center text-[12.5px] text-muted-foreground">
        At the follow check after &ldquo;yes&rdquo;, everyone goes one of two ways.
      </p>

      <div className="grid gap-5 md:grid-cols-2">
        {/* min-w-0: a grid item will not shrink below its content by default, so an open
            "see who" table (620px minimum) would widen the whole page on a phone. */}
        <section aria-label="Already following" className="min-w-0 rounded-md border border-line bg-card p-4">
          <p className="label-caps mb-1">Already following · {nf(already.people)}</p>
          <FunnelStages
            stages={alreadyStages}
            cohortSize={already.people}
            renderLoss={(_stage, lost) => (
              <p className="mt-2.5 text-[12.5px] text-muted-foreground">
                {nf(lost)} said yes and haven&apos;t received it
              </p>
            )}
          />
        </section>

        <section aria-label="Not following yet" className="min-w-0 rounded-md border border-line bg-card p-4">
          <p className="label-caps mb-1">Not following yet · {nf(notFollowing)}</p>
          <FunnelStages
            stages={growthStages}
            cohortSize={notFollowing}
            renderLoss={() => (
              <LeakBlock
                label="Stuck at the wall"
                total={leaks.stuckAtWall.total}
                buckets={WALL_BUCKET_ORDER.map((bucket) => [
                  WALL_BUCKET_LABELS[bucket],
                  leaks.stuckAtWall.buckets[bucket],
                ])}
                list={stuckAtWall}
                kind="wall"
              />
            )}
          />
          <RetentionRow rate={data.retention.rate} due={data.retention.due} />
        </section>
      </div>
    </>
  );
}
