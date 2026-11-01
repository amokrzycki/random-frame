import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("rapid Show earlier days activations serialize and never duplicate a day", async () => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  const days = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    viewed: 1,
    rejected: 0,
  }));
  globalThis.window = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {
      invoke: (command) => {
        if (command === "list_thumbnail_cache") return Promise.resolve([]);
        if (command === "read_thumbnail_cache") return Promise.resolve(null);
        if (command === "get_exploration_stats")
          return Promise.resolve({ explored: 30, viewable: 30, unavailable: 0, unclassified: 0 });
        if (command === "get_viewing_activity")
          return Promise.resolve({ viewedTotal: 30, days, localViewTimes: [], frameViews: [] });
        return Promise.resolve(null);
      },
    },
  });
  const { elements: e } = await import("../dist/test-client/elements.js");
  const { bindStatsDialogEvents } = await import("../dist/test-client/stats-dialog.js");
  bindStatsDialogEvents();
  e.statsButton.click();
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(e.ledgerList.children.length, 14, "the first page renders");

  e.ledgerMore.click();
  e.ledgerMore.click();
  for (let i = 0; i < 10; i++) await flush();
  const dates = e.ledgerList.children.map((row) => row.children[0].textContent);
  assert.equal(new Set(dates).size, dates.length, "no day is rendered twice");
  assert.equal(dates.length, 30, "both activations render distinct pages without skipping days");
  e.statsClose.click();
});
