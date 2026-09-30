import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const pendingKey = "random-frame-pending-changelog";
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("release notes follow a successful update, wait for dialogs, and are dismissed once", async (t) => {
  const document = new FakeDocument(ids);
  const storage = new FakeStorage();
  const window = new EventTarget();
  const originals = new Map(
    ["document", "localStorage", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.assign(globalThis, { document, localStorage: storage, window });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  let version = "0.6.0";
  let failInstall = true;
  let restarts = 0;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    async invoke(command) {
      if (command === "plugin:app|version") return version;
      if (command === "plugin:updater|check")
        return { rid: 1, currentVersion: "0.5.0", version: "0.6.0", body: "Do not display remote notes" };
      if (command === "plugin:updater|download_and_install") {
        assert.equal(storage.getItem(pendingKey), null);
        if (failInstall) throw new Error("install failed");
        return;
      }
      if (command === "plugin:process|restart") {
        if (globalThis.localStorage === storage) assert.equal(storage.getItem(pendingKey), "0.6.0");
        restarts++;
        return;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  };

  const update = await import("../dist/test-client/update.js");
  assert.equal(typeof update.renderReleaseNotes, "function");
  const markdown = [
    "# Changelog",
    "## 0.6.0",
    "### Improvements",
    "- **Local notes** with [help](https://example.com).",
    '<script>alert("raw HTML")</script>',
    "[bad](javascript:alert(1)) [encoded](&#106;avascript:alert(1)) [file](file:///tmp/secret)",
    "```md",
    "## 9.9.9",
    "```",
    "## 0.5.0",
    "Older notes",
    "## 0.4.0",
    "",
  ].join("\n");
  const html = update.renderReleaseNotes(markdown, "0.6.0");
  assert.match(html, /<strong>Local notes<\/strong>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /## 9\.9\.9/);
  assert.doesNotMatch(html, /<script|href="(?:javascript|file):|Older notes/);
  assert.equal(update.renderReleaseNotes(markdown, "0.4.0"), "");
  assert.equal(update.renderReleaseNotes(markdown, "0.6"), "");

  await update.checkForUpdate();
  const install = document.body.children.at(-1).children[1];
  install.click();
  await flush();
  assert.equal(storage.getItem(pendingKey), null);
  assert.equal(restarts, 0);
  failInstall = false;
  install.click();
  await flush();
  assert.equal(restarts, 1);

  const get = (id) => document.querySelector(`#${id}`);
  const { bindDialogChromeEvents, onDialogClosed, openDialog } = await import("../dist/test-client/dialogs.js");
  bindDialogChromeEvents();
  get("entry-dialog").addEventListener("close", onDialogClosed);
  openDialog(get("entry-dialog"));
  await update.showPendingChangelog();
  assert.equal(get("changelog-dialog").open, false);
  get("entry-dialog").close();
  await flush();
  assert.equal(get("changelog-dialog").open, true);
  assert.equal(get("changelog-version").textContent, "0.6.0");
  assert.match(get("changelog-body").innerHTML, /<li>/);
  assert.doesNotMatch(get("changelog-body").innerHTML, /remote notes/);
  assert.equal(storage.getItem(pendingKey), "0.6.0");
  assert.equal(get("main-content").inert, true);
  const escapeEvent = new Event("keydown");
  Object.defineProperty(escapeEvent, "key", { value: "Escape" });
  document.dispatchEvent(escapeEvent);
  assert.equal(get("changelog-dialog").open, false);
  assert.equal(storage.getItem(pendingKey), null);
  assert.equal(get("main-content").inert, false);
  await update.showPendingChangelog();
  assert.equal(get("changelog-dialog").open, false);

  // Done and the shared backdrop consume the marker just like Escape.
  for (const button of [get("changelog-done"), get("dialog-backdrop")]) {
    get("draw-button").focus();
    storage.setItem(pendingKey, version);
    await update.showPendingChangelog();
    button.click();
    assert.equal(get("changelog-dialog").open, false);
    assert.equal(storage.getItem(pendingKey), null);
    assert.equal(document.activeElement, get("draw-button"));
  }

  for (version of ["0.5.0", "9.9.9"]) {
    storage.setItem(pendingKey, "0.6.0");
    await update.showPendingChangelog();
    assert.equal(storage.getItem(pendingKey), null);
    assert.equal(get("changelog-dialog").open, false);
  }
  version = "9.9.9";
  storage.setItem(pendingKey, version);
  await update.showPendingChangelog();
  assert.equal(storage.getItem(pendingKey), null);

  globalThis.localStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
    removeItem() {
      throw new Error("storage unavailable");
    },
  };
  await update.showPendingChangelog();
  await update.checkForUpdate();
  document.body.children.at(-1).children[1].click();
  await flush();
  assert.equal(restarts, 2);
});
