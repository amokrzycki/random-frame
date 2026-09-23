import assert from "node:assert/strict";
import test from "node:test";
import { heatmapPlaceholderCount, heatmapRangeLabel, leadingBlankCount } from "../dist/test-client/statistics.js";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("persistent history keeps the existing jump path and the main image opens a lightbox", async (t) => {
  const document = new FakeDocument(ids);
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  const performance = { getEntriesByType: () => [{ type: "back_forward" }] };
  const globalNames = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  sessionStorage.setItem(
    "prntsc-gallery-history",
    JSON.stringify({ history: [{ id: "saved1" }, { id: "saved2" }], index: 1 }),
  );

  Object.assign(globalThis, { document, localStorage, performance, sessionStorage, window });
  const todayIso = new Date().toLocaleDateString("en-CA");
  let draw = 0;
  let savePath = null;
  let failNextDraw = false;
  const invocations = [];
  let persisted = { history: [], index: -1 };
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args, options) {
      invocations.push({ command, args, options });
      if (command === "get_history") return structuredClone(persisted);
      if (command === "record_history_item") {
        let itemIndex = persisted.history.findIndex(
          (item) => item.source === args.item.source && item.id === args.item.id,
        );
        if (itemIndex === -1) {
          persisted.history.push(args.item);
          itemIndex = persisted.history.length - 1;
        }
        persisted.index = itemIndex;
        return structuredClone(persisted);
      }
      if (command === "select_history_item") {
        persisted.index = args.index;
        return structuredClone(persisted);
      }
      if (command === "clear_history") {
        persisted = { history: [], index: -1 };
        return null;
      }
      if (command === "get_exploration_stats") {
        return { explored: 12_483, total: 4_773_622_240, viewable: 8_000, unavailable: 4_483 };
      }
      if (command === "get_viewing_activity") {
        return { viewedTotal: 2, days: [{ date: todayIso, viewed: 2, rejected: 0 }] };
      }
      if (command === "migrate_viewing_stats") return null;
      if (command === "get_random_frame") {
        if (failNextDraw) {
          failNextDraw = false;
          throw { kind: "network", message: "The source could not be reached" };
        }
        draw += 1;
        const id = draw === 1 ? "abc123" : "def456";
        return { id, source: "prntsc", sourcePageUrl: `https://prnt.sc/${id}`, mimeType: "image/jpeg" };
      }
      if (command === "get_frame_by_id") {
        return {
          id: args.id,
          source: "prntsc",
          sourcePageUrl: `https://prnt.sc/${args.id}`,
          mimeType: "image/png",
        };
      }
      if (command === "get_frame_image") return new Uint8Array([draw]).buffer;
      if (command === "plugin:dialog|save") return savePath;
      if (command === "plugin:fs|write_file") return null;
      throw new Error(`Unexpected command: ${command}`);
    },
  };
  t.after(() => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  await import(`../dist/test-client/app.js?test=${Date.now()}`);
  const get = (id) => document.querySelector(`#${id}`);
  await flush();
  await flush();
  await flush();

  get("history-button").click();
  assert.equal(get("history-dialog").open, true);
  assert.equal(get("history-grid").children.length, 2);
  assert.match(get("image").alt, /saved2/);
  // Pre-pagination users have no page-size setting; a short history shows no pager and nothing is written.
  assert.equal(get("history-pager").hidden, true);
  assert.equal(get("history-page-size").value, "25");
  assert.equal(localStorage.getItem("random-frame-history-page-size"), null);

  get("history-close-button").click();
  assert.equal(get("history-dialog").open, false);
  assert.equal(document.activeElement, get("history-button"));

  get("start-button").click();
  await flush();
  await flush();
  get("next-button").click();
  await flush();
  await flush();

  get("stats-button").click();
  await flush();
  assert.equal(get("stats-dialog").open, true);
  assert.equal(get("stats-today").textContent, "2");
  assert.equal(get("stats-total").textContent, "2");
  assert.equal(get("stats-explored").textContent, "12,483 / 4,773,622,240");
  assert.equal(get("stats-explored-percent").textContent, "< 0.001% of known legacy ID space");
  assert.equal(get("stats-explored-breakdown").textContent, "8,000 viewable · 4,483 unavailable");
  assert.equal(get("stats-heatmap-detail").textContent, "Hover or focus a day for details.");
  const expectedRange = heatmapRangeLabel([{ date: todayIso, viewed: 2, rejected: 0 }]);
  assert.equal(get("stats-heatmap-range").textContent, expectedRange);
  assert.equal(
    get("stats-heatmap-grid").getAttribute("aria-label"),
    `Daily viewed images, ${expectedRange.toLowerCase()}`,
  );
  assert.equal(get("stats-heatmap-grid").children.length, leadingBlankCount(todayIso) + 1 + heatmapPlaceholderCount(1));
  get("stats-close-button").click();
  assert.equal(document.activeElement, get("stats-button"));

  get("history-button").click();
  assert.equal(get("history-grid").children.length, 4);
  assert.equal(get("history-grid").children[3].getAttribute("aria-current"), "true");
  assert.equal(sessionStorage.getItem("prntsc-gallery-history"), null);
  assert.deepEqual(
    persisted.history.map(({ source, id }) => ({ source, id })),
    [
      { source: "prntsc", id: "saved1" },
      { source: "prntsc", id: "saved2" },
      { source: "prntsc", id: "abc123" },
      { source: "prntsc", id: "def456" },
    ],
  );

  get("dialog-backdrop").click();
  assert.equal(get("history-dialog").open, false);

  get("history-button").click();
  get("history-grid").children[0].click();
  assert.equal(get("history-dialog").open, false);
  await flush();
  await flush();
  assert.match(get("image").alt, /saved1/);

  get("save-button").click();
  await flush();
  assert.equal(invocations.at(-1).command, "plugin:dialog|save");

  savePath = "/tmp/random-frame-prntsc-saved1.png";
  get("save-button").click();
  await flush();
  await flush();
  assert.equal(invocations.at(-2).command, "plugin:dialog|save");
  assert.equal(invocations.at(-2).args.options.defaultPath, "random-frame-prntsc-saved1.png");
  assert.equal(invocations.at(-1).command, "plugin:fs|write_file");
  assert.deepEqual([...invocations.at(-1).args], [2]);

  get("jump-input").value = "4";
  get("jump-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.match(get("image").alt, /def456/);

  get("image-zoom").click();
  assert.equal(get("lightbox-dialog").open, true);
  const escapeKey = new Event("keydown");
  Object.defineProperty(escapeKey, "key", { value: "Escape" });
  document.dispatchEvent(escapeKey);
  assert.equal(get("lightbox-dialog").open, false);
  get("image-zoom").click();
  get("lightbox-dialog").click();
  assert.equal(get("lightbox-dialog").open, false);

  // A failed draw explains itself, hides actions for the unseen frame, and can return to the last frame.
  failNextDraw = true;
  get("next-button").click();
  await flush();
  await flush();
  assert.equal(get("error-state").hidden, false);
  assert.equal(get("error-title").textContent, "Prnt.sc could not be reached.");
  assert.equal(get("save-button").disabled, true);
  assert.equal(get("back-button").hidden, false);
  assert.equal(get("back-button").textContent, "Show frame 4");
  get("back-button").click();
  await flush();
  await flush();
  assert.equal(get("error-state").hidden, true);
  assert.match(get("image").alt, /def456/);
  assert.equal(get("save-button").disabled, false);

  // Clearing is hold-to-confirm: the completed fill transition clears, releasing early does not.
  const clearButton = get("history-clear-button");
  const clears = () => invocations.filter(({ command }) => command === "clear_history").length;
  const press = () => {
    const event = new Event("pointerdown");
    Object.defineProperty(event, "button", { value: 0 });
    clearButton.dispatchEvent(event);
  };
  const release = () => {
    clearButton.dispatchEvent(new Event("pointerup"));
    clearButton.click();
  };
  const fill = () => {
    const event = new Event("transitionend");
    Object.defineProperty(event, "pseudoElement", { value: "::before" });
    clearButton.dispatchEvent(event);
  };
  window.setTimeout = () => 0;
  get("history-button").click();
  press();
  release();
  fill();
  await flush();
  assert.equal(clears(), 0);
  press();
  fill();
  release();
  await flush();
  assert.deepEqual(persisted, { history: [], index: -1 });
  assert.equal(get("history-total").textContent, "0");
  assert.equal(clearButton.disabled, false);
  // Assistive tech clicks without a press: the first activation arms, the second clears.
  clearButton.click();
  await flush();
  assert.equal(clears(), 1);
  assert.equal(get("announcer").textContent, "Activate again to clear history");
  clearButton.click();
  await flush();
  assert.equal(clears(), 2);
});

test("migrates the legacy localStorage counter once on startup and clears it", async (t) => {
  const document = new FakeDocument(ids);
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  const performance = { getEntriesByType: () => [{ type: "back_forward" }] };
  const globalNames = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  const legacyDay = new Date().toLocaleDateString("en-CA");
  localStorage.setItem("random-frame-viewing-stats", JSON.stringify({ day: legacyDay, today: 5, total: 42 }));

  Object.assign(globalThis, { document, localStorage, performance, sessionStorage, window });
  const invocations = [];
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      invocations.push({ command, args });
      if (command === "get_history") return { history: [], index: -1 };
      if (command === "migrate_viewing_stats") return null;
      throw new Error(`Unexpected command: ${command}`);
    },
  };
  t.after(() => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  await import(`../dist/test-client/app.js?test=${Date.now()}`);
  await new Promise((resolve) => setImmediate(resolve));

  const migration = invocations.find(({ command }) => command === "migrate_viewing_stats");
  assert.deepEqual(migration?.args, { legacyDay, legacyToday: 5, legacyTotal: 42 });
  assert.equal(localStorage.getItem("random-frame-viewing-stats"), null);
});
