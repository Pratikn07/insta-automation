export const ANALYTICS_TIME_ZONE = "America/Los_Angeles" as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const zonedFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ANALYTICS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsAt(value: Date): ZonedParts {
  if (!Number.isFinite(value.getTime())) throw new Error("invalid_analytics_instant");
  const parts = Object.fromEntries(
    zonedFormatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return parts as unknown as ZonedParts;
}

function dayEpoch(day: string): number {
  if (!isDayKey(day)) throw new Error("invalid_analytics_day");
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function toAnalyticsDayKey(value: Date): string {
  const parts = partsAt(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function shiftDayKey(day: string, byDays: number): string {
  if (!Number.isInteger(byDays)) throw new Error("invalid_analytics_day_shift");
  return new Date(dayEpoch(day) + byDays * DAY_MS).toISOString().slice(0, 10);
}

export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((dayEpoch(to) - dayEpoch(from)) / DAY_MS);
}

export function enumerateDayKeys(from: string, to: string): string[] {
  const distance = calendarDaysBetween(from, to);
  if (distance < 0) return [];
  return Array.from({ length: distance + 1 }, (_, index) => shiftDayKey(from, index));
}

function analyticsDayStart(day: string): Date {
  const targetLocalEpoch = dayEpoch(day);
  let candidateEpoch = targetLocalEpoch;

  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = partsAt(new Date(candidateEpoch));
    const representedLocalEpoch = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const correction = targetLocalEpoch - representedLocalEpoch;
    if (correction === 0) return new Date(candidateEpoch);
    candidateEpoch += correction;
  }

  throw new Error("analytics_day_boundary_unresolvable");
}

export function analyticsDayBounds(day: string): { start: Date; endExclusive: Date } {
  return {
    start: analyticsDayStart(day),
    endExclusive: analyticsDayStart(shiftDayKey(day, 1)),
  };
}

export function dayKeyToSqlDate(day: string): Date {
  return new Date(dayEpoch(day));
}

export function sqlDateToDayKey(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("invalid_sql_date");
  const day = value.toISOString().slice(0, 10);
  if (!isDayKey(day)) throw new Error("invalid_sql_date");
  return day;
}
