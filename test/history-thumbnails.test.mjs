import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("downloads only missing thumbnails on the visible page without viewing frames", async (t) => {
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
  localStorage.setItem("prntsc-gallery-thumbnails", JSON.stringify({ "prntsc:id0": "data:image/jpeg;base64,AA==" }));
  const window = new EventTarget();
  window.setTimeout = () => 0;
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
  let gate = new Promise((resolve) => {
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
  const button = get("history-thumbnails");
  get("history-button").click();
  assert.equal(get("history-filter-all").getAttribute("aria-pressed"), "true");
  assert.equal(get("history-page").textContent, "Page 2 of 2");
  get("history-page-previous").click();
  assert.equal(get("history-grid").children.length, 10);
  assert.equal(get("history-thumbnail-action").hidden, false);
  button.click();
  button.click();
  await flush();
  assert.equal(button.disabled, true);
  assert.equal(peak, 5);
  assert.equal(calls.filter(({ command }) => command === "get_thumbnail_image").length, 5);
  const { thumbnails } = await import("../dist/test-client/frame-cache.js");
  thumbnails.set("prntsc:id6", "data:image/jpeg;base64,AA==");

  // Finishing work for an old page and tab leaves the current view intact.
  get("history-page-next").click();
  assert.equal(get("history-page").textContent, "Page 2 of 2");
  get("history-filter-favorites").click();
  assert.equal(get("history-grid").children.length, 2);
  blocked = false;
  release();
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(get("history-filter-favorites").getAttribute("aria-pressed"), "true");
  assert.equal(get("history-grid").children.length, 2);
  assert.equal(get("history-grid").children[1].children[1].textContent, "11 · id10");
  assert.equal(button.disabled, false);
  assert.match(document.body.children.at(-1).children.at(-1).textContent, /1 thumbnail.*could not be downloaded/);

  const fetched = calls.filter(({ command }) => command === "get_thumbnail_image").map(({ args }) => args.id);
  assert.deepEqual(new Set(fetched), new Set(["id1", "id2", "id3", "id4", "id5", "id7", "id9"]));
  assert.equal(fetched.length, 7);
  assert.ok(peak <= 5);
  assert.equal(
    calls.some(({ command }) => ["record_history_item", "select_history_item"].includes(command)),
    false,
  );
  assert.equal(get("image").src, "");
  assert.equal(get("position-current").textContent, "0");
  assert.equal(history.history.length, 12);
  assert.equal(
    JSON.parse(localStorage.getItem("prntsc-gallery-thumbnails"))["prntsc:id2"],
    "data:image/jpeg;base64,AA==",
  );

  // The Favourites action works independently; closing during its fetch is safe.
  blocked = true;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  button.click();
  await flush();
  get("history-close-button").click();
  blocked = false;
  release();
  for (let i = 0; i < 5; i++) await flush();
  get("history-button").click();
  assert.equal(get("history-filter-favorites").getAttribute("aria-pressed"), "true");
  assert.equal(calls.filter(({ command, args }) => command === "get_thumbnail_image" && args.id === "id10").length, 1);
  assert.equal(get("history-thumbnail-action").hidden, true);
  assert.equal(button.disabled, true);
  assert.equal(get("history-grid").children[1].children[0].src, "data:image/jpeg;base64,AA==");

  // History clearing retains cached thumbnails used by Favourites, including one no longer in History.
  get("history-filter-all").click();
  const clear = get("history-clear-button");
  clear.click();
  clear.click();
  await flush();
  const stored = JSON.parse(localStorage.getItem("prntsc-gallery-thumbnails"));
  assert.deepEqual(Object.keys(stored).sort(), ["prntsc:id1", "prntsc:id10"]);
  get("history-button").click();
  get("history-filter-favorites").click();
  assert.deepEqual(
    get("history-grid").children.map((tile) => tile.children[0].src),
    [stored["prntsc:id1"], stored["prntsc:id10"]],
  );
  assert.equal(get("history-thumbnail-action").hidden, true);
});
