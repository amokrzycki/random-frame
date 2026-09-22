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

test("heatmap weekday labels sit on the Monday-indexed rows the grid places days in", async () => {
  const { leadingBlankCount } = await import("../dist/test-client/statistics.js");
  const [index, styles] = await Promise.all([
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/styles.css", import.meta.url), "utf8"),
  ]);

  // Decorative labels beside an unchanged grid; each cell keeps its own full aria-label.
  assert.match(
    index,
    /<div class="heatmap">\s*<div class="heatmap-weekdays" aria-hidden="true">\s*<span>Mon<\/span>\s*<span>Wed<\/span>\s*<span>Fri<\/span>\s*<\/div>\s*<fieldset\s+class="heatmap-grid"\s+id="stats-heatmap-grid"/,
  );
  // Both columns share one row track, so labels cannot drift from the cells.
  assert.match(
    styles,
    /\.heatmap-weekdays\{[^}]*grid-template-rows:repeat\(7,var\(--heatmap-cell\)\);row-gap:var\(--heatmap-gap\)/,
  );
  assert.match(
    styles,
    /\.heatmap-grid\{[^}]*grid-template-rows:repeat\(7,var\(--heatmap-cell\)\);gap:var\(--heatmap-gap\)/,
  );
  // Mon / Wed / Fri land in grid rows 1 / 3 / 5, where leadingBlankCount() puts those weekdays.
  assert.equal(leadingBlankCount("2026-09-21") + 1, 1); // Monday: first label, auto-placed
  assert.match(styles, /\.heatmap-weekdays span:nth-child\(2\)\{grid-row:3\}/);
  assert.equal(leadingBlankCount("2026-09-23") + 1, 3); // Wednesday
  assert.match(styles, /\.heatmap-weekdays span:nth-child\(3\)\{grid-row:5\}/);
  assert.equal(leadingBlankCount("2026-09-25") + 1, 5); // Friday
});
