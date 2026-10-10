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

  const { bindDialogChromeEvents, dismissTopLayer, onDialogClosed, openDialog, refreshDialogBoundary } = await import(
    `../dist/test-client/dialogs.js?test=${Date.now()}`
  );
  const get = (id) => document.querySelector(`#${id}`);
  const consent = get("entry-consent");
  const leave = get("leave-button");
  const entry = get("entry-dialog");
  const history = get("history-dialog");
  const all = get("history-filter-all");
  const favorites = get("history-filter-favorites");
  const close = get("history-close-button");
  const titlebarTool = get("stats-button");
  entry.contains = (node) => [entry, consent, leave].includes(node);
  entry.querySelectorAll = () => [consent, leave];
  for (const item of [consent, leave, all, favorites, close]) {
    item.matches = (selector) => selector.includes('[tabindex="-1"]') && item.getAttribute("tabindex") === "-1";
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

  // An inactive tab remains programmatically focusable, but is outside the Tab cycle.
  all.setAttribute("tabindex", "-1");
  history.contains = (node) => [history, all, favorites, close].includes(node);
  history.querySelectorAll = () => [all, favorites, close];
  openDialog(history);
  assert.equal(document.activeElement === favorites, true, "Initial focus skips the inactive tab");
  close.focus();
  assert.equal(tab(false).defaultPrevented, true);
  assert.equal(document.activeElement === favorites, true, "Tab wraps to the selected tab");
  assert.equal(tab(true).defaultPrevented, true);
  assert.equal(document.activeElement === close, true, "Shift+Tab wraps from the selected tab");
  // Opening order defines the top layer; covered dialogs are inert until the child closes.
  history.addEventListener("close", onDialogClosed);
  close.focus();
  openDialog(entry);
  assert.equal(history.inert, true);
  assert.equal(entry.inert, false);
  assert.equal(entry.getAttribute("aria-modal"), "true");
  assert.equal(dismissTopLayer(), false, "consent cannot be escaped through Android Back");
  entry.close();
  await Promise.resolve();
  assert.equal(history.inert, false);
  assert.equal(document.activeElement, close, "nested close restores the parent control");
  const shell = document.createElement("div");
  const minimize = document.createElement("button");
  minimize.getClientRects = () => [1];
  minimize.matches = () => false;
  shell.append(minimize);
  shell.querySelectorAll = () => [minimize];
  const query = document.querySelector.bind(document);
  document.querySelector = (selector) => (selector === "#window-controls" ? shell : query(selector));
  refreshDialogBoundary();
  assert.equal(history.getAttribute("aria-modal"), null, "an interactive desktop shell is outside the modal boundary");
  minimize.focus();
  assert.equal(tab(false).defaultPrevented, true);
  assert.equal(document.activeElement, favorites, "window controls participate in the keyboard cycle");
  tab(true);
  assert.equal(document.activeElement, minimize);
  history.close();
});
