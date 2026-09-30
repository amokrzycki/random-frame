import assert from "node:assert/strict";
import test from "node:test";

test("privacy theme toggle cycles System, Light, Dark and back to System", async (t) => {
  const attributes = new Map();
  const toggle = new EventTarget();
  toggle.dataset = {};
  toggle.setAttribute = (name, value) => attributes.set(name, value);
  const classes = new Set();
  const root = {
    dataset: { theme: "light" },
    style: {},
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
  };
  const themeColor = { setAttribute: (name, value) => attributes.set(name, value) };
  const values = new Map();
  const document = new EventTarget();
  document.documentElement = root;
  document.querySelectorAll = () => [];
  document.querySelector = (selector) =>
    selector === ".theme-toggle" ? toggle : selector === 'meta[name="theme-color"]' ? themeColor : null;
  const globals = {
    document,
    localStorage: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    requestAnimationFrame: (callback) => callback(),
  };
  const original = new Map(
    Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  await import(`../dist/test-client/theme.js?test=${Date.now()}`);
  assert.equal(toggle.dataset.themeChoice, "system");
  toggle.dispatchEvent(new Event("click"));
  assert.equal(toggle.dataset.themeChoice, "light");
  assert.equal(root.dataset.theme, "light");
  toggle.dispatchEvent(new Event("click"));

  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(toggle.dataset.themeChoice, "dark");
  assert.equal(values.get("random-frame-theme"), "dark");
  toggle.dispatchEvent(new Event("click"));
  assert.equal(toggle.dataset.themeChoice, "system");
  assert.equal(values.has("random-frame-theme"), false);
});
