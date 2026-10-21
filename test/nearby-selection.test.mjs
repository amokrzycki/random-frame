import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("full-image Nearby selection preserves intent through image failure, retry and acceptance", async () => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  globalThis.createImageBitmap = async () => ({
    width: 1,
    height: 1,
    close() {
      /* No bitmap allocation in this command-boundary test. */
    },
  });
  const calls = [];
  let fail = true;
  const original = { source: "prntsc", id: "abc123", sourcePageUrl: "https://prnt.sc/abc123", viewedAt: 1 };
  const other = { source: "prntsc", id: "abc124", sourcePageUrl: "https://prnt.sc/abc124", viewedAt: 2 };
  globalThis.window = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "get_frame_by_id") return { ...other, mimeType: "image/png" };
        if (command === "get_frame_image") {
          if (fail) {
            fail = false;
            throw { kind: "not-found", message: "Missing asset" };
          }
          return new Uint8Array([1]).buffer;
        }
        if (command === "record_nearby_history_item") return { history: [original, other], index: 1 };
        if (command === "load_thumbnail_cache") return [];
        if (command === "save_thumbnail_cache") return null;
        throw new Error(`Unexpected ${command}`);
      },
    },
  });
  const { state } = await import("../dist/test-client/viewer-state.js");
  const { openNearbyFrame } = await import("../dist/test-client/frame-loader.js");
  const { setState, retryFailed } = await import("../dist/test-client/stage.js");
  state.history = [original];
  state.index = 0;
  state.loading = false;
  state.navigationMode = "favourites";
  setState("image");
  await openNearbyFrame("abc124");
  assert.equal(state.history.length, 1);
  assert.equal(calls.filter((x) => x.command.includes("record")).length, 0);
  retryFailed();
  for (let i = 0; i < 50 && !calls.some((x) => x.command === "record_nearby_history_item"); i++) await tick();
  assert.equal(calls.filter((x) => x.command === "record_nearby_history_item").length, 1);
  for (const call of calls.filter((x) => ["get_frame_by_id", "get_frame_image"].includes(x.command)))
    assert.equal(call.args.intent, "nearby");
  assert.equal(state.navigationMode, "history");
  assert.ok(!calls.some((x) => x.command === "record_history_item"));
});
