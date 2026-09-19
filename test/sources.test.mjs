/** biome-ignore-all lint/suspicious/noEmptyBlockStatements: Test file */
import assert from "node:assert/strict";
import test from "node:test";
import { getRandomAsset, handleRequest, selectSource } from "../dist/server.js";
import { SourceError } from "../dist/sources/types.js";

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
  assert.equal(
    selectSource("mixed", () => 0, registered),
    first,
  );
  assert.equal(
    selectSource("mixed", () => 0.99, registered),
    second,
  );
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

test("skips missing random images until one is available", async () => {
  let attempts = 0;
  const item = { id: "item", source: "fake", mediaUrl: "https://example.test/item.png" };
  const asset = { response: new Response(), contentType: "image/png" };
  const selected = source("fake");
  selected.getRandomItem = async () => item;
  selected.fetchAsset = async () => {
    attempts += 1;
    if (attempts < 5) throw new SourceError("Missing", 404);
    return asset;
  };

  assert.deepEqual(await getRandomAsset(selected), [item, asset]);
  assert.equal(attempts, 5);
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
