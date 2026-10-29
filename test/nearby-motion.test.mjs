import assert from "node:assert/strict";
import test from "node:test";
import { nearbyWindow } from "../dist/test-client/navigation.js";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("Nearby cancels pending shift cues on resize, visibility and motion preference changes", async (t) => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  const preference = Object.assign(new EventTarget(), { matches: false });
  globalThis.matchMedia = () => preference;
  const requests = [];
  globalThis.window = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (command === "set_nearby_window")
          return new Promise((resolve) => {
            const window = nearbyWindow(args.centerId);
            requests.push(() =>
              resolve({
                window,
                evidence: Object.fromEntries(window.slots.map((slot) => [slot.id, slot.id === "abc123" ? 1 : 2])),
              }),
            );
          });
        if (command === "close_nearby") return null;
        if (command === "load_thumbnail_cache") return [];
        throw Error(`Unexpected ${command}`);
      },
    },
  });
  const { state } = await import("../dist/test-client/viewer-state.js");
  const { blobs } = await import("../dist/test-client/frame-cache.js");
  const { setState } = await import("../dist/test-client/stage.js");
  const { elements } = await import("../dist/test-client/elements.js");
  const { bindNearbyEvents, openNearby } = await import("../dist/test-client/nearby-dialog.js");
  const { dismissTopLayer } = await import("../dist/test-client/dialogs.js");
  const blob = new Blob([new Uint8Array([1])]);
  const url = URL.createObjectURL(blob);
  t.after(() => URL.revokeObjectURL(url));
  blobs.set("prntsc:abc123", { url, blob });
  state.history = [{ source: "prntsc", id: "abc123", sourcePageUrl: "https://prnt.sc/abc123", viewedAt: 1 }];
  state.index = 0;
  state.loading = false;
  setState("image");
  bindNearbyEvents();
  const cues = [];
  elements.nearbyGrid.animate = () => {
    const cue = {
      canceled: false,
      cancel() {
        this.canceled = true;
      },
    };
    cues.push(cue);
    return cue;
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const acknowledge = async () => {
    requests.shift()();
    await tick();
  };
  openNearby();
  await acknowledge();

  elements.nearbyNext.click();
  window.dispatchEvent(new Event("resize"));
  await acknowledge();
  assert.equal(cues.length, 0);

  elements.nearbyNext.click();
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await acknowledge();
  assert.equal(cues.length, 0);
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await acknowledge();

  elements.nearbyNext.click();
  preference.matches = true;
  preference.dispatchEvent(new Event("change"));
  preference.matches = false;
  preference.dispatchEvent(new Event("change"));
  await acknowledge();
  assert.equal(cues.length, 0);

  elements.nearbyNext.click();
  await acknowledge();
  assert.equal(cues.length, 1);
  window.dispatchEvent(new Event("resize"));
  assert.equal(cues[0].canceled, true);
  dismissTopLayer();
});
