import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("notices follow dialog scope without stealing focus and retain consecutive Undo actions", async (t) => {
  const names = ["document", "window"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const document = new FakeDocument(ids);
  const timers = [];
  const window = Object.assign(new EventTarget(), {
    innerWidth: 800,
    innerHeight: 600,
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
  });
  Object.assign(globalThis, { document, window });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const { toast, setToastScope } = await import(`../dist/test-client/toast.js?test=${Date.now()}`);
  const dialog = document.querySelector("#history-dialog");
  const origin = document.querySelector("#history-filter-favorites");
  origin.focus();
  setToastScope(dialog);
  const layer = dialog.children.find((child) => child.className === "dialog-notice-layer");
  assert.equal(layer.popover, "manual", "top layer escapes dialog clipping and transforms");
  assert.equal(document.activeElement, origin);
  // At enlarged text in a short window, the header gap can be shorter than the notice stack.
  window.innerHeight = 360;
  const name = document.querySelector("#collections-name");
  dialog.append(name);
  const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
  dialog.getBoundingClientRect = () => rect(10, 0, 760, 360);
  name.getBoundingClientRect = () => rect(26, 155, 489, 63);
  layer.getBoundingClientRect = () => rect(285, 154, 469, 108);
  dialog.querySelector = (selector) => ({
    getBoundingClientRect: () => (selector === "header" ? rect(10, 0, 760, 99) : rect(10, 274, 760, 86)),
  });
  name.focus();
  // Re-entering scope exercises the same positioning used after focus and resize.
  setToastScope(dialog);
  assert.equal(layer.style.top, "99px");
  assert.equal(layer.style.maxHeight, "48px", "the notice rail fits above the focused field");
  name.getBoundingClientRect = () => rect(26, 110, 489, 30);
  layer.getBoundingClientRect = () => rect(285, 115, 469, 108);
  setToastScope(dialog);
  assert.equal(layer.style.top, "148px");
  assert.equal(layer.style.maxHeight, "108px", "use the larger gap below focus when it fits the stack");
  dialog.getBoundingClientRect = () => rect(0, 0, 0, 0);
  name.remove();
  origin.focus();
  let first = 0,
    second = 0,
    succeed = false,
    resolve;
  toast.info("First saved frame removed", { label: "Undo", run: () => ++first > 0 });
  toast.info("Second saved frame removed", {
    label: "Undo",
    run: async () => {
      second++;
      await new Promise((done) => {
        resolve = done;
      });
      return succeed;
    },
  });
  toast.success("Collection assignments updated");
  toast.success("Collection renamed");
  const all = () => layer.querySelectorAll("div").filter((item) => item.className.startsWith("toast "));
  assert.equal(all().length, 3, "routine feedback replaces only routine feedback");
  assert.equal(layer.children.filter((region) => region.getAttribute("aria-live") === "polite").length, 1);
  assert.equal(document.activeElement, origin);
  assert.equal(toast.undo(), true);
  toast.undo();
  await flush();
  assert.equal(second, 1, "rapid repeated Undo runs once");
  resolve();
  await flush();
  assert.equal(toast.undo(), true, "failed Undo is retained");
  await flush();
  succeed = true;
  resolve();
  await flush();
  toast.undo();
  await flush();
  assert.equal(first, 1, "the earlier Undo is still available");
  assert.equal(toast.undo(), false);
  setToastScope();
  assert.equal(document.activeElement, origin);
  assert.equal(layer.querySelectorAll("div").filter((item) => item.textContent === "Collection renamed").length, 0);
});
