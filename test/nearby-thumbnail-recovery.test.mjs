import assert from "node:assert/strict";
import test from "node:test";
import { nearbyWindow } from "../dist/test-client/navigation.js";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("an expired Nearby handle re-resolves once, while a repeated miss stays retryable", async () => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  let reads = 0;
  let resolves = 0;
  let alwaysMiss = false;
  globalThis.window = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (command === "set_nearby_window")
          return {
            window: nearbyWindow(args.centerId),
            evidence: Object.fromEntries(
              nearbyWindow(args.centerId)
                .slots.filter((x) => x.id)
                .map((x) => [x.id, ["abc123", "abc124"].includes(x.id) ? 1 : 2]),
            ),
          };
        if (command === "resolve_nearby_frame") {
          resolves++;
          return {
            state: "available",
            source: "prntsc",
            id: args.id,
            sourcePageUrl: "",
            thumbnailHandle: String(resolves),
          };
        }
        if (command === "get_nearby_thumbnail") {
          if (++reads === 1 || alwaysMiss) throw { kind: "not-found", message: "Preview cache miss" };
          return new Uint8Array([1]).buffer;
        }
        if (command === "load_thumbnail_cache") return [];
        if (["save_thumbnail_cache", "close_nearby"].includes(command)) return null;
        throw new Error(command);
      },
    },
  });
  const { state } = await import("../dist/test-client/viewer-state.js");
  const { blobs, thumbnails } = await import("../dist/test-client/frame-cache.js");
  const { setState } = await import("../dist/test-client/stage.js");
  const { elements } = await import("../dist/test-client/elements.js");
  const { openNearby } = await import("../dist/test-client/nearby-dialog.js");
  const { closeDialog } = await import("../dist/test-client/dialogs.js");
  const blob = new Blob([new Uint8Array([1])]);
  const url = URL.createObjectURL(blob);
  blobs.set("prntsc:abc123", { blob, url });
  state.history = [{ source: "prntsc", id: "abc123", sourcePageUrl: "", viewedAt: 1 }];
  state.index = 0;
  state.loading = false;
  setState("image");
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  openNearby();
  await settle();
  assert.equal(resolves, 2);
  assert.equal(reads, 2);
  assert.ok(thumbnails.has("prntsc:abc124"));
  closeDialog(elements.nearbyDialog);
  await settle();
  thumbnails.delete("prntsc:abc124");
  alwaysMiss = true;
  reads = resolves = 0;
  openNearby();
  await settle();
  assert.equal(resolves, 2, "a second cache miss cannot loop");
  assert.equal(reads, 2);
  assert.equal(elements.nearbyGrid.children[5].children[0].dataset.state, "retryable");
  closeDialog(elements.nearbyDialog);
  await settle();
  const invalid = "data:image/jpeg;base64,/w==";
  thumbnails.set("prntsc:abc124", invalid);
  alwaysMiss = false;
  reads = resolves = 0;
  openNearby();
  await settle();
  assert.equal(resolves, 2, "invalid cached pixels must not skip preview recovery");
  assert.notEqual(thumbnails.get("prntsc:abc124"), invalid);
  assert.equal(elements.nearbyGrid.children[5].children[0].dataset.state, "ready");
  closeDialog(elements.nearbyDialog);
  await settle();
  URL.revokeObjectURL(url);
});
