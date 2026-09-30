import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("loads missing thumbnails lazily, throttled, without viewing frames", async (t) => {
  const names = ["document", "localStorage", "performance", "sessionStorage", "window", "createImageBitmap"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  const document = new FakeDocument(ids);
  const createElement = document.createElement.bind(document);
  document.createElement = (tag) =>
    tag === "canvas"
      ? {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage() {
              /* Fake canvas */
            },
          }),
          toDataURL: () => "data:image/jpeg;base64,AA==",
        }
      : createElement(tag);
  const localStorage = new FakeStorage();
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  localStorage.setItem("random-frame-history-page-size", "10");
  localStorage.setItem("prntsc-gallery-thumbnails", JSON.stringify({ "prntsc:id10": "data:image/jpeg;base64,AA==" }));
  const window = new EventTarget();
  let toastExpiry;
  window.setTimeout = (callback) => {
    toastExpiry = callback;
    return 0;
  };
  Object.assign(globalThis, {
    document,
    localStorage,
    window,
    sessionStorage: new FakeStorage(),
    performance: { getEntriesByType: () => [] },
    createImageBitmap: async (blob) => {
      if (new Uint8Array(await blob.arrayBuffer())[0] === 255) throw new Error("bad image");
      return {
        width: 100,
        height: 100,
        close() {
          /* Fake bitmap */
        },
      };
    },
  });

  const item = (id) => ({ source: "prntsc", id, sourcePageUrl: `https://prnt.sc/${id}`, viewedAt: 1 });
  const history = { history: Array.from({ length: 12 }, (_, i) => item(`id${i}`)), index: -1 };
  history.history[8] = item("id7"); // duplicate on the first page
  const favorites = [item("id1"), item("id10")];
  const calls = [];
  let active = 0;
  let peak = 0;
  let release;
  let blocked = true;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "get_history") return structuredClone(history);
      if (command === "get_favorites") return structuredClone(favorites);
      if (command === "clear_history") {
        history.history = [];
        history.index = -1;
        return null;
      }
      if (command === "get_thumbnail_image") {
        active++;
        peak = Math.max(peak, active);
        if (blocked) await gate;
        active--;
        if (args.id === "id3") throw new Error("unavailable");
        return new Uint8Array([1]).buffer;
      }
      if (command === "migrate_viewing_stats") return null;
      throw new Error(`Unexpected command: ${command}`);
    },
  };

  await import("../dist/test-client/app.js");
  for (let i = 0; i < 4; i++) await flush();
  const get = (id) => document.querySelector(`#${id}`);
  const fetchedIds = () => calls.filter(({ command }) => command === "get_thumbnail_image").map(({ args }) => args.id);
  get("history-tool-button").click();
  assert.equal(get("history-filter-all").getAttribute("aria-pressed"), "true");
  // Newest first: the first page holds frames 12 down to 3.
  assert.equal(get("history-page").textContent, "Page 1 of 2");
  assert.equal(get("history-grid").children.length, 10);
  await flush();

  // Missing tiles show a skeleton and load a few at a time, without viewing frames.
  const tiles = get("history-grid").children.map((tile) => tile.children[0]);
  assert.equal(tiles[2].getAttribute("data-loading"), "true");
  assert.equal(tiles[1].getAttribute("data-loading"), null); // id10 is already cached
  assert.equal(peak, 3);
  assert.equal(fetchedIds().length, 3);
  const { blobKey, persistThumbnails, thumbnails } = await import("../dist/test-client/frame-cache.js");

  blocked = false;
  release();
  for (let i = 0; i < 12; i++) await flush();
  assert.ok(peak <= 3);
  const fetched = fetchedIds();
  assert.deepEqual(new Set(fetched), new Set(["id2", "id3", "id4", "id5", "id6", "id7", "id9", "id11"]));
  assert.equal(fetched.length, 8);
  assert.equal(tiles[8].getAttribute("data-empty"), "true"); // id3 failed
  assert.equal(tiles[2].getAttribute("data-loading"), null);
  assert.equal(tiles[2].children[0].src, "data:image/jpeg;base64,AA==");
  assert.equal(
    calls.some(({ command }) => ["record_history_item", "select_history_item"].includes(command)),
    false,
  );
  assert.equal(get("image").src, "");
  assert.equal(get("frame-count-current").textContent, "0");
  assert.equal(history.history.length, 12);

  // Closing the dialog saves what was fetched.
  get("history-close-button").click();
  assert.equal(
    JSON.parse(localStorage.getItem("prntsc-gallery-thumbnails"))["prntsc:id2"],
    "data:image/jpeg;base64,AA==",
  );
  get("history-tool-button").click();
  get("history-filter-favorites").click();
  assert.equal(get("history-filter-favorites").getAttribute("aria-pressed"), "true");
  assert.equal(get("history-grid").children[0].children[0].children[1].textContent, "11 · id10");
  assert.equal(get("history-grid").children[0].children[0].children[0].src, "data:image/jpeg;base64,AA==");

  // Sync imports domain data only; the missing local thumbnail uses the same fetch path.
  const { applyFavorites, state } = await import("../dist/test-client/viewer-state.js");
  applyFavorites([...state.favorites, item("id11")]);
  get("history-filter-favorites").click();
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(fetchedIds().filter((id) => id === "id11").length, 1);
  assert.equal(history.history.length, 12);
  assert.equal(get("frame-count-current").textContent, "0");
  assert.equal(
    calls.some(({ command }) => ["record_history_item", "select_history_item"].includes(command)),
    false,
  );
  for (let i = 0; i < 301; i++) thumbnails.set(blobKey("prntsc", `overflow${i}`), "data:image/jpeg;base64,AA==");
  persistThumbnails();
  assert.equal(
    JSON.parse(localStorage.getItem("prntsc-gallery-thumbnails"))["prntsc:id11"],
    "data:image/jpeg;base64,AA==",
  );

  // History clearing retains cached thumbnails used by Favourites, including one no longer in History.
  get("history-filter-all").click();
  const clear = get("history-clear-button");
  clear.click();
  await new Promise((resolve) => setTimeout(resolve, 520));
  clear.click();
  toastExpiry();
  await flush();
  const stored = JSON.parse(localStorage.getItem("prntsc-gallery-thumbnails"));
  assert.deepEqual(Object.keys(stored).sort(), ["prntsc:id1", "prntsc:id10", "prntsc:id11"]);
  get("history-tool-button").click();
  get("history-filter-favorites").click();
  assert.deepEqual(
    get("history-grid").children.map((tile) => tile.children[0].children[0].src),
    [stored["prntsc:id11"], stored["prntsc:id10"], stored["prntsc:id1"]],
  );
});
