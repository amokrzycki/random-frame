import { resolveObjectURL } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Minimal DOM and storage doubles for importing the client app under node:test.
class FakeElement extends EventTarget {
  constructor(document, tag = "div") {
    super();
    this.document = document;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.checked = false;
    this.value = "";
    this.src = "";
    this.href = "";
    this.textContent = "";
  }

  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }

  remove() {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = undefined;
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = undefined;
    this.children = [];
    this.append(...children);
  }

  get isConnected() {
    return this.connectedOverride ?? (this.document.elements?.has(`#${this.id}`) || Boolean(this.parentElement));
  }

  set isConnected(value) {
    this.connectedOverride = value;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  toggleAttribute(name, force = !this.attributes.has(name)) {
    if (force) this.attributes.set(name, "");
    else this.attributes.delete(name);
    return force;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  contains(node) {
    return this === node || this.children.some((child) => child.contains?.(node));
  }

  querySelectorAll(selector) {
    const all = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    return all.filter(
      (child) =>
        selector === "*" ||
        selector.split(",").some((part) => part.trim().split("[")[0].toUpperCase() === child.tagName),
    );
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  matches(selector) {
    if (selector.includes(":disabled") && this.disabled) return true;
    if (selector.includes('[tabindex="-1"]') && this.tabIndex === -1) return true;
    if (selector === ":popover-open") return Boolean(this.popoverOpen);
    return false;
  }
  getClientRects() {
    return this.hidden ? [] : [this.getBoundingClientRect()];
  }

  animate() {
    // The loading frame's animation is outside these tests.
  }

  // Blobs whose first byte is 255 stand in for images that will not decode.
  async decode() {
    const [first] = new Uint8Array(await resolveObjectURL(this.src).arrayBuffer());
    if (first === 255) throw new Error("EncodingError");
  }

  focus() {
    this.document.activeElement = this;
  }

  click() {
    this.dispatchEvent(new Event("click"));
  }

  show() {
    this.open = true;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  }

  setCustomValidity() {
    // Form validation is outside this history-flow test.
  }

  reportValidity() {
    // Form validation is outside this history-flow test.
  }

  get offsetWidth() {
    return 1;
  }
}

export class FakeDocument extends EventTarget {
  constructor(ids) {
    super();
    this.activeElement = null;
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const tags = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)].map((match) => [match[2], match[1]]));
    this.elements = new Map(ids.map((id) => [`#${id}`, new FakeElement(this, tags.get(id))]));
    const lightboxClasses = new Set();
    this.elements.get("#lightbox-view").classList = {
      contains: (name) => lightboxClasses.has(name),
      toggle: (name, force) => {
        if (force) lightboxClasses.add(name);
        else lightboxClasses.delete(name);
      },
    };
    this.elements.get("#collection-manage-apply").classList = {
      toggle() {
        /* Visual class changes are outside this DOM double. */
      },
    };
    for (const [selector, element] of this.elements) element.id = selector.slice(1);
    this.body = new FakeElement(this);
    this.documentElement = new FakeElement(this);
    this.elements.get("#history-clear-button").textContent = "Clear history & stats";
    this.elements.get("#history-clear-favorites-button").textContent = "Clear all saved";
  }

  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  querySelectorAll() {
    return [];
  }

  createElement(tag) {
    const element = new FakeElement(this, tag);
    element.classList = {
      add() {
        /* No CSS animations in the DOM double. */
      },
      toggle() {
        /* Visual class changes are outside this DOM double. */
      },
      contains() {
        return false;
      },
    };
    return element;
  }
}

export class FakeStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

// Native capabilities for desktop flows; window controls have their own test.
export const testCapabilities = {
  platform: "linux",
  sync: true,
  desktopWindowControls: false,
  updater: true,
  imageClipboard: true,
};

