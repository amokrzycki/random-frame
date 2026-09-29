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
  assert.match(copy, /Clears history and local activity stats on this device/);
  assert.match(copy, /Prnt\.sc exploration, Seen IDs, and favorites remain/);
  assert.match(copy, /known history is removed from linked devices when they sync/);
  assert.match(copy, /New history created offline may appear later/);
  assert.match(copy, /Clears favorites on this device/);
  assert.match(copy, /known favorites are removed from linked devices when they sync/);
  assert.match(copy, /New favorites created on an offline device may appear later/);
  assert.match(copy, /<dt>Found<\/dt>.*<dt>Today<\/dt>.*<dt>Activity streak<\/dt>/);
  assert.match(copy, /Prnt\.sc explored locally/);
  assert.match(copy, /Found counts first viewable results here/);
  assert.match(copy, /Activity streak counts consecutive days with a result/);
  assert.match(copy, /Found, Today, streak, and daily results reset when history is cleared/);
  assert.match(copy, /Prnt\.sc exploration stays here and does not Sync/);
  assert.match(copy, /Seen IDs remain to avoid repeats and can Sync/);
  assert.match(copy, /Local results by day/);
  assert.doesNotMatch(copy, /Stats stay local and reset when history is cleared|since history clear/);
});
