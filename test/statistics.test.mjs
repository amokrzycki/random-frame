import assert from "node:assert/strict";
import test from "node:test";
import {
  describeDay,
  formatDayLabel,
  formatExploredBreakdown,
  formatExploredPercent,
  intensityLevel,
  leadingBlankCount,
  parseLegacyStats,
} from "../dist/test-client/statistics.js";

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
