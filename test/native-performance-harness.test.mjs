import assert from "node:assert/strict";
import test from "node:test";
import { assertNavigationSucceeded } from "../performance/native-navigation.mjs";

function navigation() {
  const context = {
    state: { index: 1, loading: false },
    elements: {
      imageZoom: { hidden: false },
      image: {
        src: "blob:target",
        complete: true,
        naturalWidth: 1920,
        naturalHeight: 1080,
        decode: async () => undefined,
      },
    },
    getViewState: () => "image",
    expectedUrl: "blob:target",
  };
  return context;
}

test("native harness waits for decoding of the displayed target image", async () => {
  const context = navigation();
  let decoded = false;
  context.elements.image.decode = async () => {
    await Promise.resolve();
    decoded = true;
  };
  await assertNavigationSucceeded(1, context);
  assert.equal(decoded, true);
});

test("a swallowed navigation failure cannot count an old valid image as success", async () => {
  const context = navigation();
  // A resolved loader call can leave its previous selection and fully decoded image.
  context.state.index = 0;
  context.elements.image.src = "blob:previous";
  await assert.rejects(assertNavigationSucceeded(1, context), /Native navigation failed/);
});

test("selection persistence failure and decode failure reject native navigation samples", async () => {
  const persistence = navigation();
  persistence.getViewState = () => "error";
  await assert.rejects(assertNavigationSucceeded(1, persistence), /Native navigation failed/);
  const decoding = navigation();
  decoding.elements.image.decode = async () => {
    throw new Error("decode failed");
  };
  await assert.rejects(assertNavigationSucceeded(1, decoding), /decode failed/);
});

test("native navigation requires a shown completed target fixture and settled selection", async () => {
  for (const alter of [
    (c) => {
      c.elements.imageZoom.hidden = true;
    },
    (c) => {
      c.state.loading = true;
    },
    (c) => {
      c.elements.image.complete = false;
    },
    (c) => {
      c.elements.image.src = "data:image/jpeg;base64,placeholder";
    },
    (c) => {
      c.elements.image.naturalWidth = 1;
    },
    (c) => {
      c.elements.image.naturalHeight = 1;
    },
    (c) => {
      c.expectedUrl = undefined;
    },
  ]) {
    const context = navigation();
    alter(context);
    await assert.rejects(assertNavigationSucceeded(1, context), /Native navigation failed/);
  }
});
