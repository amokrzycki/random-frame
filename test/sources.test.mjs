import test from "node:test";
import assert from "node:assert/strict";
import { getRandomAsset, handleRequest, selectSource } from "../dist/server.js";

function source(id, available = true) {
  return {
    id,
    available,
    async getRandomItem() {},
    async fetchAsset() {},
  };
}

test("selects explicit, mixed, unknown, and unavailable sources", () => {
  const first = source("first");
  const second = source("second");
  const unavailable = source("later", false);
  const registered = [first, unavailable, second];

  assert.equal(selectSource("second", Math.random, registered), second);
  assert.equal(selectSource("mixed", () => 0, registered), first);
  assert.equal(selectSource("mixed", () => 0.99, registered), second);
  assert.throws(() => selectSource("unknown", Math.random, registered), /Unknown source/);
  assert.throws(() => selectSource("later", Math.random, registered), /not available yet/);
  assert.equal(selectSource().id, "prntsc");
});

test("delegates item resolution and asset fetching to the selected source", async () => {
  const calls = [];
  const item = { id: "item", source: "fake", mediaUrl: "https://example.test/item.png" };
  const asset = { response: new Response(), contentType: "image/png" };
  const selected = source("fake");
  selected.getRandomItem = async () => {
    calls.push("item");
    return item;
  };
  selected.fetchAsset = async (received) => {
    calls.push(received);
    return asset;
  };

  assert.deepEqual(await getRandomAsset(selected), [item, asset]);
  assert.deepEqual(calls, ["item", item]);
});

test("reports unknown and not-yet-available source query values", async () => {
  async function status(url) {
    let value;
    await handleRequest(
      { url },
      {
        headersSent: false,
        writeHead(code) {
          value = code;
          this.headersSent = true;
        },
        end() {},
      },
    );
    return value;
  }

  assert.equal(await status("/api/random?source=unknown"), 400);
  assert.equal(await status("/api/random?source=internet-archive"), 501);
});
