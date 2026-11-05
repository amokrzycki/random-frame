import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("source-link rejection shows one live error, preserves the frame and allows a successful retry", async (t) => {
  const document = new FakeDocument(ids);
  const window = Object.assign(new EventTarget(), { setTimeout: () => 0 });
  const originals = new Map(
    ["document", "window", "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.assign(globalThis, { document, window, localStorage: new FakeStorage() });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let reject = true;
  const calls = [];
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "plugin:clipboard-manager|write_text" && reject) throw new Error("Disposable rejection");
    },
  };
  const { state } = await import("../dist/test-client/viewer-state.js");
  const { bindFrameActionEvents } = await import("../dist/test-client/frame-actions.js");
  const get = (id) => document.querySelector(`#${id}`);
  get("source-link").href = "https://prnt.sc/fixture";
  get("image").src = "blob:fixture";
  state.history = [{ source: "prntsc", id: "fixture", sourcePageUrl: get("source-link").href, viewedAt: 1 }];
  state.index = 0;
  const snapshot = () => structuredClone({ history: state.history, index: state.index, favorites: state.favorites });
  const before = snapshot();
  bindFrameActionEvents();
  get("copy-link-button").click();
  await flush();
  const errorRegion = document.body.children.find((node) => node.getAttribute("aria-live") === "assertive");
  const error = errorRegion?.children.find((node) => node.className === "toast toast--error");
  assert.ok(error, "clipboard rejection must produce visible feedback, not just hidden announcer text");
  assert.match(error.textContent, /could not copy/i);
  assert.match(error.textContent, /try again|source page/i, "the error offers a recovery path");
  assert.equal(get("announcer").textContent, "", "the toast live region owns the error announcement");
  assert.equal(errorRegion.children.length, 1);
  assert.deepEqual(snapshot(), before);
  assert.equal(get("image").src, "blob:fixture");
  assert.equal(get("source-link").href, "https://prnt.sc/fixture");
  reject = false;
  get("copy-link-button").click();
  await flush();
  assert.ok(
    document.body.children.some((region) => region.children.some((node) => node.textContent === "Copied source link")),
  );
  assert.equal(errorRegion.children.length, 0, "success replaces the routine error");
  assert.deepEqual(
    calls.map((call) => call.command),
    Array(2).fill("plugin:clipboard-manager|write_text"),
  );
  assert.ok(calls.every((call) => call.args.text === get("source-link").href));
  assert.deepEqual(snapshot(), before);
});
