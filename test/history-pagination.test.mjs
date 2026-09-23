import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PAGE_SIZE,
  historyPage,
  loadPageSize,
  PAGE_SIZE_STORAGE_KEY,
  PAGE_SIZES,
  pageCount,
  pageOf,
  parsePageSize,
  savePageSize,
} from "../dist/test-client/history-pagination.js";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("defaults to 25 frames per page and allows only 10/25/50/100", () => {
  assert.equal(DEFAULT_PAGE_SIZE, 25);
  assert.deepEqual([...PAGE_SIZES], [10, 25, 50, 100]);
  for (const size of PAGE_SIZES) assert.equal(parsePageSize(String(size)), size);
  assert.equal(loadPageSize(new FakeStorage()), 25);
});

test("falls back to 25 for any invalid stored page size", () => {
  for (const value of [null, "", "0", "-10", "7", "25.5", "1e2x", "abc", "Infinity", "{}"]) {
    assert.equal(parsePageSize(value), 25, `value ${value}`);
  }
  const throwing = {
    getItem() {
      throw new Error("storage disabled");
    },
  };
  assert.equal(loadPageSize(throwing), 25);
});

test("persists the page size under its own key and reads it back", () => {
  const store = new FakeStorage();
  store.setItem("prntsc-gallery-thumbnails", "{}");
  savePageSize(store, 50);
  assert.equal(store.values.get(PAGE_SIZE_STORAGE_KEY), "50");
  assert.equal(loadPageSize(store), 50);
  assert.equal(store.values.get("prntsc-gallery-thumbnails"), "{}");
  assert.doesNotThrow(() =>
    savePageSize(
      {
        setItem() {
          throw new Error("quota");
        },
      },
      10,
    ),
  );
});

test("counts pages, with an empty history still showing one page", () => {
  assert.equal(pageCount(0, 25), 1);
  assert.equal(pageCount(1, 25), 1);
  assert.equal(pageCount(25, 25), 1);
  assert.equal(pageCount(26, 25), 2);
  assert.equal(pageCount(101, 10), 11);
});

test("slices first, middle, and a short last page", () => {
  assert.deepEqual(historyPage(60, 0, 25), { page: 0, pages: 3, start: 0, end: 25 });
  assert.deepEqual(historyPage(60, 1, 25), { page: 1, pages: 3, start: 25, end: 50 });
  assert.deepEqual(historyPage(60, 2, 25), { page: 2, pages: 3, start: 50, end: 60 });
  assert.deepEqual(historyPage(0, 0, 25), { page: 0, pages: 1, start: 0, end: 0 });
});

test("clamps to an existing page when records disappear or the index is stale", () => {
  // Last page held one record which was removed: 51 -> 50 records.
  assert.deepEqual(historyPage(50, 2, 25), { page: 1, pages: 2, start: 25, end: 50 });
  // History cleared while on a later page.
  assert.deepEqual(historyPage(0, 5, 25), { page: 0, pages: 1, start: 0, end: 0 });
  assert.equal(historyPage(60, -3, 25).page, 0);
  assert.equal(historyPage(60, Number.NaN, 25).page, 0);
});

test("keeps the first visible frame in view when the page size changes", () => {
  const firstShown = historyPage(212, 3, 25).start; // frames 76-100
  assert.equal(firstShown, 75);
  const smaller = historyPage(212, pageOf(firstShown, 10), 10);
  assert.ok(smaller.start <= firstShown && firstShown < smaller.end);
  const larger = historyPage(212, pageOf(firstShown, 100), 100);
  assert.deepEqual(larger, { page: 0, pages: 3, start: 0, end: 100 });
  // A new frame appended while browsing adds a page without moving the current one.
  assert.deepEqual(historyPage(51, 1, 25), { page: 1, pages: 3, start: 25, end: 50 });
});

