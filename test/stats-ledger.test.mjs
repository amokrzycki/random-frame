import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, fakeThumbnailCache, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("rapid Show earlier days activations serialize and never duplicate a day", async () => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  const days = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    viewed: 1,
    rejected: 0,
  }));
  const native = fakeThumbnailCache();
  for (let i = 0; i < 7; i++) native.disk.set(`prntsc:${i}`, [i]);
  let activity = { viewedTotal: 30, days, localViewTimes: [], frameViews: [] };
  globalThis.window = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (["list_thumbnail_cache", "read_thumbnail_cache", "save_thumbnail_cache"].includes(command))
          return native.invoke(command, args);
        if (command === "get_exploration_stats")
          return Promise.resolve({ explored: 30, viewable: 30, unavailable: 0, unclassified: 0 });
        if (command === "get_viewing_activity") return activity;
        throw new Error(`Unexpected ${command}`);
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

  const { state } = await import("../dist/test-client/viewer-state.js");
  state.history = Array.from({ length: 14 }, (_, i) => ({
    source: "prntsc",
    id: String(i),
    sourcePageUrl: `https://prnt.sc/${i}`,
    viewedAt: i + 1,
  }));
  activity = {
    viewedTotal: 14,
    days: [{ date: "2026-09-30", viewed: 14, rejected: 0 }],
    localViewTimes: [],
    frameViews: state.history.map((item) => ({ ...item, day: "2026-09-30", atMs: item.viewedAt })),
  };
  e.statsButton.click();
  for (let i = 0; i < 10; i++) await flush();
  const strip = e.ledgerList.children[0].children[2];
  assert.deepEqual(
    strip.children.filter((child) => child.tagName === "BUTTON").map((button) => button.dataset.tip),
    ["6", "5", "4", "3", "2", "1"],
    "missing thumbnails do not hide later cached frames",
  );
  assert.equal(strip.children.at(-1).textContent, "+8");
  assert.deepEqual(native.reads, ["prntsc:6", "prntsc:5", "prntsc:4", "prntsc:3", "prntsc:2", "prntsc:1"]);
  e.statsClose.click();
});
