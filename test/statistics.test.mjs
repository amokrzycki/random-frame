import assert from "node:assert/strict";
import test from "node:test";
import { createViewingStats } from "../dist/test-client/statistics.js";

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
