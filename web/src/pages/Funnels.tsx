import { useQuery } from "@tanstack/react-query";
import { Filter, RefreshCw } from "lucide-react";
import { useState } from "react";
import { apiRead } from "@/lib/api";
import type {
  GuardedRate,
  GuideAccessMetricsResult,
  GuideCoverRates,
  GuideJourneyLeakList,
  GuideJourneyResult,
  LinkClickResult,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { Caveat } from "@/components/funnels/Caveat";
import { GuardedNumber } from "@/components/funnels/GuardedNumber";
import { JourneyFunnel } from "@/components/funnels/JourneyFunnel";
import { LinkClickPanel } from "@/components/funnels/LinkClickPanel";

// Where the guide funnel loses people.
//
// Separate from Insights on purpose: that page is scoped to reels ("which reels
// resonate with a US audience"), while a funnel's axis is the conversation
// lifecycle. Same reason the API mounts /funnels rather than adding a tab.
//
// Every number in the journey is computed server-side by summarizeGuideJourney and
// counted per person (see docs/superpowers/specs/2026-10-13-guide-journey-funnel-design.md).
// The page does no arithmetic. `npm run funnel` still reports the older per-card
// guide-follow funnel, so the CLI and this page count different units on purpose.
//
// The cover panel's shares come from runGuideAccessMetrics, also server-side.

const WINDOW_PRESETS = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The widest range the API will run (MAX_WINDOW_DAYS in src/api/funnels.routes.ts). */
const MAX_RANGE_DAYS = 365;

/** A UTC calendar day as YYYY-MM-DD. The cohort's days are UTC days. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS);
}

/** The first and last UTC day on screen, both included. */
interface DayRange {
  first: string;
  last: string;
}

/** The last `days` UTC days, `today` included. */
function presetRange(days: number, today: string): DayRange {
  return { first: addDays(today, -(days - 1)), last: today };
}

/**
 * What the API is asked for. It reads `to` as an EXCLUSIVE midnight UTC, so `to` is the
 * day after the last day shown. Sending the last day itself dropped everything since
 * 00:00 UTC — on a US evening, most of the day.
 */
function apiWindow(range: DayRange): { from: string; to: string } {
  return { from: range.first, to: addDays(range.last, 1) };
}

/** Why a picked range cannot be run, or null. Checked here so the API never has to refuse it. */
function rangeProblem(range: DayRange): string | null {
  if (!range.first || !range.last) return "Pick both a start and an end date.";
  if (range.first > range.last) return "The start date must be on or before the end date.";
  const days = (Date.parse(range.last) - Date.parse(range.first)) / DAY_MS + 1;
  if (days > MAX_RANGE_DAYS) return `Pick a range of at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

/** The UTC days the cohort covers, last day inclusive. */
function formatCohortRange(window: { from: string; to: string }): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${fmt(new Date(window.from).getTime())} – ${fmt(new Date(window.to).getTime() - 1)} UTC`;
}

export function Funnels() {
  // Today's UTC day, read once when the page opens so rendering stays pure. A page left
  // open across midnight UTC keeps its range until a preset or a date is picked again.
  const [today] = useState(() => utcDay(Date.now()));
  const [picked, setPicked] = useState<DayRange>(() => presetRange(30, today));
  const problem = rangeProblem(picked);
  const enabled = problem === null;
  const range = apiWindow(picked);
  const query = `?from=${range.from}&to=${range.to}`;
  const activePreset = WINDOW_PRESETS.find((p) => {
    const preset = presetRange(p.days, today);
    return preset.first === picked.first && preset.last === picked.last;
  })?.days;

  const journeyQ = useQuery<GuideJourneyResult>({
    queryKey: ["funnels", "guide-journey", range.from, range.to],
    enabled,
    queryFn: ({ signal }) => apiRead<GuideJourneyResult>(`/funnels/guide-journey${query}`, { signal }),
  });

  // The people behind each leak. Their own queries, so a slow list never holds back the
  // numbers above it.
  const neverSaidYesQ = useQuery<GuideJourneyLeakList>({
    queryKey: ["funnels", "guide-journey", "never-said-yes", range.from, range.to],
    enabled,
    queryFn: ({ signal }) =>
      apiRead<GuideJourneyLeakList>(`/funnels/guide-journey/drop-off/never-said-yes${query}`, { signal }),
  });
  const stuckAtWallQ = useQuery<GuideJourneyLeakList>({
    queryKey: ["funnels", "guide-journey", "stuck-at-wall", range.from, range.to],
    enabled,
    queryFn: ({ signal }) =>
      apiRead<GuideJourneyLeakList>(`/funnels/guide-journey/drop-off/stuck-at-wall${query}`, { signal }),
  });

  // Cover shares. A separate query on purpose: this endpoint aggregates the guide-access
  // event log rather than the cohort, and it must not be able to take the main funnel down.
  const coverQ = useQuery<GuideAccessMetricsResult>({
    queryKey: ["funnels", "guide-access-metrics", range.from, range.to],
    enabled,
    queryFn: ({ signal }) =>
      apiRead<GuideAccessMetricsResult>(`/funnels/guide-access-metrics${query}`, { signal }),
  });

  // Its own query, like the cover panel: the link funnel must not be able to take the
  // gated funnel down.
  const linkQ = useQuery<LinkClickResult>({
    queryKey: ["funnels", "link-click", range.from, range.to],
    enabled,
    queryFn: ({ signal }) => apiRead<LinkClickResult>(`/funnels/link-click${query}`, { signal }),
  });

  return (
    <div className="space-y-8">
      <header>
        <p className="label-caps">Funnels · Guide → follow</p>
        <h2 className="mt-2 max-w-[24ch] text-2xl font-medium leading-tight tracking-tight text-balance">
          Where the guide funnel loses people.
        </h2>

        {/* Cohort semantics, stated. Never "last 30 days": these are the SAME
            people tracked forward, not events counted inside a window, and
            reading it the other way is how the old yield tile misled. */}
        <p className="mt-4 max-w-[62ch] text-sm text-muted-foreground">
          {journeyQ.data ? (
            <>
              <span className="font-medium text-foreground">
                {journeyQ.data.cohortSize.toLocaleString()} people
              </span>{" "}
              who asked for a guide between{" "}
              <span className="font-medium text-foreground">
                {formatCohortRange(journeyQ.data.window)}
              </span>
              , each counted once however many reels they commented on, and followed forward
              however long they took.
            </>
          ) : (
            "People who asked for a guide in the window, each counted once, followed forward however long they took."
          )}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex items-center gap-2">
            {WINDOW_PRESETS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => setPicked(presetRange(p.days, today))}
                className={
                  "rounded-sm border px-3 py-1.5 text-xs transition-colors [@media(pointer:coarse)]:min-h-11 " +
                  (activePreset === p.days
                    ? "border-line bg-muted font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted")
                }
              >
                {p.label}
              </button>
            ))}
          </div>
          {/* Any range up to a year. Days are UTC days and both ends are included, which
              is how the cohort sentence above labels them. */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              From
              <input
                type="date"
                value={picked.first}
                max={picked.last || today}
                onChange={(event) => setPicked((r) => ({ ...r, first: event.target.value }))}
                className="rounded-sm border border-line bg-card px-2 py-1 text-xs text-foreground [@media(pointer:coarse)]:min-h-11"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              To
              <input
                type="date"
                value={picked.last}
                min={picked.first || undefined}
                max={today}
                onChange={(event) => setPicked((r) => ({ ...r, last: event.target.value }))}
                className="rounded-sm border border-line bg-card px-2 py-1 text-xs text-foreground [@media(pointer:coarse)]:min-h-11"
              />
            </label>
          </div>
        </div>
        {problem ? (
          <p role="alert" className="mt-3 text-[12.5px] text-caution">
            {problem}
          </p>
        ) : null}
      </header>

      {problem ? null : journeyQ.isError ? (
        <EmptyState
          icon={<Filter className="size-5" />}
          title="Couldn't load the funnel"
          description="The cohort query scans the event log over the window; a wide range can time out."
          action={
            <Button variant="outline" onClick={() => journeyQ.refetch()}>
              <RefreshCw className="size-4" /> Retry
            </Button>
          }
        />
      ) : journeyQ.isLoading || !journeyQ.data ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-72 w-full rounded-lg" />
        </div>
      ) : (
        <JourneyFunnel
          data={journeyQ.data}
          neverSaidYes={neverSaidYesQ.data}
          stuckAtWall={stuckAtWallQ.data}
        />
      )}

      {/* An invalid range runs no query, so these would sit in a skeleton forever. */}
      {problem ? null : (
        <>
          <GuideAccessHealthPanel health={coverQ.data?.health} />

          <CoverPanel
            rates={coverQ.data?.coverRates}
            isLoading={coverQ.isLoading}
            isError={coverQ.isError}
            isAbsent={coverQ.data !== undefined && coverQ.data.coverRates === undefined}
          />

          <LinkClickPanel data={linkQ.data} isLoading={linkQ.isLoading} isError={linkQ.isError} />
        </>
      )}
    </div>
  );
}

