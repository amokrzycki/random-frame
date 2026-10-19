import assert from "node:assert/strict";
import test from "node:test";
import { nearbyWindow } from "../dist/test-client/navigation.js";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("Nearby shows borrowed current pixels before acknowledgement and cancels at dismissal start", async () => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  const calls = [];
  let acknowledge;
  globalThis.window = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "set_nearby_window")
          return new Promise((resolve) => {
            acknowledge = () => resolve({ window: nearbyWindow(args.centerId), evidence: { abc123: 1 } });
          });
        if (command === "close_nearby") return null;
        if (command === "load_thumbnail_cache") return [];
        if (command === "save_thumbnail_cache") return null;
        throw new Error(`Unexpected ${command}`);
      },
    },
  });
  globalThis.createImageBitmap = async () => {
    throw Error("not needed");
  };
  const { state } = await import("../dist/test-client/viewer-state.js");
  const { blobs } = await import("../dist/test-client/frame-cache.js");
  const { setState } = await import("../dist/test-client/stage.js");
  const { elements } = await import("../dist/test-client/elements.js");
  const { bindNearbyEvents, openNearby } = await import("../dist/test-client/nearby-dialog.js");
  const { dismissTopLayer } = await import("../dist/test-client/dialogs.js");
  const url = URL.createObjectURL(new Blob([new Uint8Array([1])]));
  blobs.set("prntsc:abc123", { url, blob: new Blob([new Uint8Array([1])]) });
  state.history = [{ source: "prntsc", id: "abc123", sourcePageUrl: "https://prnt.sc/abc123", viewedAt: 1 }];
  state.index = 0;
  state.loading = false;
  state.navigationMode = "favourites";
  setState("image");
  bindNearbyEvents();
  openNearby();
  assert.equal(elements.nearbyDialog.open, true);
  assert.equal(elements.nearbyGrid.children.length, 9);
  const current = elements.nearbyGrid.children[4].children[0];
  assert.equal(current.getAttribute("aria-current"), "true");
  assert.equal(current.children[0].children[0].src, url);
  assert.equal(document.activeElement, elements.nearbyClose);
  assert.equal(calls.filter((x) => x.command === "resolve_nearby_frame").length, 0);
  assert.equal(dismissTopLayer(), true);
  assert.ok(calls.some((x) => x.command === "close_nearby"));
  acknowledge();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((x) => x.command === "resolve_nearby_frame").length, 0);
  assert.equal(state.navigationMode, "favourites");
  assert.equal(document.activeElement, elements.frameMenuButton);
  assert.equal((await import("node:buffer")).resolveObjectURL(url).size, 1);
  URL.revokeObjectURL(url);
});
