import assert from "node:assert/strict";
import test from "node:test";
import { describeError } from "../dist/test-client/errors.js";

test("explains rate limits plainly and asks for a pause before the next request", () => {
  const upstream = describeError(
    Object.assign(new Error("Prnt.sc returned status 429"), { kind: "upstream-rate-limited" }),
  );
  assert.equal(upstream.title, "Prnt.sc is limiting requests.");
  assert.doesNotMatch(upstream.message, /429/);
  assert.equal(upstream.cooldownSeconds, 10);
  assert.equal(describeError({ kind: "rate-limited", message: "Too many requests." }).cooldownSeconds, 2);
  assert.equal(describeError({ kind: "network", message: "x" }).cooldownSeconds, 0);
});

test("reads raw Tauri error objects as well as Error instances", () => {
  assert.equal(describeError({ kind: "persistence", message: "disk full" }).title, "History could not be saved.");
  assert.equal(describeError(new Error("Something specific")).message, "Something specific");
});

test("falls back to the backend message, then to generic copy", () => {
  assert.equal(describeError({ kind: "unknown-source", message: "Unknown source" }).message, "Unknown source");
  assert.equal(describeError("plain string").message, "plain string");
  assert.match(describeError(undefined).message, /limited access/);
  assert.equal(describeError(null).title, "This frame would not open.");
});
