import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

test("dialogs contain focus and suspend titlebar tools", async (t) => {
  const document = new FakeDocument(ids);
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = document;
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete globalThis.document;
  });

  const { bindDialogChromeEvents, onDialogClosed, openDialog } = await import(
    `../dist/test-client/dialogs.js?test=${Date.now()}`
  );
  const get = (id) => document.querySelector(`#${id}`);
  const consent = get("entry-consent");
  const leave = get("leave-button");
  const entry = get("entry-dialog");
  const titlebarTool = get("stats-button");
  entry.contains = (node) => [entry, consent, leave].includes(node);
  entry.querySelectorAll = () => [consent, leave];
  for (const item of [consent, leave]) {
    item.matches = () => false;
    item.getClientRects = () => [1];
    item.hasAttribute = () => false;
  }
  bindDialogChromeEvents();
  entry.addEventListener("close", onDialogClosed);

  openDialog(entry);
  assert.equal(get("main-content").inert, true);
  assert.equal(get("masthead-tools").inert, true);
  assert.equal(document.activeElement, consent);

  const tab = (shiftKey) => {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperties(event, { key: { value: "Tab" }, shiftKey: { value: shiftKey } });
    document.dispatchEvent(event);
    return event;
  };
  leave.focus();
  assert.equal(tab(false).defaultPrevented, true);
  assert.equal(document.activeElement, consent);
  assert.equal(tab(true).defaultPrevented, true);
  assert.equal(document.activeElement, leave);

  document.activeElement = titlebarTool;
  const stray = new Event("focusin");
  Object.defineProperty(stray, "target", { value: titlebarTool });
  document.dispatchEvent(stray);
  assert.equal(document.activeElement, consent);

  entry.close();
  assert.equal(get("main-content").inert, false);
  assert.equal(get("masthead-tools").inert, false);
  assert.equal(get("dialog-backdrop").hidden, true);
});
