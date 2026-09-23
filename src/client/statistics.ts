import type { DailyActivity } from "./persistence.js";

export const LEGACY_ID_SPACE_SIZE = 4_773_622_240;

export function formatExploredPercent(explored: number, total = LEGACY_ID_SPACE_SIZE): string {
  if (explored <= 0 || total <= 0) return "0%";
  const percent = (explored / total) * 100;
  const decimals = Math.min(12, Math.max(2, Math.ceil(-Math.log10(percent)) + 3));
  return `${percent.toFixed(decimals)}%`;
}

// viewable/unavailable are unique-id counts from ExplorationStore, not derived from the activity counter.
// Sum may be less than explored on upgraded installs with unclassified legacy ids.
export function formatExploredBreakdown(explored: number, viewable: number, unavailable: number): string {
  const classified = viewable + unavailable;
  const breakdown = `${viewable.toLocaleString("en-US")} viewable · ${unavailable.toLocaleString("en-US")} unavailable`;
  return classified < explored ? `${breakdown} since tracking began` : breakdown;
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

export const HEATMAP_LEVELS = 4;

// Mirrors the backend's rolling-window cap (`ACTIVITY_WINDOW_DAYS` in src-tauri/src/lib.rs).
export const ACTIVITY_WINDOW_DAYS = 183;

// Buckets a day's viewed count into 0..HEATMAP_LEVELS, scaled against the busiest day in the window.
export function intensityLevel(viewed: number, maxViewed: number): number {
  if (viewed <= 0 || maxViewed <= 0) return 0;
  const ratio = viewed / maxViewed;
  return Math.min(HEATMAP_LEVELS, Math.max(1, Math.ceil(ratio * HEATMAP_LEVELS)));
}

// Avoids `new Date(string)` UTC-midnight parsing, which can shift the day in negative-offset zones.
function parseLocalDate(iso: string): Date {
  const [year = 0, month = 1, day = 1] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function formatDayLabel(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// The backend never renders days before tracking started, so the window's actual length tells us
// whether it's still growing ("Since ...") or has reached the full rolling 6-month cap.
export function heatmapRangeLabel(days: DailyActivity[]): string {
  const firstDay = days[0];
  if (!firstDay || days.length >= ACTIVITY_WINDOW_DAYS) return "Last 6 months";
  const label = parseLocalDate(firstDay.date).toLocaleDateString("en-US", { day: "numeric", month: "short" });
  return `Since ${label}`;
}

// Weekday of the window's first day, Monday-indexed, for padding leading empty cells.
export function leadingBlankCount(firstDayIso: string): number {
  const jsWeekday = parseLocalDate(firstDayIso).getDay();
  return (jsWeekday + 6) % 7;
}

export const HEATMAP_MIN_VISIBLE_CELLS = 7;

// A one- or two-day-old window renders as a lonely cell in an otherwise empty grid. Padding it
// with decorative (non-day) placeholders keeps the heatmap looking intact while it's still short;
// these are never real days and shrink to zero once tracking has enough history of its own.
export function heatmapPlaceholderCount(dayCount: number): number {
  return Math.max(0, HEATMAP_MIN_VISIBLE_CELLS - dayCount);
}

// Single line serving both the accessible name and visible hover/focus readout for a heatmap day.
export function describeDay(day: DailyActivity): string {
  const label = formatDayLabel(day.date);
  const explored = day.viewed + day.rejected;
  if (explored <= 0) return `${label} · No activity`;
  const parts = [label, `${day.viewed.toLocaleString("en-US")} viewed`, `${explored.toLocaleString("en-US")} explored`];
  if (day.rejected > 0) parts.push(`${day.rejected.toLocaleString("en-US")} unavailable`);
  return parts.join(" · ");
}

// Days run down each week column, so Up/Down step one day and Left/Right one week.
const HEATMAP_KEY_STEPS: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };

export function heatmapFocusTarget(key: string, current: number, count: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = HEATMAP_KEY_STEPS[key];
  if (step === undefined) return null;
  return Math.min(count - 1, Math.max(0, current + step));
}
