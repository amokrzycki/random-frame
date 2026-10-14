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
