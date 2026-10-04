import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("builds static Tauri assets with the package version", async () => {
  const [{ version }, index, privacy, desktop, styles, tauriConfig, capability] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/privacy.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/random-frame.desktop", import.meta.url), "utf8"),
    readFile(new URL("../dist/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(index, new RegExp(`>v${version.replaceAll(".", "\\.")}<`));
  assert.match(desktop, new RegExp(`^X-AppImage-Version=${version.replaceAll(".", "\\.")}$`, "m"));
  assert.equal(
    tauriConfig.bundle.linux.appimage.files["usr/share/applications/Random Frame.desktop"],
    "../dist/random-frame.desktop",
  );
  assert.match(index, /src="app\.js"/);
  assert.match(index, /<section\s[^>]*id="changelog-body"[^>]*tabindex="0"[^>]*aria-label="Release notes"/);
  assert.match(index, /src="window-controls\.js"/);
  assert.match(index, /href="privacy\.html">Privacy<\/a>/);
  assert.match(privacy, /<h1>Privacy policy<\/h1>/);
  assert.match(privacy, /src="privacy\.js"/);
  assert.doesNotMatch(index + privacy, /{{[A-Z_]+}}/);
  assert.match(index, /data-tauri-drag-region/);
  assert.match(styles, /\.app-shell \.privacy-main\{[^}]*overflow-y:auto/);
  assert.equal(tauriConfig.app.windows[0].decorations, false);
  assert.deepEqual(
    capability.permissions.filter((permission) => permission.startsWith("core:window:allow-")),
    [
      "core:window:allow-close",
      "core:window:allow-minimize",
      "core:window:allow-start-dragging",
      "core:window:allow-toggle-maximize",
    ],
  );
});

test("history and Stats copy distinguishes reset activity from persistent exploration", async () => {
  const index = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const copy = index.replace(/\s+/g, " ");
  assert.match(copy, /Clears history and Stats\. Favorites and Seen IDs/);
  assert.match(copy, /Clears favorites on this device/);
  assert.match(copy, /known favorites are removed from linked devices when they sync/);
  assert.match(copy, /New favorites created on an offline device may appear later/);
  assert.match(copy, /<dt>Frames drawn<\/dt>.*<dt>Today<\/dt>.*<dt>Activity streak<\/dt>/);
  assert.match(copy, /Prnt\.sc IDs checked/);
  assert.match(copy, /Stats reset with History, and on linked devices once they Sync\. IDs checked and Seen IDs stay/);
  assert.doesNotMatch(copy, /How stats work/);
  assert.match(copy, /Days you drew/);
  assert.doesNotMatch(copy, /Stats stay local and reset when history is cleared|since history clear/);
});

test("window controls are Tab stops and the enlarged view starts on Close", async () => {
  const [index, privacy] = await Promise.all(
    ["index.html", "privacy.html"].map((name) => readFile(new URL(`../dist/${name}`, import.meta.url), "utf8")),
  );
  for (const html of [index, privacy]) {
    for (const control of ["minimize", "maximize", "close"]) {
      const button = html.match(new RegExp(`<button\\b[^>]*id="window-${control}"[^>]*>`))?.[0];
      assert.ok(button);
      assert.doesNotMatch(button, /tabindex=|\bdisabled\b|\bhidden\b/);
    }
  }
  assert.match(index, /id="lightbox-close-button"\s+autofocus/);
});

test("distilled menus keep Save beside Favorite and Clear in the History footer", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const more = html.split('id="tools-menu"')[1].split('<div class="window-controls">')[0];
  const frame = html.split('id="frame-menu"')[1].split('id="favorite-button"')[0];
  const history = html.split('id="history-dialog"')[1].split('id="stats-dialog"')[0];
  assert.match(more, /id="stats-button"/);
  assert.doesNotMatch(more, /History/);
  assert.equal((frame.match(/role="menuitem"/g) ?? []).length, 7);
  assert.doesNotMatch(frame, /id="save-button"|id="position-current"|id="history-total"/);
  assert.match(html, /id="favorite-button"[\s\S]*class="info-icon"\s+id="save-button"/);
  assert.match(history, /<footer class="history-footer">[\s\S]*id="history-clear-button"/);
  assert.doesNotMatch(history.split("</header>")[0], /history-clear/);
});

test("Sync dialog separates Start a new Sync from Connect this device and states scope, roster, and recovery honestly", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const dialog = html.split('id="sync-dialog"')[1].split('id="dialog-backdrop"')[0];
  const copy = dialog.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const start = dialog.split('id="sync-start"')[1].split('id="sync-connect-title"')[0];
  const connect = dialog.split('id="sync-connect-title"')[1].split('id="sync-recovery"')[0];
  assert.match(start, /Start a new Sync/);
  assert.match(start, /id="sync-enable"/);
  assert.doesNotMatch(start, /recovery key to connect|sync-join/);
  assert.match(connect, /Connect this device/);
  assert.match(connect, /id="sync-show-join"/);
  // The merge explanation is on screen before the key field and in the same section.
  assert.ok(
    connect
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .indexOf(
        "Your saved data on this device will be combined with your Sync. It won’t be replaced. Deletions already saved in that Sync will still apply.",
      ) >= 0,
  );
  assert.ok(connect.indexOf("will be combined") < connect.indexOf('id="sync-join-form"'));
  assert.match(copy, /History and Favorites/);
  assert.match(copy, /Previously viewed and checked IDs/);
  assert.match(copy, /Activity &amp; Stats/);
  assert.match(copy, /Preferences/);
  assert.match(copy, /Images saved to files aren’t backed up/);
  assert.match(
    copy,
    /Devices known from past syncs\. This list doesn’t show which ones are online or still connected\./,
  );
  assert.match(
    copy,
    /Keep this key somewhere safe\. Use it to bring your saved data to another device\. Anyone with this key can connect to your Sync\./,
  );
  assert.match(copy, /Show recovery key/);
  assert.match(copy, /Sync now/);
  assert.match(
    copy,
    /The data on this device and your Sync data on the server stay as they are\. To connect again, you’ll need your recovery key\./,
  );
  const buttons = [...dialog.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    match[1].replace(/\s+/g, " ").trim(),
  );
  assert.ok(buttons.includes("Disconnect this device"));
  assert.doesNotMatch(
    copy,
    /Leave Sync|Turn on Sync|Join existing Sync|cannot show it again|Remove device|Revoke|Online|Active now/,
  );
});

test("no copy still says Stats or IDs checked stay on one device", async () => {
  const files = ["index.html", "README.md", "PRODUCT.md", "DESIGN.md", "privacy.html"];
  for (const name of files) {
    const text = (await readFile(new URL(`../${name}`, import.meta.url), "utf8")).replace(/\s+/g, " ");
    assert.doesNotMatch(
      text,
      /IDs checked stay on this device|IDs checked\.? (?:Does|do(?:es)?) not (?:currently )?Sync|it does not currently Sync|Settings and statistics stay on your device|Stats stay (?:here|local)/i,
      name,
    );
  }
});
