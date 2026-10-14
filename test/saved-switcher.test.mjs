import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

test("collection switcher keeps navigation distinct from selection and survives refreshed choices", async (t) => {
  const originals = new Map(
    ["document", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const document = new FakeDocument(ids);
  const window = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
  Object.assign(globalThis, { document, window });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const get = (id) => document.querySelector(`#${id}`);
  const trigger = get("saved-filter"),
    menu = get("saved-filter-menu");
  trigger.getBoundingClientRect = () => ({ top: 180, bottom: 218, left: 44, right: 344, width: 300 });
  get("history-dialog").getBoundingClientRect = () => ({ top: 80, bottom: 520 });
  for (const [method, state] of [
    ["showPopover", "open"],
    ["hidePopover", "closed"],
  ])
    menu[method] = () => {
      const event = new Event("beforetoggle");
      event.newState = state;
      menu.dispatchEvent(event);
      menu.popoverOpen = state === "open";
    };
  const { bindSavedSwitcher, renderSavedSwitcher, closeSavedSwitcher } = await import(
    "../dist/test-client/saved-switcher.js"
  );
  let choices = [
    { value: "all", label: "All saved" },
    { value: "one", label: "Favourite" },
    { value: "two", label: "People and places — a long collection name" },
    { value: "three", label: "Photographs" },
  ];
  const changes = [];
  trigger.addEventListener("change", () => {
    changes.push(trigger.value);
    renderSavedSwitcher(choices, trigger.value);
  });
  bindSavedSwitcher();
  renderSavedSwitcher(choices, "one");
  trigger.focus();
  const key = (value, extra = {}) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key: value, ...extra });
    trigger.dispatchEvent(event);
    return event;
  };
  key("ArrowDown");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("aria-activedescendant"), "saved-filter-option-1");
  assert.equal(menu.style.width, "300px");
  assert.equal(menu.style.top, "224px");
  assert.equal(menu.style.maxHeight, "284px");
  key("ArrowDown");
  assert.equal(trigger.value, "one", "arrow navigation never silently applies a filter");
  assert.equal(menu.children[2].hasAttribute("data-active"), true);
  assert.equal(menu.children[1].getAttribute("aria-selected"), "true");
  key("Escape");
  assert.equal(menu.popoverOpen, false);
  assert.equal(trigger.value, "one");
  assert.equal(document.activeElement, trigger);
  key("Enter");
  menu.clientHeight = 120;
  key("PageDown");
  assert.equal(menu.children[3].hasAttribute("data-active"), true, "Page Down navigates a visible page");
  key("PageUp");
  assert.equal(menu.children[0].hasAttribute("data-active"), true);
  key("End");
  key("Home");
  key("Enter");
  assert.deepEqual(changes, ["all"]);
  assert.equal(get("saved-filter-value").textContent, "All saved");
  // Typeahead selects on the closed trigger, and only navigates an open list.
  key("p");
  assert.equal(trigger.value, "two");
  key("p");
  assert.equal(trigger.value, "three");
  key("Enter");
  key("Home");
  choices = choices.filter((choice) => choice.value !== "one");
  renderSavedSwitcher(choices, "three");
  assert.equal(menu.children[0].hasAttribute("data-active"), true, "Sync preserves the highlighted key");
  key("Tab");
  assert.equal(menu.popoverOpen, false);
  assert.equal(trigger.value, "three");
  trigger.click();
  menu.children[1].click();
  assert.equal(trigger.value, "two", "pointer picks use the same selection path");
  assert.equal(document.activeElement, trigger);
  trigger.click();
  assert.equal(closeSavedSwitcher(), true, "Android Back can dismiss only this layer");
  assert.equal(closeSavedSwitcher(), false);
  // A short window flips once above the trigger, staying inside the dialog.
  get("history-dialog").getBoundingClientRect = () => ({ top: 80, bottom: 240 });
  trigger.click();
  assert.equal(menu.dataset.placement, "above");
  assert.equal(menu.style.bottom, "426px");
  assert.equal(menu.style.maxHeight, "82px");
});