test("pages a long existing history without touching the stored records", async (t) => {
  const globalNames = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const stored = {
    history: Array.from({ length: 60 }, (_, i) => ({
      source: "prntsc",
      id: `old${i}`,
      sourcePageUrl: `https://prnt.sc/old${i}`,
      viewedAt: i,
    })),
    index: 30,
  };
  const original = structuredClone(stored);
  const invocations = [];
  const localStorage = new FakeStorage();
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  localStorage.setItem("random-frame-history-page-size", "7");

  const document = new FakeDocument(ids);
  const window = new EventTarget();
  const performance = { getEntriesByType: () => [] };
  Object.assign(globalThis, { document, localStorage, performance, sessionStorage: new FakeStorage(), window });
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      invocations.push(command);
      if (command === "get_history") return structuredClone(stored);
      if (command === "get_favorites") return [];
      if (command === "select_history_item") return { ...structuredClone(stored), index: args.index };
      if (command === "get_frame_by_id") {
        return { id: args.id, source: "prntsc", sourcePageUrl: `https://prnt.sc/${args.id}`, mimeType: "image/png" };
      }
      if (command === "get_frame_image") return new Uint8Array([1]).buffer;
      if (command === "migrate_viewing_stats") return null;
      throw new Error(`Unexpected command: ${command}`);
    },
  };
  await import("../dist/test-client/app.js");
  for (let i = 0; i < 4; i += 1) await flush();
  const get = (id) => document.querySelector(`#${id}`);
  get("history-button").click();
  // Invalid stored size falls back to 25; the dialog opens on the page holding frame 31.
  assert.equal(get("history-page-size").value, "25");
  assert.equal(get("history-pager").hidden, false);
  assert.equal(get("history-pager-nav").hidden, false);
  assert.equal(get("history-page").textContent, "Page 2 of 3");
  assert.equal(get("history-range").textContent, "Frames 26–50 of 60");
  assert.equal(get("history-grid").children.length, 25);
  assert.equal(get("history-grid").children[0].children[1].textContent, "26 · old25");
  assert.equal(get("history-grid").children[5].getAttribute("aria-current"), "true");

  get("history-page-next").focus();
  get("history-page-next").click();
  assert.equal(get("history-page").textContent, "Page 3 of 3");
  assert.equal(get("history-grid").children.length, 10);
  assert.equal(get("history-page-next").disabled, true);
  assert.equal(get("history-page-previous").disabled, false);
  assert.equal(get("history-body").scrollTop, 0);
  assert.equal(document.activeElement, get("history-page-previous"));

  get("history-page-previous").click();
  get("history-page-previous").click();
  assert.equal(get("history-page").textContent, "Page 1 of 3");
  assert.equal(get("history-page-previous").disabled, true);
  get("history-page-previous").click();
  assert.equal(get("history-page").textContent, "Page 1 of 3");

  get("history-page-next").click();
  get("history-page-size").value = "10";
  get("history-page-size").dispatchEvent(new Event("change"));
  // Frame 26 was first on screen and stays on screen.
  assert.equal(get("history-page").textContent, "Page 3 of 6");
  assert.equal(get("history-range").textContent, "Frames 21–30 of 60");
  assert.equal(localStorage.getItem("random-frame-history-page-size"), "10");

  get("history-page-size").value = "100";
  get("history-page-size").dispatchEvent(new Event("change"));
  assert.equal(get("history-grid").children.length, 60);
  assert.equal(get("history-pager").hidden, false);
  assert.equal(get("history-pager-nav").hidden, true);

  get("history-page-size").value = "10";
  get("history-page-size").dispatchEvent(new Event("change"));
  get("history-close-button").click();

  // Paging never writes history: the only backend write is the startup restore of the shown frame.
  assert.equal(invocations.filter((command) => command === "select_history_item").length, 1);
  assert.equal(invocations.includes("record_history_item"), false);
  assert.equal(invocations.includes("clear_history"), false);
  assert.deepEqual(stored, original);
});
