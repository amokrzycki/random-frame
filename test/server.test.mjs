import test from "node:test";
import assert from "node:assert/strict";
import { extractImageUrl, isAllowedImageUrl } from "../server.mjs";

test("extracts only a trusted screenshot image", () => {
  const html = '<meta property="og:image" content="https://image.prntscr.com/image/example.png?x=1&amp;y=2">';
  assert.equal(extractImageUrl(html), "https://image.prntscr.com/image/example.png?x=1&y=2");
  assert.equal(extractImageUrl('<meta property="og:image" content="https://evil.example/image.png">'), null);
});

test("allows only known HTTPS image hosts", () => {
  assert.equal(isAllowedImageUrl("https://i.imgur.com/example.png"), true);
  assert.equal(isAllowedImageUrl("http://image.prntscr.com/example.png"), false);
  assert.equal(isAllowedImageUrl("https://image.prntscr.com.evil.example/image.png"), false);
});
