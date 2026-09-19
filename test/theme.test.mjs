import assert from "node:assert/strict";
import test from "node:test";

test("theme toggle updates and persists the selected theme", async (t) => {
  const attributes = new Map();
  const toggle = new EventTarget();
  toggle.setAttribute = (name, value) => attributes.set(name, value);
  const root = { dataset: { theme: "light" }, style: {} };
  const themeColor = { setAttribute: (name, value) => attributes.set(name, value) };
  const values = new Map();
  const globals = {
    document: {
      documentElement: root,
      querySelector: (selector) => (selector === ".theme-toggle" ? toggle : themeColor),
    },
    localStorage: { setItem: (key, value) => values.set(key, value) },
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
  toggle.dispatchEvent(new Event("click"));

  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(attributes.get("aria-pressed"), "true");
  assert.equal(values.get("random-frame-theme"), "dark");
});
