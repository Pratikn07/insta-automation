// Month-grid generation for the range calendar. Pure and separately testable,
// so the component stays a renderer — the same split as chartGeometry/DailyAddsChart.
//
// Like dateRange.ts, everything here is an abstract day key. Months are "2026-08".
// All parsing goes through UTC: `new Date("2026-08")` in a negative-offset zone
// resolves to July 31 locally, which would render the wrong month entirely.

export interface DayCell {
  day: string; // "2026-08-01"
  dayOfMonth: number;
}

export interface MonthGrid {
  month: string; // "2026-08"
  // Weeks of exactly 7, Sunday-first. Leading/trailing slots are null rather
  // than neighbouring-month days: showing real adjacent dates in a range picker
  // invites clicking a day that belongs to a month you aren't looking at.
  weeks: Array<Array<DayCell | null>>;
}

const DAYS_IN_WEEK = 7;

export const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"] as const;

export function shiftMonth(month: string, byMonths: number): string {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1 + byMonths;
  const shifted = new Date(Date.UTC(year, monthIndex, 1));
  return shifted.toISOString().slice(0, 7);
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

export function buildMonthGrid(month: string): MonthGrid {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  // Day 0 of the NEXT month is the last day of this one — avoids a leap-year table.
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  const cells: Array<DayCell | null> = Array.from({ length: firstWeekday }, () => null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: `${month}-${String(d).padStart(2, "0")}`, dayOfMonth: d });
  }
  while (cells.length % DAYS_IN_WEEK !== 0) cells.push(null);

  const weeks: Array<Array<DayCell | null>> = [];
  for (let i = 0; i < cells.length; i += DAYS_IN_WEEK) {
    weeks.push(cells.slice(i, i + DAYS_IN_WEEK));
  }
  return { month, weeks };
}
