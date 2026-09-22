import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_WINDOW_DAYS,
  describeDay,
  formatDayLabel,
  formatExploredBreakdown,
  formatExploredPercent,
  HEATMAP_MIN_VISIBLE_CELLS,
  heatmapPlaceholderCount,
  heatmapRangeLabel,
  intensityLevel,
  leadingBlankCount,
  parseLegacyStats,
} from "../dist/test-client/statistics.js";

function daysOf(count) {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    viewed: 0,
    rejected: 0,
  }));
}

test("keeps tiny explored percentages visible", () => {
  assert.equal(formatExploredPercent(0), "0%");
  assert.equal(formatExploredPercent(12_483), "0.0002615%");
  assert.notEqual(formatExploredPercent(1), "0.00%");
});

test("formats the explored breakdown plainly once every explored id is classified", () => {
  assert.equal(formatExploredBreakdown(101, 49, 52), "49 viewable · 52 unavailable");
});

test("flags the breakdown as partial when legacy, unclassified ids remain", () => {
  // Upgraded installs keep unclassified legacy ids, so viewable + unavailable < explored.
  assert.equal(formatExploredBreakdown(101, 49, 50), "49 viewable · 50 unavailable since tracking began");
  assert.equal(formatExploredBreakdown(10, 0, 0), "0 viewable · 0 unavailable since tracking began");
});

test("parses valid legacy stats and rejects malformed or missing ones", () => {
  assert.deepEqual(parseLegacyStats(JSON.stringify({ day: "2026-09-19", today: 3, total: 42 })), {
    day: "2026-09-19",
    today: 3,
    total: 42,
  });
  assert.equal(parseLegacyStats(null), null);
  assert.equal(parseLegacyStats("not json"), null);
  assert.equal(parseLegacyStats(JSON.stringify({ day: "2026-09-19", today: 5, total: 3 })), null);
  assert.equal(parseLegacyStats(JSON.stringify({ today: 3, total: 42 })), null);
});

test("buckets viewed counts into heatmap intensity levels relative to the busiest day", () => {
  assert.equal(intensityLevel(0, 100), 0);
  assert.equal(intensityLevel(5, 0), 0);
  assert.equal(intensityLevel(1, 100), 1);
  assert.equal(intensityLevel(100, 100), 4);
  assert.equal(intensityLevel(50, 100), 2);
});

test("formats a local calendar day label without a UTC off-by-one", () => {
  assert.equal(formatDayLabel("2026-09-20"), "Sep 20, 2026");
  assert.equal(formatDayLabel("2026-01-01"), "Jan 1, 2026");
});

test("computes Monday-indexed leading blanks for the first heatmap column", () => {
  assert.equal(leadingBlankCount("2026-09-21"), 0); // Monday
  assert.equal(leadingBlankCount("2026-09-20"), 6); // Sunday
  assert.equal(leadingBlankCount("2026-09-17"), 3); // Thursday
});

test("describes a day's activity, distinguishing no activity from real counts", () => {
  assert.equal(describeDay({ date: "2026-09-20", viewed: 0, rejected: 0 }), "Sep 20, 2026 · No activity");
  assert.equal(
    describeDay({ date: "2026-09-20", viewed: 350, rejected: 934 }),
    "Sep 20, 2026 · 350 viewed · 1,284 explored · 934 unavailable",
  );
  assert.equal(describeDay({ date: "2026-09-20", viewed: 5, rejected: 0 }), "Sep 20, 2026 · 5 viewed · 5 explored");
});

test("labels a growing window by its actual start until it fills the 6-month cap", () => {
  assert.equal(heatmapRangeLabel([{ date: "2026-09-20", viewed: 0, rejected: 0 }]), "Since Sep 20");
  assert.equal(heatmapRangeLabel(daysOf(8)), "Since Jan 1");
  assert.equal(heatmapRangeLabel(daysOf(ACTIVITY_WINDOW_DAYS)), "Last 6 months");
  assert.equal(heatmapRangeLabel(daysOf(ACTIVITY_WINDOW_DAYS + 1)), "Last 6 months");
});

test("returns the fallback label for an empty window", () => {
  assert.equal(heatmapRangeLabel([]), "Last 6 months");
});

test("pads short windows with decorative placeholders up to the visible minimum", () => {
  assert.equal(heatmapPlaceholderCount(1), HEATMAP_MIN_VISIBLE_CELLS - 1);
  assert.equal(heatmapPlaceholderCount(2), HEATMAP_MIN_VISIBLE_CELLS - 2);
  assert.equal(heatmapPlaceholderCount(0), HEATMAP_MIN_VISIBLE_CELLS);
});

test("stops padding once real days reach or pass the visible minimum", () => {
  assert.equal(heatmapPlaceholderCount(HEATMAP_MIN_VISIBLE_CELLS), 0);
  assert.equal(heatmapPlaceholderCount(HEATMAP_MIN_VISIBLE_CELLS + 1), 0);
  assert.equal(heatmapPlaceholderCount(183), 0);
});

// Day keys are local calendar days; the UI must render them as-is in any zone. `new Date(key)` or
// `toISOString()` would shift them by a day on one side of UTC (e.g. 2026-09-22 -> Sep 21 in UTC+2).
test("renders local day keys as the same calendar day in any timezone, including around DST", (t) => {
  const originalTz = process.env.TZ;
  t.after(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });
  for (const zone of ["Europe/Warsaw", "Etc/GMT+5", "America/New_York", "Pacific/Kiritimati", "UTC"]) {
    process.env.TZ = zone;
    // First day of use and today are the same day: the window starts there, nothing before it.
    const firstDay = [{ date: "2026-09-22", viewed: 3, rejected: 1 }];
    assert.equal(heatmapRangeLabel(firstDay), "Since Sep 22", zone);
    assert.equal(describeDay(firstDay[0]), "Sep 22, 2026 · 3 viewed · 4 explored · 1 unavailable", zone);
    assert.equal(leadingBlankCount("2026-09-22"), 1, `${zone}: Tuesday`);
    // DST transitions (Europe: Mar 29 / Oct 25, US: Mar 8 / Nov 1).
    for (const [iso, label, blanks] of [
      ["2026-03-29", "Mar 29, 2026", 6],
      ["2026-10-25", "Oct 25, 2026", 6],
      ["2026-03-08", "Mar 8, 2026", 6],
      ["2026-11-01", "Nov 1, 2026", 6],
      ["2026-10-26", "Oct 26, 2026", 0],
    ]) {
      assert.equal(formatDayLabel(iso), label, `${zone}: ${iso}`);
      assert.equal(leadingBlankCount(iso), blanks, `${zone}: ${iso} weekday`);
    }
  }
});
