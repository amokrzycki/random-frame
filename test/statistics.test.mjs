import assert from "node:assert/strict";
import test from "node:test";
import { createViewingStats, formatExploredPercent } from "../dist/test-client/statistics.js";

test("keeps statistics in memory when storage access throws", () => {
  const viewingStats = createViewingStats(() => {
    throw new Error("Storage unavailable");
  });

  viewingStats.recordView();

  assert.deepEqual(viewingStats.current(), {
    day: new Date().toLocaleDateString("en-CA"),
    today: 1,
    total: 1,
  });
});

test("keeps tiny explored percentages visible", () => {
  assert.equal(formatExploredPercent(0), "0%");
  assert.equal(formatExploredPercent(12_483), "0.0002615%");
  assert.notEqual(formatExploredPercent(1), "0.00%");
});