export const ids = [
  "image",
  "image-zoom",
  "image-ghost",
  "lightbox-dialog",
  "lightbox-image",
  "lightbox-view",
  "lightbox-caption",
  "lightbox-zoom-button",
  "lightbox-zoom-in",
  "lightbox-zoom-out",
  "lightbox-favorite",
  "lightbox-save",
  "lightbox-previous",
  "lightbox-next",
  "lightbox-close-button",
  "empty-state",
  "loading-state",
  "loading-message",
  "loading-frame",
  "error-state",
  "error-title",
  "error-message",
  "retry-button",
  "back-button",
  "previous-button",
  "next-button",
  "save-button",
  "copy-image-button",
  "copy-link-button",
  "source-link",
  "previous-id-button",
  "next-id-button",
  "jump-form",
  "jump-input",
  "frame-count-total",
  "favorite-button",
  "history-tool-button",
  "remove-frame-button",
  "history-dialog",
  "history-close-button",
  "history-clear-group",
  "history-clear-favorites-group",
  "history-clear-button",
  "history-clear-favorites-button",
  "history-filter-all",
  "history-filter-favorites",
  "history-grid",
  "history-empty",
  "history-empty-title",
  "history-empty-detail",
  "history-body",
  "history-pager",
  "history-pager-nav",
  "history-range",
  "history-page",
  "history-page-jump",
  "history-page-input",
  "history-page-previous",
  "history-page-next",
  "history-page-size",
  "stats-button",
  "sync-button",
  "sync-dialog",
  "sync-close",
  "sync-done",
  "sync-status",
  "sync-status-detail",
  "sync-last-synced",
  "sync-scope",
  "sync-error",
  "sync-error-message",
  "sync-retry",
  "sync-unpaired",
  "sync-enable",
  "sync-show-join",
  "sync-join-form",
  "sync-join-actions",
  "sync-recovery-input",
  "sync-join",
  "sync-join-fresh",
  "sync-join-modes",
  "sync-join-title",
  "sync-join-local",
  "sync-join-restore",
  "sync-join-merge",
  "sync-join-merge-deletions",
  "sync-join-cancel",
  "sync-recovery",
  "sync-recovery-key",
  "sync-copy-key",
  "sync-key-confirm",
  "sync-key-saved",
  "sync-paired",
  "sync-dirty",
  "sync-name-form",
  "sync-name-input",
  "sync-name-error",
  "sync-devices",
  "sync-show-key",
  "sync-now",
  "sync-leave",
  "sync-leave-confirm",
  "sync-leave-cancel",
  "sync-leave-confirm-button",
  "shortcuts-button",
  "shortcuts-dialog",
  "shortcuts-close-button",
  "stats-dialog",
  "stats-close-button",
  "stats-today",
  "stats-total",
  "stats-streak",
  "stats-explored",
  "stats-explored-breakdown",
  "announcer",
  "changelog-button",
  "changelog-dialog",
  "changelog-version",
  "changelog-body",
  "changelog-done",
  "entry-dialog",
  "entry-consent",
  "entry-button",
  "leave-button",
  "main-content",
  "masthead-tools",
  "dialog-backdrop",
  "image-id-value",
  "tools-menu",
  "tools-menu-button",
  "frame-menu",
  "frame-menu-button",
  "info-actions",
  "frame-count-current",
  "position-button",
  "jump-total",
  "draw-button",
  "draw-label",
  "stats-body",
  "ledger-list",
  "ledger-empty",
  "ledger-more",
  "ledger",
  "stats-error",
  "stats-retry",
  "remove-saved-button",
  "saved-toolbar",
  "saved-filter",
  "saved-filter-value",
  "saved-filter-menu",
  "collection-create",
  "collection-rename",
  "collection-delete",
  "collections-dialog",
  "collections-close",
  "collections-form",
  "collections-frame",
  "collections-choices",
  "collections-name",
  "collections-name-error",
  "collections-add",
  "collections-error",
  "collections-reopen",
  "collections-cancel",
  "collections-apply",
  "collections-remove",
  "collections-move",
  "collections-move-target",
  "collections-move-button",
  "collection-manage-dialog",
  "collection-manage-title",
  "collection-manage-copy",
  "collection-manage-field",
  "collection-manage-name",
  "collection-manage-error",
  "collection-manage-form",
  "collection-manage-cancel",
  "collection-manage-apply",
  "sync-upgrade",
  "sync-upgrade-later",
  "sync-upgrade-confirm",
];

// Native thumbnail commands shared by client integration tests.
export function fakeThumbnailCache() {
  const disk = new Map();
  return {
    disk,
    invoke(command, args) {
      if (command === "load_thumbnail_cache") return [...disk];
      if (command !== "save_thumbnail_cache") return undefined;
      for (const [key, bytes] of args.entries) disk.set(key, bytes);
      for (const key of disk.keys()) if (!args.keep.includes(key)) disk.delete(key);
      return null;
    },
    stored() {
      return Object.fromEntries(
        [...disk].map(([key, bytes]) => [key, `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`]),
      );
    },
  };
}

export function libraryOf(items = [], collections = [], memberships = []) {
  return {
    items: items.map((item) => ({
      ...item,
      saveOperationIds: item.saveOperationIds ?? [
        Array.from(createHash("sha256").update(`${item.source}/${item.id}`).digest().subarray(0, 16)),
      ],
    })),
    collections,
    memberships,
  };
}
