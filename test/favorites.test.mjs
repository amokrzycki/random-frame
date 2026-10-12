import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids, libraryOf, testCapabilities } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const item = (id) => ({ source: "prntsc", id, sourcePageUrl: `https://prnt.sc/${id}`, addedAt: 1 });
const submit = (form) => form.dispatchEvent(new Event("submit", { cancelable: true }));

test("quick save, collection drafts, stable Apply retry, filtering, stale recovery and Undo", async (t) => {
  const document = new FakeDocument(ids),
    window = new EventTarget();
  const localStorage = new FakeStorage(),
    sessionStorage = new FakeStorage();
  const globals = new Map(
    ["document", "window", "localStorage", "sessionStorage", "performance"].map((n) => [
      n,
      Object.getOwnPropertyDescriptor(globalThis, n),
    ]),
  );
  t.after(() => {
    for (const [n, d] of globals) {
      if (d) Object.defineProperty(globalThis, n, d);
      else delete globalThis[n];
    }
  });
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  window.setTimeout = () => 0;
  Object.assign(globalThis, {
    document,
    window,
    localStorage,
    sessionStorage,
    performance: { getEntriesByType: () => [{ type: "back_forward" }] },
  });
  const history = { history: ["aaa111", "bbb222"].map((id) => ({ ...item(id), viewedAt: 1 })), index: 1 };
  let library = libraryOf([item("aaa111")]);
  const calls = [];
  let pauseSave,
    failApply = false,
    holdSave = false;
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      calls.push({ command, args: structuredClone(args) });
      if (command === "get_platform_capabilities") return testCapabilities;
      if (command === "complete_state_imports") return null;
      if (["get_user_preferences", "set_user_preferences"].includes(command))
        return { theme: null, historyPageSize: null };
      if (["get_history", "import_session_history"].includes(command)) return structuredClone(history);
      if (command === "get_saved_library") return structuredClone(library);
      if (command === "select_history_item") {
        history.index = args.index;
        return structuredClone(history);
      }
      if (command === "get_frame_by_id") return { ...item(args.id), mimeType: "image/png" };
      if (command === "get_frame_image") return new Uint8Array([1]).buffer;
      if (command === "save_frame") {
        if (holdSave) await new Promise((resolve) => (pauseSave = resolve));
        library = libraryOf([...library.items, args.item], library.collections, library.memberships);
        return structuredClone(library);
      }
      if (command === "commit_collection_editor") {
        if (failApply) {
          failApply = false;
          throw { kind: "persistence" };
        }
        const request = args.request;
        const saved = library.items.find((x) => x.id === request.frame.id);
        if (JSON.stringify(saved?.saveOperationIds) !== JSON.stringify(request.frame.expectedSaveOperationIds))
          throw { kind: "stale_saved_frame" };
        library.collections.push(...request.createCollections);
        library.memberships = library.memberships.filter(
          (m) =>
            !request.removeMembershipOperationIds.some((id) => JSON.stringify(id) === JSON.stringify(m.operationId)),
        );
        for (const collectionId of request.addToCollectionIds)
          library.memberships.push({
            operationId: [library.memberships.length + 1, ...Array(15).fill(0)],
            collectionId,
            favoriteOperationId: saved.saveOperationIds[0],
          });
        return structuredClone(library);
      }
      if (command === "remove_saved_frame" || command === "clear_saved_frames") {
        for (const frame of args.request.frames) {
          const saved = library.items.find((x) => x.source === frame.source && x.id === frame.id);
          if (JSON.stringify(saved?.saveOperationIds) !== JSON.stringify(frame.expectedSaveOperationIds))
            throw { kind: "stale_saved_frame" };
        }
        const removed = library.items.filter((x) => args.request.frames.some((f) => f.id === x.id));
        const undo = {
          requestId: args.request.requestId,
          frames: removed.map((x) => ({
            item: x,
            collectionIds: library.memberships
              .filter((m) =>
                x.saveOperationIds.some((id) => JSON.stringify(id) === JSON.stringify(m.favoriteOperationId)),
              )
              .map((m) => m.collectionId),
          })),
        };
        library.items = library.items.filter((x) => !removed.includes(x));
        library.memberships = library.memberships.filter(
          (m) =>
            !removed.some((x) =>
              x.saveOperationIds.some((id) => JSON.stringify(id) === JSON.stringify(m.favoriteOperationId)),
            ),
        );
        return { library: structuredClone(library), undo };
      }
      if (command === "restore_saved_frames") {
        for (const frame of args.undo.frames) {
          library.items.push(frame.item);
          for (const collectionId of frame.collectionIds)
            library.memberships.push({
              operationId: [99, ...Array(15).fill(0)],
              collectionId,
              favoriteOperationId: frame.item.saveOperationIds[0],
            });
        }
        return structuredClone(library);
      }
      throw Error(`Unexpected command: ${command}`);
    },
  };
  await import(`../dist/test-client/app.js?collections=${Date.now()}`);
  for (let i = 0; i < 5; i++) await flush();
  const get = (id) => document.querySelector(`#${id}`);
  const star = get("favorite-button"),
    dialog = get("collections-dialog");
  assert.equal(star.getAttribute("aria-label"), "Save frame");
  assert.equal(star.getAttribute("aria-pressed"), null);
  holdSave = true;
  star.click();
  star.click();
  await flush();
  assert.equal(calls.filter((c) => c.command === "save_frame").length, 1);
  pauseSave();
  await flush();
  holdSave = false;
  assert.equal(star.hasAttribute("data-saved"), true);
  assert.equal(star.getAttribute("aria-haspopup"), "dialog");
  star.click();
  assert.equal(dialog.open, true);
  get("collections-name").value = "Canceled";
  get("collections-add").click();
  get("collections-cancel").click();
  assert.equal(library.collections.length, 0);
  star.click();
  for (const name of ["Screenshots", "Weird ones"]) {
    get("collections-name").value = name;
    get("collections-add").click();
  }
  assert.equal(get("collections-choices").children.length, 2);
  failApply = true;
  submit(get("collections-form"));
  submit(get("collections-form"));
  await flush();
  assert.equal(calls.filter((c) => c.command === "commit_collection_editor").length, 1);
  assert.equal(dialog.open, true);
  assert.equal(get("collections-error").hidden, false);
  assert.equal(library.collections.length, 0);
  submit(get("collections-form"));
  await flush();
  const commits = calls.filter((c) => c.command === "commit_collection_editor");
  assert.deepEqual(commits[0].args, commits[1].args);
  assert.equal(library.memberships.length, 2);
  assert.equal(dialog.open, false);
  star.click();
  const box = get("collections-choices").children[0].children[0];
  box.checked = false;
  box.dispatchEvent(new Event("change"));
  submit(get("collections-form"));
  await flush();
  assert.equal(library.memberships.length, 1);
  assert.equal(library.items.length, 2);
  get("history-tool-button").click();
  get("history-filter-favorites").click();
  const labels = () => get("history-grid").children.map((tile) => tile.children[0].getAttribute("aria-label"));
  assert.equal(labels().length, 2);
  assert.match(labels()[0], /saved frame/);
  assert.equal(
    get("saved-filter").children.some((o) => o.value === "none"),
    true,
  );
  get("saved-filter").value = library.collections[1].collectionId.map((n) => n.toString(16).padStart(2, "0")).join("");
  get("saved-filter").dispatchEvent(new Event("change"));
  assert.equal(labels().length, 1);
  assert.equal(get("history-clear-favorites-button").hidden, true);
  get("history-close-button").click();
  star.click();
  const before = library.items.find((x) => x.id === "bbb222");
  before.saveOperationIds = [Array(16).fill(88)];
  submit(get("collections-form"));
  await flush();
  assert.equal(dialog.open, true);
  assert.match(get("collections-error").textContent, /changed/);
  assert.equal(get("collections-reopen").hidden, false);
  // Reload through Sync, without replacing the draft, then explicitly begin a fresh edit.
  const viewer = await import("../dist/test-client/viewer-state.js");
  await viewer.refreshPersistedView();
  get("collections-reopen").click();
  get("collections-remove").click();
  await flush();
  assert.equal(dialog.open, false);
  assert.equal(library.items.length, 1);
  const notices = document.body.children.flatMap((region) => region.children);
  const undo = notices.at(-1).children[0];
  assert.equal(undo.textContent, "Undo");
  undo.click();
  await flush();
  assert.equal(library.items.length, 2);
  // Hiding the empty Without a collection destination is a product requirement.
  library.memberships = library.items.map((saved, i) => ({
    operationId: Array(16).fill(i + 20),
    collectionId: library.collections[0].collectionId,
    favoriteOperationId: saved.saveOperationIds[0],
  }));
  await viewer.refreshPersistedView();
  get("history-tool-button").click();
  get("history-filter-favorites").click();
  assert.equal(
    get("saved-filter").children.some((o) => o.value === "none"),
    false,
  );
  // A clear confirmation freezes its observed saves before Sync can add or replace them.
  get("saved-filter").value = "all";
  get("saved-filter").dispatchEvent(new Event("change"));
  const clear = get("history-clear-favorites-button");
  const observed = structuredClone(library.items);
  clear.click();
  library.items.push(libraryOf([item("fresh99")]).items[0]);
  await viewer.refreshPersistedView();
  await new Promise((resolve) => setTimeout(resolve, 520));
  clear.click();
  await flush();
  const firstClear = calls.findLast((c) => c.command === "clear_saved_frames").args.request;
  assert.deepEqual(
    firstClear.frames.map((f) => f.id),
    observed.map((f) => f.id),
  );
  assert.deepEqual(
    library.items.map((x) => x.id),
    ["fresh99"],
  );
  assert.equal(library.collections.length, 2);
  // A replacement with the same frame key must survive an already open clear review.
  const currentSave = structuredClone(library.items[0]);
  clear.click();
  library.items[0].saveOperationIds = [Array(16).fill(77)];
  await new Promise((resolve) => setTimeout(resolve, 520));
  clear.click();
  for (let i = 0; i < 3; i++) await flush();
  assert.equal(library.items.length, 1);
  const staleClear = calls.findLast((c) => c.command === "clear_saved_frames").args.request;
  assert.deepEqual(staleClear.frames[0].expectedSaveOperationIds, currentSave.saveOperationIds);
  assert.deepEqual(viewer.state.favorites[0].saveOperationIds, [Array(16).fill(77)]);
});
