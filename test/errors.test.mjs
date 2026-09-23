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
  assert.equal(
    describeError(Object.assign(new Error("x"), { kind: "timeout" })).title,
    "Prnt.sc took too long to answer.",
  );
});

test("keeps unknown error detail out of the UI and logs it instead", (t) => {
  const log = t.mock.method(console, "error", () => {});
  assert.doesNotMatch(describeError({ kind: "unknown-source", message: "Unknown source" }).message, /Unknown source/);
  assert.doesNotMatch(describeError(new Error("Something specific")).message, /Something specific/);
  assert.doesNotMatch(describeError("plain string").message, /plain string/);
  assert.match(describeError(undefined).message, /limited access/);
  assert.equal(describeError(null).title, "This frame would not open.");
  assert.equal(describeError(new Error("x"), "Copy failed.").message, "Copy failed.");
  assert.equal(log.mock.callCount(), 6);
});
