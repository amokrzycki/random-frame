import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids, libraryOf } from "./dom-fakes.mjs";

test("collection creation validates, exposes pending state, and retains the name after a failed save", async (t) => {
  const document = new FakeDocument(ids);
  const window = new EventTarget();
  const globals = new Map(
    ["document", "window", "localStorage", "sessionStorage"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  Object.assign(globalThis, { document, window, localStorage: new FakeStorage(), sessionStorage: new FakeStorage() });
  t.after(() => {
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const get = (id) => document.querySelector(`#${id}`);
  const classes = new Set(["sync-dialog__button"]);
  get("collection-manage-apply").classList.toggle = (name, enabled) => {
    if (enabled) classes.add(name);
    else classes.delete(name);
  };
  let finish;
  const calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      calls.push({ command, args });
      return new Promise((resolve, reject) => {
        finish = { resolve, reject };
      });
    },
  };
  const { bindCollectionEvents, openCollectionManagement } = await import("../dist/test-client/collections-dialog.js");
  bindCollectionEvents();
  const dialog = get("collection-manage-dialog");
  const form = get("collection-manage-form");
  const name = get("collection-manage-name");
  const apply = get("collection-manage-apply");
  const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  openCollectionManagement("create");
  assert.equal(dialog.dataset.mode, "create");
  assert.equal(classes.has("primary-action"), true);
  submit();
  assert.equal(calls.length, 0);
  assert.equal(name.getAttribute("aria-invalid"), "true");
  assert.equal(document.activeElement, name);
  name.value = "Archive studies";
  submit();
  await flush();
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(name.hasAttribute("aria-invalid"), false);
  assert.equal(apply.textContent, "Creating…");
  assert.equal(apply.disabled, true);
  submit();
  assert.equal(calls.length, 1, "pending submission cannot create a duplicate");
  finish.reject({ kind: "persistence" });
  await flush();
  assert.equal(dialog.open, true);
  assert.equal(name.value, "Archive studies");
  assert.equal(get("collection-manage-error").hidden, false);
  assert.equal(form.getAttribute("aria-busy"), "false");
  assert.equal(apply.textContent, "Create collection");
  assert.equal(apply.disabled, false);
  submit();
  await flush();
  assert.deepEqual(calls[1], { command: "create_collection", args: { name: "Archive studies" } });
  finish.resolve(libraryOf());
  await flush();
  assert.equal(dialog.open, false);
  const collection = { collectionId: Array(16).fill(7), name: "Archive studies" };
  openCollectionManagement("rename", collection);
  assert.equal(classes.has("primary-action"), false);
  assert.equal(classes.has("sync-dialog__button"), true);
  assert.equal(apply.textContent, "Rename collection");
  dialog.close();
  openCollectionManagement("delete", collection);
  assert.equal(classes.has("sync-dialog__button--danger"), true);
  assert.equal(document.activeElement, get("collection-manage-cancel"));
});
