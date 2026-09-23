import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const keydown = (target, key) => {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  target.dispatchEvent(event);
};
const item = (id) => ({ source: "prntsc", id, sourcePageUrl: `https://prnt.sc/${id}` });

test("favorites toggle from the info line and filter the history grid", async (t) => {
  const document = new FakeDocument(ids);
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  const performance = { getEntriesByType: () => [{ type: "back_forward" }] };
  const globalNames = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  // Toasts schedule their own dismissal; the test never waits for it.
  window.setTimeout = () => 0;
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  Object.assign(globalThis, { document, localStorage, performance, sessionStorage, window });

  const history = {
    history: ["aaa111", "bbb222", "ccc333"].map((id) => ({ ...item(id), viewedAt: 1 })),
    index: 2,
  };
  // gone99 was starred before a history clear: it is a favorite with no history entry.
  let favorites = [
    { ...item("bbb222"), addedAt: 1 },
    { ...item("gone99"), addedAt: 2 },
  ];
  let releaseToggle;
  let pauseNextToggle = false;
  const invocations = [];
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      invocations.push({ command, args });
      if (command === "get_history") return structuredClone(history);
      if (command === "get_favorites") return structuredClone(favorites);
      if (command === "toggle_favorite") {
        if (pauseNextToggle) {
          pauseNextToggle = false;
          await new Promise((resolve) => {
            releaseToggle = resolve;
          });
        }
        const { source, id } = args.item;
        const kept = favorites.filter((saved) => saved.source !== source || saved.id !== id);
        favorites = kept.length === favorites.length ? [...favorites, args.item] : kept;
        return structuredClone(favorites);
      }
      if (command === "clear_favorites") {
        favorites = [];
        return null;
      }
      if (command === "record_history_item") {
        history.history.push(args.item);
        history.index = history.history.length - 1;
        return structuredClone(history);
      }
      if (command === "select_history_item") {
        history.index = args.index;
        return structuredClone(history);
      }
      if (command === "get_frame_by_id") return { ...item(args.id), mimeType: "image/png" };
      if (command === "get_frame_image") return new Uint8Array([1]).buffer;
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
  const lastToast = () => document.body.children.flatMap((region) => region.children).at(-1);
  const labels = () => get("history-grid").children.map((tile) => tile.getAttribute("aria-label"));
  for (let i = 0; i < 4; i += 1) await flush();

  const star = get("favorite-button");
  assert.match(get("image").alt, /ccc333/);
  assert.equal(star.disabled, false);
  assert.equal(star.getAttribute("aria-pressed"), "false");
  assert.equal(star.getAttribute("aria-label"), "Add to favorites");
  assert.equal(star.title, "Add to favorites (F)");

  // Rapid activations must leave only one request in flight.
  pauseNextToggle = true;
  keydown(document, "f");
  star.click();
  keydown(document, "f");
  assert.equal(invocations.filter(({ command }) => command === "toggle_favorite").length, 1);
  releaseToggle();
  await flush();
  assert.deepEqual(
    invocations.filter(({ command }) => command === "toggle_favorite").map(({ args }) => args.item.id),
    ["ccc333"],
  );
  assert.equal(star.getAttribute("aria-pressed"), "true");
  assert.equal(star.getAttribute("aria-label"), "Remove from favorites");
  assert.equal(star.title, "Remove from favorites (F)");
  assert.equal(lastToast().className, "toast toast--success");
  assert.equal(lastToast().textContent, "Added to favorites");

  // All shows every frame; starred tiles carry the badge, separate from the current-frame border.
  get("history-button").click();
  assert.equal(get("history-filter-all").getAttribute("aria-pressed"), "true");
  assert.deepEqual(labels(), [
    "Show frame 1, aaa111",
    "Show frame 2, bbb222, favorite",
    "Show frame 3, ccc333, favorite",
  ]);
  const tiles = get("history-grid").children;
  assert.deepEqual(
    tiles.map((tile) => "favorite" in tile.dataset),
    [false, true, true],
  );
  assert.equal(tiles[2].getAttribute("aria-current"), "true");
  assert.equal(get("history-clear-favorites-button").hidden, true);

  // Favorites narrows the same grid to starred frames, in the order they were starred.
  get("history-filter-favorites").click();
  assert.equal(get("history-filter-favorites").getAttribute("aria-pressed"), "true");
  assert.equal(get("history-filter-all").getAttribute("aria-pressed"), "false");
  assert.deepEqual(labels(), [
    "Show frame 2, bbb222, favorite",
    "Show frame gone99, favorite",
    "Show frame 3, ccc333, favorite",
  ]);
  assert.equal(get("history-grid").children[1].children[1].textContent, "gone99");
  assert.equal(get("history-clear-button").hidden, true);
  assert.equal(get("history-clear-favorites-button").hidden, false);

  // The filter lives in memory only: reopening starts on All again.
  get("history-close-button").click();
  get("history-button").click();
  assert.equal(get("history-filter-all").getAttribute("aria-pressed"), "true");
  assert.equal(get("history-grid").children.length, 3);

  // A favorite missing from history is fetched by id and joins the end of history.
  get("history-filter-favorites").click();
  get("history-grid").children[1].click();
  for (let i = 0; i < 3; i += 1) await flush();
  assert.equal(
    invocations.filter(({ command, args }) => command === "get_frame_by_id" && args.id === "gone99").length,
    1,
  );
  assert.match(get("image").alt, /gone99/);
  assert.equal(get("position-current").textContent, "4");
  assert.equal(star.getAttribute("aria-pressed"), "true");

  // The star button toggles back off with its own toast.
  star.click();
  await flush();
  assert.equal(star.getAttribute("aria-pressed"), "false");
  assert.equal(star.getAttribute("aria-label"), "Add to favorites");
  assert.equal(lastToast().className, "toast toast--info");
  assert.equal(lastToast().textContent, "Removed from favorites");

  // Clearing favorites uses the history clear's double activation and leaves the Favorites empty state.
  get("history-button").click();
  get("history-filter-favorites").click();
  const clearFavorites = get("history-clear-favorites-button");
  clearFavorites.click();
  assert.equal(get("announcer").textContent, "Activate again to clear favorites");
  get("history-close-button").click();
  get("history-button").click();
  get("history-filter-favorites").click();
  clearFavorites.click();
  await flush();
  assert.notEqual(favorites.length, 0);
  get("history-filter-all").click();
  get("history-filter-favorites").click();
  clearFavorites.click();
  await flush();
  assert.notEqual(favorites.length, 0);
  clearFavorites.click();
  await flush();
  assert.deepEqual(favorites, []);
  assert.equal(get("history-grid").hidden, true);
  assert.equal(get("history-empty").hidden, false);
  assert.equal(get("history-empty-title").textContent, "No favorites yet.");
  assert.equal(clearFavorites.hidden, true);
  // History itself is untouched.
  assert.equal(history.history.length, 4);
  assert.equal(
    invocations.some(({ command }) => command === "clear_history"),
    false,
  );
});
