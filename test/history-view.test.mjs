import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("history remembers each tab's page and scroll, uses entry dates, and keeps keyboard navigation local", async (t) => {
  const names = ["document", "localStorage", "window", "getComputedStyle"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const document = new FakeDocument(ids);
  const window = new EventTarget();
  const calls = [];
  window.setTimeout = () => 0;
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "select_history_item") return { history: structuredClone(state.history), index: args.index };
      if (command === "get_frame_by_id")
        return { source: "prntsc", id: args.id, sourcePageUrl: `https://prnt.sc/${args.id}`, mimeType: "image/png" };
      if (command === "get_random_frame")
        return { source: "prntsc", id: "new123", sourcePageUrl: "https://prnt.sc/new123", mimeType: "image/png" };
      if (command === "get_frame_image") return new Uint8Array([1]).buffer;
      if (command === "record_history_item")
        return { history: [...state.history, args.item], index: state.history.length };
      throw new Error(`Unexpected command: ${command}`);
    },
  };
  Object.assign(globalThis, {
    document,
    window,
    localStorage: new FakeStorage(),
    getComputedStyle: () => ({ gridTemplateColumns: "138px 138px 138px" }),
  });
  const { state } = await import("../dist/test-client/viewer-state.js");
  const { thumbnails } = await import("../dist/test-client/frame-cache.js");
  const { bindHistoryDialogEvents } = await import("../dist/test-client/history-dialog.js");
  const { bindNavigationEvents } = await import("../dist/test-client/frame-loader.js");
  state.loading = false;
  state.history = Array.from({ length: 60 }, (_, i) => ({
    source: "prntsc",
    id: `id${i}`,
    sourcePageUrl: `https://prnt.sc/id${i}`,
    viewedAt: Date.UTC(2026, 8, 30, 23, 5),
  }));
  state.index = 59;
  state.favorites = state.history.slice(0, 30).map((item) => ({ ...item, addedAt: Date.UTC(2026, 9, 1, 1, 15) }));
  for (const item of state.history) thumbnails.set(`${item.source}:${item.id}`, "data:image/png;base64,AA==");
  bindHistoryDialogEvents();
  bindNavigationEvents();
  const get = (id) => document.querySelector(`#${id}`);
  const tiles = () => get("history-grid").children;
  // Like a real display:none dialog, a closed body cannot report or restore its offset.
  let offset = 0;
  Object.defineProperty(get("history-body"), "scrollTop", {
    get: () => (get("history-dialog").open ? offset : 0),
    set: (value) => {
      offset = get("history-dialog").open ? value : 0;
    },
  });
  const scroll = (value) => {
    get("history-body").scrollTop = value;
    get("history-body").dispatchEvent(new Event("scroll"));
  };
  const key = (owner, target, value, extra = {}) => {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperties(event, {
      target: { value: target },
      key: { value },
      ...Object.fromEntries(Object.entries(extra).map(([name, value]) => [name, { value }])),
    });
    owner.dispatchEvent(event);
    return event;
  };
  const checkDate = (timestamp) => {
    const time = tiles()[0].children[0].children[2];
    assert.equal(time.dateTime, new Date(timestamp).toISOString());
    assert.equal(time.children[0].textContent, new Date(timestamp).toLocaleDateString());
    assert.equal(
      time.children[1].textContent,
      new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    );
  };
  get("history-tool-button").click();
  checkDate(state.history[59].viewedAt);
  get("history-page-next").click();
  scroll(240);
  get("history-filter-favorites").click();
  checkDate(state.favorites[29].addedAt);
  scroll(110);
  get("history-close-button").click();
  get("history-tool-button").click();
  assert.equal(get("history-filter-favorites").getAttribute("aria-selected"), "true");
  assert.equal(get("history-body").scrollTop, 110);
  get("history-filter-all").click();
  assert.equal(get("history-page-input").value, "2");
  assert.equal(get("history-body").scrollTop, 240);
  get("history-close-button").click();
  get("history-tool-button").click();
  assert.equal(get("history-body").scrollTop, 240);
  assert.equal(get("history-page-input").value, "2");

  assert.equal(key(get("history-filter-all"), get("history-filter-all"), "ArrowRight").defaultPrevented, true);
  assert.equal(document.activeElement, get("history-filter-favorites"));
  assert.equal(get("history-filter-all").tabIndex, -1);
  assert.equal(key(get("history-filter-favorites"), get("history-filter-favorites"), "Home").defaultPrevented, true);
  assert.equal(document.activeElement, get("history-filter-all"));
  const button = tiles()[0].children[0];
  button.closest = () => tiles()[0];
  key(get("history-grid"), button, "ArrowDown");
  assert.equal(document.activeElement, tiles()[3].children[0]);
  key(get("history-grid"), button, "End");
  assert.equal(document.activeElement, tiles().at(-1).children[0]);
  const input = { tagName: "INPUT", closest: () => tiles()[0] };
  assert.equal(key(get("history-grid"), input, "ArrowRight").defaultPrevented, false);
  assert.equal(key(get("history-grid"), { ...input, tagName: "TEXTAREA" }, "Home").defaultPrevented, false);
  assert.equal(
    key(get("history-grid"), { ...input, isContentEditable: true, tagName: "DIV" }, "Delete").defaultPrevented,
    false,
  );
  assert.equal(key(get("history-grid"), button, "ArrowRight", { ctrlKey: true }).defaultPrevented, false);

  // Selecting a starred tile in All keeps the frame action and opens Favorites next time.
  tiles()[6].children[0].click(); // id28 is starred
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(state.history[state.index].id, "id28");
  get("history-tool-button").click();
  assert.equal(get("history-filter-favorites").getAttribute("aria-selected"), "true");
  get("history-close-button").click();
  get("draw-button").click();
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(state.history[state.index].id, "new123");
  assert.equal(calls.filter(({ command }) => command === "get_random_frame").length, 1);
  get("history-tool-button").click();
  assert.equal(get("history-filter-all").getAttribute("aria-selected"), "true");
  assert.equal(get("history-page-input").value, "1");

  // A remembered page that disappears clamps to the remaining page and clears its old offset.
  get("history-page-next").click();
  scroll(200);
  get("history-close-button").click();
  state.history.splice(0, 55);
  get("history-tool-button").click();
  assert.equal(get("history-page-input").value, "1");
  assert.equal(get("history-body").scrollTop, 0);
  get("history-close-button").click();

  // A sync that lands while History is open redraws it from the reloaded state.
  get("history-tool-button").click();
  const before = tiles().length;
  state.history.push({ source: "prntsc", id: "synced1", sourcePageUrl: "https://prnt.sc/synced1", viewedAt: 5 });
  document.dispatchEvent(new CustomEvent("persisted-view-refreshed"));
  assert.equal(tiles().length, before + 1);
  get("history-close-button").click();
});
