import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const texts = (node) => [node.textContent, ...(node.children ?? []).flatMap(texts)];

test("Android saves through a content URI and only reports success once the file is written", async (t) => {
  const document = new FakeDocument(ids);
  const window = new EventTarget();
  window.setTimeout = () => 0;
  const calls = [];
  let picked = "content://com.android.providers.downloads.documents/document/42";
  let writeFails = false;
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "get_platform_capabilities")
        return { platform: "android", sync: true, desktopWindowControls: false, updater: false, imageClipboard: false };
      if (command === "plugin:dialog|save") return picked;
      if (command === "plugin:fs|write_file" && writeFails) throw new Error("provider refused");
      return null;
    },
  };
  const originals = new Map(
    ["document", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.assign(globalThis, { document, window });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const { initializePlatform } = await import("../dist/test-client/platform.js");
  const { saveImage } = await import("../dist/test-client/image-actions.js");
  await initializePlatform();
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

  assert.equal(await saveImage("abc123", blob), true);
  assert.equal(
    calls.find((call) => call.command === "plugin:dialog|save").args.options.defaultPath,
    "random-frame-prntsc-abc123.png",
  );
  assert.ok(calls.some((call) => call.command === "plugin:fs|write_file"));
  const shown = texts(document.body);
  assert.ok(shown.includes("Saved image"));
  // A content URI has no folder to show.
  assert.equal(shown.includes("Show in folder"), false);

  calls.length = 0;
  picked = null;
  assert.equal(await saveImage("abc123", blob), false, "a cancelled picker is not a save");
  assert.equal(
    calls.some((call) => call.command === "plugin:fs|write_file"),
    false,
  );

  picked = "content://com.android.providers.downloads.documents/document/43";
  writeFails = true;
  assert.equal(await saveImage("abc123", blob), false, "a refused write is not a save");
  await flush();
});

test("clipboard copies release decoded and native images on success and failure", async (t) => {
  const document = new FakeDocument(ids);
  const window = new EventTarget();
  window.setTimeout = () => 0;
  const originals = new Map(
    ["document", "window", "createImageBitmap"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const rgba = new Uint8ClampedArray([11, 22, 33, 255]);
  const { copyImage } = await import("../dist/test-client/image-actions.js");
  const createElement = document.createElement.bind(document);
  for (const failure of [null, "canvas", "plugin:image|new", "plugin:clipboard-manager|write_image"]) {
    const calls = [];
    const requests = new Map();
    const bitmap = { width: 1, height: 1, close: () => calls.push("bitmap.close") };
    document.createElement = (tag) =>
      tag === "canvas"
        ? {
            getContext: () =>
              failure === "canvas"
                ? null
                : {
                    drawImage: (image) => assert.equal(image, bitmap),
                    getImageData: () => ({ data: rgba }),
                  },
          }
        : createElement(tag);
    window.__TAURI_INTERNALS__ = {
      async invoke(command, args) {
        calls.push(command);
        requests.set(command, args);
        if (command === failure) throw new Error("copy failed");
        if (command === "plugin:image|new") return 42;
        return null;
      },
    };
    Object.assign(globalThis, { document, window, createImageBitmap: async () => bitmap });
    await copyImage(new Blob(["image"]));
    if (failure !== "canvas")
      assert.deepEqual(requests.get("plugin:image|new"), { rgba: new Uint8Array(rgba), width: 1, height: 1 });
    if (failure !== "canvas" && failure !== "plugin:image|new") {
      assert.equal(requests.get("plugin:clipboard-manager|write_image").image, 42);
      assert.equal(requests.get("plugin:resources|close").rid, 42);
    }
    assert.equal(texts(document.body).includes("Copied image to clipboard"), failure === null);
    assert.equal(calls.at(-1), "bitmap.close", String(failure));
    assert.equal(calls.filter((call) => call === "bitmap.close").length, 1);
    assert.equal(
      calls.filter((call) => call === "plugin:resources|close").length,
      failure === "canvas" || failure === "plugin:image|new" ? 0 : 1,
      String(failure),
    );
    if (!failure)
      assert.ok(calls.indexOf("plugin:resources|close") > calls.indexOf("plugin:clipboard-manager|write_image"));
  }
});
