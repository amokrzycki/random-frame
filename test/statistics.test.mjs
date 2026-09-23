import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDayLabel,
  formatExploredBreakdown,
  formatExploredPercent,
  formatLedgerCounts,
  ledgerDateLabel,
  ledgerDays,
  localDayKey,
  parseLegacyStats,
} from "../dist/test-client/statistics.js";

test("keeps tiny explored percentages visible", () => {
  assert.equal(formatExploredPercent(0), "0%");
  assert.equal(formatExploredPercent(12_483), "< 0.001%");
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

test("formats a local calendar day label without a UTC off-by-one", () => {
  assert.equal(formatDayLabel("2026-09-20"), "Sep 20, 2026");
  assert.equal(formatDayLabel("2026-01-01"), "Jan 1, 2026");
});

test("names ledger days relative to today, adding the year only when it differs", () => {
  assert.equal(ledgerDateLabel("2026-09-23", "2026-09-23"), "Today");
  assert.equal(ledgerDateLabel("2026-09-22", "2026-09-23"), "Yesterday");
  assert.equal(ledgerDateLabel("2026-09-20", "2026-09-23"), "Sun, Sep 20");
  assert.equal(ledgerDateLabel("2025-12-31", "2026-01-02"), "Wed, Dec 31, 2025");
});

test("counts a ledger day, leaving out unavailable when there were none", () => {
  assert.equal(formatLedgerCounts(12, 3), "12 drawn · 3 unavailable");
  assert.equal(formatLedgerCounts(1_204, 0), "1,204 drawn");
  assert.equal(formatLedgerCounts(0, 7), "0 drawn · 7 unavailable");
});

test("builds ledger days newest first, skipping idle days and grouping frames by local viewedAt", () => {
  const at = (iso, hour) => new Date(`${iso}T${String(hour).padStart(2, "0")}:00:00`).getTime();
  const days = [
    { date: "2026-09-21", viewed: 2, rejected: 1 },
    { date: "2026-09-22", viewed: 0, rejected: 0 },
    { date: "2026-09-23", viewed: 1, rejected: 0 },
  ];
  const viewedAt = [at("2026-09-21", 9), at("2026-09-23", 8), at("2026-09-21", 22)];
  assert.deepEqual(ledgerDays(days, viewedAt), [
    { date: "2026-09-23", drawn: 1, unavailable: 0, frames: [1] },
    { date: "2026-09-21", drawn: 2, unavailable: 1, frames: [2, 0] },
  ]);
  assert.deepEqual(ledgerDays([], viewedAt), []);
});

// Day keys are local calendar days; the UI must render them as-is in any zone. `new Date(key)` or
// `toISOString()` would shift them by a day on one side of UTC (e.g. 2026-09-22 -> Sep 21 in UTC+2).
test("renders and derives local day keys as the same calendar day in any timezone, including around DST", (t) => {
  const originalTz = process.env.TZ;
  t.after(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });
  for (const zone of ["Europe/Warsaw", "Etc/GMT+5", "America/New_York", "Pacific/Kiritimati", "UTC"]) {
    process.env.TZ = zone;
    assert.equal(localDayKey(new Date(2026, 8, 22, 0, 30).getTime()), "2026-09-22", zone);
    assert.equal(localDayKey(new Date(2026, 8, 22, 23, 59).getTime()), "2026-09-22", zone);
    assert.equal(ledgerDateLabel("2026-09-22", "2026-09-23"), "Yesterday", zone);
    // DST transitions (Europe: Mar 29 / Oct 25, US: Mar 8 / Nov 1).
    for (const [iso, label] of [
      ["2026-03-29", "Mar 29, 2026"],
      ["2026-10-25", "Oct 25, 2026"],
      ["2026-03-08", "Mar 8, 2026"],
      ["2026-11-01", "Nov 1, 2026"],
    ]) {
      assert.equal(formatDayLabel(iso), label, `${zone}: ${iso}`);
      const [year, month, day] = iso.split("-").map(Number);
      assert.equal(localDayKey(new Date(year, month - 1, day, 12).getTime()), iso, `${zone}: ${iso} key`);
    }
    assert.equal(ledgerDateLabel("2026-10-25", "2026-10-26"), "Yesterday", `${zone}: across the DST change`);
  }
});
