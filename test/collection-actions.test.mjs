import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

test("collection menu owns keyboard navigation and restores focus on dismissal", async (t) => {
  const originals = new Map(
    ["document", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const document = new FakeDocument(ids);
  const window = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
  Object.assign(globalThis, { document, window });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const get = (id) => document.querySelector(`#${id}`);
  const button = get("collection-actions-button"),
    menu = get("collection-actions-menu");
  const rename = get("collection-rename"),
    remove = get("collection-delete");
  menu.append(rename, remove);
  menu.querySelectorAll = () => menu.children.filter((item) => !item.disabled && !item.hidden);
  for (const item of [rename, remove]) item.closest = () => null;
  button.getBoundingClientRect = () => ({ top: 180, bottom: 218, right: 590 });
  get("history-dialog").getBoundingClientRect = () => ({ top: 80, bottom: 520 });
  for (const [method, state] of [
    ["showPopover", "open"],
    ["hidePopover", "closed"],
  ]) {
    menu[method] = () => {
      const event = new Event("beforetoggle");
      event.newState = state;
      menu.dispatchEvent(event);
      menu.popoverOpen = state === "open";
      menu.dispatchEvent(new Event("toggle"));
    };
  }
  const { bindCollectionActions, closeCollectionActions } = await import("../dist/test-client/collection-actions.js");
  bindCollectionActions();
  const key = (target, value) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key: value });
    target.dispatchEvent(event);
    return event;
  };
  button.focus();
  menu.showPopover();
  assert.equal(
    document.activeElement.id,
    rename.id,
    "native Enter/Space activation focuses the first action after opening",
  );
  assert.equal(button.getAttribute("aria-expanded"), "true");
  key(menu, "ArrowDown");
  assert.equal(document.activeElement.id, remove.id);
  key(menu, "ArrowDown");
  assert.equal(document.activeElement.id, rename.id, "navigation wraps");
  key(menu, "End");
  assert.equal(document.activeElement.id, remove.id);
  key(menu, "Home");
  assert.equal(document.activeElement.id, rename.id);
  assert.equal(key(menu, "Escape").defaultPrevented, true);
  assert.equal(menu.popoverOpen, false);
  assert.equal(document.activeElement.id, button.id);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  key(button, "ArrowUp");
  assert.equal(document.activeElement.id, remove.id);
  assert.equal(key(menu, "Tab").defaultPrevented, false, "Tab continues from the restored trigger");
  assert.equal(menu.popoverOpen, false);
  button.focus();
  menu.showPopover();
  assert.equal(closeCollectionActions(), true, "Back dismisses the menu before its dialog");
  assert.equal(closeCollectionActions(), false);
  get("history-dialog").getBoundingClientRect = () => ({ top: 80, bottom: 240 });
  menu.showPopover();
  assert.equal(menu.dataset.placement, "above");
  get("history-dialog").close();
  assert.equal(menu.popoverOpen, false);
});
