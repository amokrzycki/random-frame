import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("builds static Tauri assets with the package version", async () => {
  const [{ version }, index, privacy] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/privacy.html", import.meta.url), "utf8"),
  ]);

  assert.match(index, new RegExp(`>v${version.replaceAll(".", "\\.")}<`));
  assert.match(index, /src="app\.js"/);
  assert.match(index, /href="privacy\.html">Privacy<\/a>/);
  assert.match(privacy, /<h1>Privacy Policy<\/h1>/);
  assert.doesNotMatch(index + privacy, /{{[A-Z_]+}}/);
});
