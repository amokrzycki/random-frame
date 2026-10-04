import type { DailyActivity, FrameView, HistoryItem } from "./persistence.js";

export function formatExploredBreakdown(
  explored: number,
  viewable: number,
  unavailable: number,
  unclassified: number,
): string {
  if (
    [explored, viewable, unavailable, unclassified].some((count) => !Number.isSafeInteger(count) || count < 0) ||
    viewable + unavailable + unclassified !== explored
  )
    throw new Error("Inconsistent exploration counts");
  const breakdown = `${viewable.toLocaleString("en-US")} drawn · ${unavailable.toLocaleString("en-US")} unavailable`;
  return unclassified ? `${breakdown} · ${unclassified.toLocaleString("en-US")} unclassified` : breakdown;
}

export const LEGACY_STATS_STORAGE_KEY = "random-frame-viewing-stats";

export interface LegacyStats {
  day: string;
  today: number;
  total: number;
}

// Reads the legacy client-side counter for one-time hand-off to the backend; malformed input yields null.
export function parseLegacyStats(raw: string | null): LegacyStats | null {
  try {
    const stored: unknown = JSON.parse(raw ?? "");
    if (
      typeof stored === "object" &&
      stored !== null &&
      "day" in stored &&
      "today" in stored &&
      "total" in stored &&
      typeof stored.day === "string" &&
      typeof stored.today === "number" &&
      Number.isInteger(stored.today) &&
      stored.today >= 0 &&
      typeof stored.total === "number" &&
      Number.isInteger(stored.total) &&
      stored.total >= stored.today
    )
      return { day: stored.day, today: stored.today, total: stored.total };
  } catch {
    // No usable legacy statistics to migrate
  }
  return null;
}

// Avoids `new Date(string)` UTC-midnight parsing, which can shift the day in negative-offset zones.
function parseLocalDate(iso: string): Date {
  const [year = 0, month = 1, day = 1] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function formatDayLabel(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// The same `YYYY-MM-DD` local calendar key the backend buckets activity under.
export function localDayKey(millis: number): string {
  const date = new Date(millis);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "Today", "Yesterday", then the weekday and date; the year only once it differs from today's.
export function ledgerDateLabel(iso: string, todayIso: string): string {
  const date = parseLocalDate(iso);
  const today = parseLocalDate(todayIso);
  const daysAgo = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function formatLedgerCounts(drawn: number, unavailable: number): string {
  const counts = `${drawn.toLocaleString("en-US")} drawn`;
  return unavailable ? `${counts} · ${unavailable.toLocaleString("en-US")} unavailable` : counts;
}

export const LEDGER_PAGE_DAYS = 14;
export const LEDGER_STRIP_MAX = 6;

export interface LedgerDay {
  date: string;
  drawn: number;
  unavailable: number;
  // History positions first shown that day, newest first.
  frames: number[];
}

// One entry per day with any activity, newest first. Frames join the day of their local `viewedAt`.
export function ledgerDays(
  days: readonly DailyActivity[],
  viewedAt: readonly (number | null)[],
  history: readonly HistoryItem[] = [],
  sourceViews?: readonly FrameView[],
): LedgerDay[] {
  const frames = new Map<string, number[]>();
  const newestFirst = viewedAt
    .flatMap((millis, index) => (millis === null ? [] : [{ millis, index }]))
    .sort((a, b) => b.millis - a.millis || b.index - a.index);
  if (sourceViews) {
    const positions = new Map(history.map((item, index) => [`${item.source}\0${item.id}`, index]));
    for (const view of [...sourceViews].sort((a, b) => b.atMs - a.atMs)) {
      const index = positions.get(`${view.source}\0${view.id}`);
      if (index === undefined) continue;
      const day = frames.get(view.day);
      if (day) day.push(index);
      else frames.set(view.day, [index]);
    }
  } else {
    for (const { millis, index } of newestFirst) {
      const key = localDayKey(millis);
      const day = frames.get(key);
      if (day) day.push(index);
      else frames.set(key, [index]);
    }
  }
  return days
    .filter((day) => day.viewed + day.rejected > 0)
    .map((day) => ({
      date: day.date,
      drawn: day.viewed,
      unavailable: day.rejected,
      frames: frames.get(day.date) ?? [],
    }))
    .reverse();
}

// Consecutive days with a draw ending today, or ending yesterday while today has none yet.
// `days` is contiguous and oldest first, so the streak is capped by the backend's activity window.
export function drawStreak(days: readonly DailyActivity[]): number {
  const active = days.map((day) => day.viewed + day.rejected > 0);
  if (!active.at(-1)) active.pop();
  return active.length - 1 - active.lastIndexOf(false);
}