/**
 * Only what an owner can act on. `logicallyExpiredActiveTokens` is deliberately not
 * shown: tokens expire lazily (a late tap is refused at consume time) and nothing
 * sweeps their status, so the count is every unanswered opening ever sent — 12,133 on
 * 2026-10-12 and only growing. It kept this warning on permanently and buried the
 * needs-review count, which is the line that does need a person.
 */
function GuideAccessHealthPanel({
  health,
}: {
  health: GuideAccessMetricsResult["health"];
}) {
  if (!health || health.needsReview === 0) return null;

  return (
    <section aria-label="Guide access health" className="border-t-line border-t pt-8">
      <Caveat>
        <b className="font-medium">Guide requests need attention.</b>{" "}
        {health.needsReview.toLocaleString()} guide request
        {health.needsReview === 1 ? " needs" : "s need"} owner review. {" "}
        <a
          className="border-b border-current font-medium hover:opacity-80"
          href="/conversations"
        >
          Review conversations
        </a>
      </Caveat>
    </section>
  );
}

/**
 * Cover shares.
 *
 * Two groups, never merged. The follow gate sends a cover directly to a non-follower and
 * produces a send result; the delivery planner records a plan-time decision and produces no
 * send result at all. Rendering them together is what let a share of one be divided by a
 * count of the other, so the panel could read "accepted 100%" and "failed 100%" at once.
 *
 * Its own loading, error, unavailable and empty states, because the rollout ships OFF: an
 * empty panel is the normal state for every deployment until someone sets the switch, and
 * zeroes everywhere would read as a feature that is failing rather than one that has not
 * started.
 */
