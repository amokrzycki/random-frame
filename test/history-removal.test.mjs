import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const item = (id) => ({ source: "prntsc", id, sourcePageUrl: `https://prnt.sc/${id}`, viewedAt: 1 });

test("removes one frame from the grid or the frame menu, and Undo puts it back in place", async (t) => {
  const document = new FakeDocument(ids);
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  const names = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  window.setTimeout = () => 0;
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  Object.assign(globalThis, {
    document,
    localStorage,
    window,
    sessionStorage: new FakeStorage(),
    performance: { getEntriesByType: () => [{ type: "back_forward" }] },
  });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  const history = { history: ["aaa111", "bbb222", "ccc333", "ddd444"].map(item), index: 1 };
  const calls = [];
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "get_history") return structuredClone(history);
      if (command === "get_favorites") return [];
      if (command === "select_history_item") {
        history.index = args.index;
        return structuredClone(history);
      }
      if (command === "remove_history_item") {
        const orderAt = history.history.findIndex(({ id }) => id === args.id);
        history.history.splice(orderAt, 1);
        history.index = -1;
        return { snapshot: structuredClone(history), orderAt };
      }
      if (command === "restore_history_item") {
        history.history.splice(args.orderAt, 0, args.item);
        return structuredClone(history);
      }
      if (command === "get_frame_by_id") return { ...item(args.id), mimeType: "image/png" };
      if (command === "get_frame_image") return new Uint8Array([1]).buffer;
      throw new Error(`Unexpected command: ${command}`);
    },
  };

  await import(`../dist/test-client/app.js?test=${Date.now()}`);
  for (let i = 0; i < 4; i += 1) await flush();
  const get = (id) => document.querySelector(`#${id}`);
  const grid = () => get("history-grid").children;
  const order = () => grid().map((tile) => tile.children[0].children[1].textContent);
  const undo = () => document.body.children.flatMap((region) => region.children).at(-1).children[0];

  // Newest first; the tile's pointer control removes it without moving the shown frame.
  get("history-button").click();
  assert.deepEqual(order(), ["4 · ddd444", "3 · ccc333", "2 · bbb222", "1 · aaa111"]);
  assert.equal(grid()[2].children[0].getAttribute("aria-keyshortcuts"), "Delete");
  grid()[0].children[1].click();
  await flush();
  assert.deepEqual(order(), ["3 · ccc333", "2 · bbb222", "1 · aaa111"]);
  assert.equal(get("position-current").textContent, "2");
  assert.match(get("image").alt, /bbb222/);

  // Undo restores it at its old place by sending the position the backend returned.
  undo().click();
  await flush();
  assert.deepEqual(calls.find(({ command }) => command === "restore_history_item").args, {
    item: item("ddd444"),
    orderAt: 3,
  });
  assert.deepEqual(order(), ["4 · ddd444", "3 · ccc333", "2 · bbb222", "1 · aaa111"]);
  get("history-close-button").click();

  // The frame menu removes the shown frame and lands on the one that took its place.
  get("remove-frame-button").click();
  for (let i = 0; i < 3; i += 1) await flush();
  assert.deepEqual(
    history.history.map(({ id }) => id),
    ["aaa111", "ccc333", "ddd444"],
  );
  assert.match(get("image").alt, /ccc333/);
  assert.equal(get("position-current").textContent, "2");

  // Undo returns the visitor to the frame they removed, since they have not moved on.
  undo().click();
  for (let i = 0; i < 3; i += 1) await flush();
  assert.match(get("image").alt, /bbb222/);
  assert.equal(get("position-current").textContent, "2");
  assert.equal(history.history.length, 4);
});
