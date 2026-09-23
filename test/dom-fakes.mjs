import { resolveObjectURL } from "node:buffer";

// Minimal DOM and storage doubles for importing the client app under node:test.
class FakeElement extends EventTarget {
  constructor(document) {
    super();
    this.document = document;
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
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
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
    this.elements = new Map(ids.map((id) => [`#${id}`, new FakeElement(this)]));
    this.body = new FakeElement(this);
  }

  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  querySelectorAll() {
    return [];
  }

  createElement() {
    return new FakeElement(this);
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

export const ids = [
  "image",
  "image-zoom",
  "image-ghost",
  "lightbox-dialog",
  "lightbox-image",
  "lightbox-close-button",
  "empty-state",
  "loading-state",
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
  "history-total",
  "favorite-button",
  "history-button",
  "history-dialog",
  "history-close-button",
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
  "history-page-previous",
  "history-page-next",
  "history-page-size",
  "stats-button",
  "sync-button",
  "sync-dialog",
  "sync-close",
  "sync-status",
  "sync-error",
  "sync-unpaired",
  "sync-enable",
  "sync-show-join",
  "sync-join-form",
  "sync-recovery-input",
  "sync-join",
  "sync-recovery",
  "sync-recovery-key",
  "sync-copy-key",
  "sync-paired",
  "sync-revision",
  "sync-dirty",
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
  "stats-explored-percent",
  "stats-explored-breakdown",
  "announcer",
  "entry-dialog",
  "entry-consent",
  "entry-button",
  "leave-button",
  "main-content",
  "dialog-backdrop",
  "image-id-value",
  "id-menu",
  "id-menu-button",
  "previous-id-menu-item",
  "next-id-menu-item",
  "position-button",
  "position-current",
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
];