function CoverPanel({
  rates,
  isLoading,
  isError,
  isAbsent,
}: {
  rates: GuideCoverRates | undefined;
  isLoading: boolean;
  isError: boolean;
  isAbsent: boolean;
}) {
  if (isError) {
    return (
      <section className="border-t-line border-t pt-8">
        <SectionHead
          eyebrow="Guide cover"
          title="Cover numbers could not be loaded"
          blurb="This panel aggregates the guide-access event log separately from the cohort above, so the funnel is still accurate. Narrow the window and reload if it keeps failing."
        />
      </section>
    );
  }
  // A 200 that simply lacks the field. The console deploys ahead of the API here, so this
  // is the expected ordering — and react-query will not retry a success, so sitting in a
  // skeleton would be a permanent silent claim to still be loading.
  if (isAbsent) {
    return (
      <section className="border-t-line border-t pt-8">
        <SectionHead
          eyebrow="Guide cover"
          title="This API does not report cover numbers yet"
          blurb="The console is ahead of the server. Nothing is wrong with the funnel above; deploy the API to see cover shares."
        />
      </section>
    );
  }
  if (isLoading || !rates) {
    return (
      <section className="border-t-line border-t pt-8">
        <Skeleton className="h-40 w-full rounded-lg" />
      </section>
    );
  }

  const attempted = rates.gate.accepted.denominator;
  const considered = rates.delivery.included.denominator;
  // Decisions were taken, but every one was "not selected": the rollout fence is off or
  // selects no guide. That is the not-started state too, and "0%" would read as failing.
  const noneSelected =
    attempted === 0 &&
    considered > 0 &&
    rates.delivery.included.numerator === 0 &&
    rates.delivery.duplicateSuppressed.numerator === 0 &&
    rates.delivery.mispaired.numerator === 0;

  return (
    <section className="border-t-line border-t pt-8">
      <SectionHead
        eyebrow="Guide cover"
        title="How often the cover reaches a parent"
        blurb="Two paths, kept apart. The follow gate sends the cover straight to someone who is not following yet, so its numbers are send results. The guide delivery decides at plan time whether to prepend the cover, so its number is an inclusion share. A ratio between the two would not be a percentage of anything."
      />

      {attempted === 0 && considered === 0 ? (
        <p className="max-w-[64ch] text-sm text-muted-foreground">
          No cover has been considered yet in this window. The cover rollout ships off and
          selects nobody until a guide is allowlisted or a share is set, so this is what a
          working system looks like before the pilot starts.
        </p>
      ) : noneSelected ? (
        <p className="max-w-[64ch] text-sm text-muted-foreground">
          The cover rollout is not selecting anyone. All {considered.toLocaleString()}{" "}
          deliveries that had a cover to consider in this window went out without it, because
          the rollout is switched off or selects no guide. The guides themselves were delivered.
        </p>
      ) : (
        <>
          {rates.delivery.mispaired.numerator > 0 ? (
            <Caveat className="mb-6">
              <b className="font-medium">
                {rates.delivery.mispaired.numerator.toLocaleString()} cover
                {rates.delivery.mispaired.numerator === 1 ? "" : "s"} belonged to a different
                guide.
              </b>{" "}
              Those deliveries went out without an image, which is the safe outcome, but the
              pairing itself is wrong — a snapshot on the access attempt points at another
              guide&apos;s cover. That is a data fault to chase, not a rollout number to read.
            </Caveat>
          ) : null}

          <div className="grid gap-8 md:grid-cols-2 md:gap-14">
            <div>
              <p className="label-caps">In the follow gate</p>
              {attempted === 0 ? (
                <p className="mt-3 max-w-[40ch] text-sm text-muted-foreground">
                  The gate has not attempted a cover in this window.
                </p>
              ) : (
                <>
                  <GuardedNumber
                    className="mt-3"
                    rate={rates.gate.accepted}
                    unit="of the covers the gate tried to send"
                    size="kpi"
                  />
                  <dl className="mt-4 flex flex-col">
                    <CoverKpi label="Send uncertain" rate={rates.gate.uncertain} />
                    <CoverKpi label="Send failed" rate={rates.gate.failed} />
                  </dl>
                </>
              )}
            </div>

            <div>
              <p className="label-caps">In the guide delivery</p>
              {considered === 0 ? (
                <p className="mt-3 max-w-[40ch] text-sm text-muted-foreground">
                  No delivery has had a cover to consider in this window.
                </p>
              ) : (
                <>
                  <GuardedNumber
                    className="mt-3"
                    rate={rates.delivery.included}
                    unit="of the deliveries that had one to consider"
                    size="kpi"
                  />
                  <dl className="mt-4 flex flex-col">
                    <CoverKpi
                      label="Already seen in the gate"
                      rate={rates.delivery.duplicateSuppressed}
                    />
                    <CoverKpi label="Belonged to another guide" rate={rates.delivery.mispaired} />
                  </dl>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function CoverKpi({ label, rate }: { label: string; rate: GuardedRate }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-3 first:border-t">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="text-right">
        <GuardedNumber rate={rate} size="inline" />
      </dd>
    </div>
  );
}

function SectionHead({
  eyebrow,
  title,
  blurb,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
}) {
  return (
    <div className="mb-6">
      <p className="label-caps">{eyebrow}</p>
      <h3 className="mt-1.5 text-[15px] font-medium tracking-tight">{title}</h3>
      <p className="mt-1.5 max-w-[64ch] text-sm text-muted-foreground">{blurb}</p>
    </div>
  );
}
