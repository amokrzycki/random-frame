import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids, testCapabilities } from "./dom-fakes.mjs";

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
      if (command === "get_platform_capabilities") return testCapabilities;
      if (command === "complete_state_imports") return null;
      if (command === "get_user_preferences" || command === "set_user_preferences")
        return { theme: null, historyPageSize: null };
      if (command === "import_session_history") return window.__TAURI_INTERNALS__.invoke("get_history");
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
      if (command === "get_random_frame") return { ...item("new123"), mimeType: "image/png" };
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
  const labels = () => get("history-grid").children.map((tile) => tile.children[0].getAttribute("aria-label"));
  for (let i = 0; i < 4; i += 1) await flush();

  const star = get("favorite-button");
  assert.match(get("image").alt, /ccc333/);
  assert.equal(star.disabled, false);
  assert.equal(star.getAttribute("aria-pressed"), "false");
  assert.equal(star.getAttribute("aria-label"), "Add to favorites");
  assert.equal(star.dataset.tip, "Add to favorites (F)");

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
  assert.equal(star.dataset.tip, "Remove from favorites (F)");
  assert.equal(lastToast().className, "toast toast--success");
  assert.equal(lastToast().textContent, "Added to favorites");

  // All shows every frame; starred tiles carry the badge, separate from the current-frame border.
  get("history-tool-button").click();
  assert.equal(get("history-filter-all").getAttribute("aria-selected"), "true");
  // Newest first.
  assert.deepEqual(labels(), [
    "Show frame 3, ccc333, favorite",
    "Show frame 2, bbb222, favorite",
    "Show frame 1, aaa111",
  ]);
  const tiles = get("history-grid").children;
  assert.deepEqual(
    tiles.map((tile) => "favorite" in tile.children[0].dataset),
    [true, true, false],
  );
  assert.equal(tiles[0].children[0].getAttribute("aria-current"), "true");
  assert.equal(get("history-clear-favorites-button").hidden, true);

  // Favorites narrows the same grid to starred frames, most recently starred first.
  get("history-filter-favorites").click();
  assert.equal(get("history-filter-favorites").getAttribute("aria-selected"), "true");
  assert.equal(get("history-filter-all").getAttribute("aria-selected"), "false");
  assert.deepEqual(labels(), [
    "Show favorite 1, ccc333, favorite",
    "Show favorite 2, gone99, favorite",
    "Show favorite 3, bbb222, favorite",
  ]);
  assert.equal(get("history-grid").children[1].children[0].children[1].textContent, "2 · gone99");
  assert.equal(get("history-clear-button").hidden, true);
  assert.equal(get("history-clear-favorites-button").hidden, false);

  // Reopening keeps the Favorites tab.
  get("history-close-button").click();
  get("history-tool-button").click();
  assert.equal(get("history-filter-favorites").getAttribute("aria-selected"), "true");

  // A favorite missing from history is fetched by id and joins the end of history.
  get("history-filter-all").click();
  get("history-grid").children[0].children[0].click(); // The currently shown ccc333 is starred.
  assert.equal(get("frame-count-current").textContent, "1");
  assert.equal(get("frame-count-total").textContent, "3");
  keydown(document, "ArrowRight"); // gone99 is a favorite missing from history.
  for (let i = 0; i < 3; i += 1) await flush();
  assert.equal(
    invocations.filter(({ command, args }) => command === "get_frame_by_id" && args.id === "gone99").length,
    1,
  );
  assert.match(get("image").alt, /gone99/);
  assert.equal(get("frame-count-current").textContent, "2");
  assert.equal(get("frame-count-total").textContent, "3");
  assert.equal(star.getAttribute("aria-pressed"), "true");

  // Main arrows browse only favorites, in the same order as the Favorites list.
  get("next-button").click();
  for (let i = 0; i < 3; i += 1) await flush();
  assert.match(get("image").alt, /bbb222/);
  assert.equal(get("frame-count-current").textContent, "3");
  assert.equal(get("next-button").hidden, true);
  keydown(document, "ArrowRight");
  await flush();
  assert.match(get("image").alt, /bbb222/);
  assert.match(get("announcer").textContent, /last favorite/);
  keydown(document, "ArrowLeft");
  for (let i = 0; i < 3; i += 1) await flush();
  assert.match(get("image").alt, /gone99/);

  // The enlarged view and jump field use the same favorite positions.
  get("image-zoom").click();
  assert.equal(get("lightbox-caption").textContent, "gone99 · 2 / 3");
  get("lightbox-previous").click();
  for (let i = 0; i < 3; i += 1) await flush();
  assert.match(get("image").alt, /ccc333/);
  assert.equal(get("lightbox-caption").textContent, "ccc333 · 1 / 3");
  get("lightbox-close-button").click();
  get("position-button").click();
  assert.equal(get("jump-input").max, "3");
  get("jump-input").value = "2";
  get("jump-form").dispatchEvent(new Event("submit", { cancelable: true }));
  for (let i = 0; i < 3; i += 1) await flush();
  assert.match(get("image").alt, /gone99/);

  // Drawing returns the main arrows and counter to general history.
  get("history-close-button").click();
  get("draw-button").click();
  for (let i = 0; i < 3; i += 1) await flush();
  assert.match(get("image").alt, /new123/);
  assert.equal(get("frame-count-total").textContent, "5");
  get("previous-button").click();
  for (let i = 0; i < 3; i += 1) await flush();
  assert.match(get("image").alt, /gone99/);
  get("previous-button").click();
  for (let i = 0; i < 3; i += 1) await flush();
  assert.match(get("image").alt, /ccc333/);
  get("history-tool-button").click();
  assert.equal(get("history-filter-all").getAttribute("aria-selected"), "true");
  get("history-grid").children[1].children[0].click(); // gone99 is starred.
  for (let i = 0; i < 3; i += 1) await flush();
  assert.match(get("image").alt, /gone99/);
  assert.equal(get("frame-count-total").textContent, "3");

  // The star button toggles back off with its own toast.
  star.click();
  await flush();
  assert.equal(star.getAttribute("aria-pressed"), "false");
  assert.equal(star.getAttribute("aria-label"), "Add to favorites");
  assert.equal(lastToast().className, "toast toast--info");
  assert.equal(lastToast().textContent, "Removed from favorites");
  assert.equal(get("frame-count-total").textContent, "5");

  // Undo puts the favorite back with its original date, so it keeps its place.
  const undo = lastToast().children[0];
  assert.equal(undo.textContent, "Undo");
  undo.click();
  await flush();
  assert.equal(star.getAttribute("aria-pressed"), "true");
  assert.equal(invocations.filter(({ command }) => command === "toggle_favorite").at(-1).args.item.addedAt, 2);
  star.click();
  await flush();
  assert.equal(star.getAttribute("aria-pressed"), "false");

  // Clearing favorites uses the history clear's double activation and leaves the Favorites empty state.
  get("history-tool-button").click();
  get("history-filter-favorites").click();
  const clearFavorites = get("history-clear-favorites-button");
  clearFavorites.click();
  assert.match(get("announcer").textContent, /^Activate again to clear favorites: \d+ favorites?$/);
  get("history-close-button").click();
  get("history-tool-button").click();
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
  await new Promise((resolve) => setTimeout(resolve, 520));
  clearFavorites.click();
  await flush();
  assert.deepEqual(favorites, []);
  assert.equal(get("history-grid").hidden, true);
  assert.equal(get("history-empty").hidden, false);
  assert.equal(get("history-empty-title").textContent, "No favorites yet.");
  assert.equal(clearFavorites.hidden, true);
  // The only new history record came from Draw.
  assert.equal(history.history.length, 5);
  assert.equal(
    invocations.some(({ command }) => command === "clear_history"),
    false,
  );
});
