import assert from "node:assert/strict";
import test from "node:test";

const freshPool = (name) => import(`../dist/test-client/loading-copy.js?${encodeURIComponent(name)}`);

test("loading copy keeps its weights, doubles the pool, and fits the caption", async () => {
  const { loadingMessages } = await freshPool("copy");
  assert.deepEqual(
    loadingMessages.map(({ category, weight }) => [category, weight]),
    [
      ["neutral", 72],
      ["archive", 23],
      ["playful", 4],
      ["easterEgg", 1],
    ],
  );
  const all = loadingMessages.flatMap(({ messages }) => messages);
  assert.ok(all.length >= 1268);
  const normalized = all.map((message) =>
    message
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, "")
      .trim(),
  );
  assert.equal(new Set(normalized).size, all.length);
  assert.ok(all.every((message) => message.length > 0 && message.length <= 52));
  assert.ok(all.filter((message) => message.length <= 38).length / all.length > 0.9);
});

test("100 recent captions stay excluded across draws and eventually return", async (t) => {
  const { loadingMessages, pickLoadingMessage } = await freshPool("history");
  t.mock.method(Math, "random", () => 0);
  const shown = [];
  const excluded = loadingMessages[0].messages.slice(0, 3);
  for (let i = 0; i < 350; i++) {
    const message = pickLoadingMessage(excluded);
    assert.ok(!shown.slice(-100).includes(message), `Recent caption repeated: ${message}`);
    assert.ok(!excluded.includes(message));
    shown.push(message);
  }
  assert.equal(shown[101], shown[0]);
});

test("jokes have a quiet caption between them and unavailable pools are skipped", async (t) => {
  const { loadingMessages, pickLoadingMessage } = await freshPool("cooldown");
  t.mock.method(Math, "random", () => 0.999999);
  const categoryOf = (message) => loadingMessages.find((pool) => pool.messages.includes(message)).category;
  const isJoke = (category) => category === "playful" || category === "easterEgg";
  let previous = "";
  for (let i = 0; i < 100; i++) {
    const category = categoryOf(pickLoadingMessage([]));
    assert.ok(!(isJoke(category) && isJoke(previous)));
    previous = category;
  }
  Math.random.mock.mockImplementation(() => 0);
  const exclude = loadingMessages[0].messages;
  assert.equal(categoryOf(pickLoadingMessage(exclude)), "archive");
  const all = loadingMessages.flatMap((pool) => pool.messages);
  const first = pickLoadingMessage(all);
  const second = pickLoadingMessage(all);
  assert.ok(all.includes(first) && all.includes(second));
  assert.notEqual(first, second);
});

test("quiet captions dominate with deterministic random sampling", async (t) => {
  const { loadingMessages, pickLoadingMessage } = await freshPool("distribution");
  let seed = 42;
  t.mock.method(Math, "random", () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  });
  const categories = new Map(
    loadingMessages.flatMap((pool) => pool.messages.map((message) => [message, pool.category])),
  );
  const counts = Object.fromEntries(loadingMessages.map((pool) => [pool.category, 0]));
  for (let i = 0; i < 20000; i++) counts[categories.get(pickLoadingMessage([]))]++;
  for (const [category, probability] of [
    ["neutral", 0.7218],
    ["archive", 0.2306],
    ["playful", 0.0381],
    ["easterEgg", 0.0095],
  ])
    assert.ok(Math.abs(counts[category] / 20000 - probability) < 0.01, `${category}: ${counts[category]}`);
});
