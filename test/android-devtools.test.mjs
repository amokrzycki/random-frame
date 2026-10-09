import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../.github/tools/android-smoke.mjs", import.meta.url), "utf8");
const evaluateSource = source.slice(source.indexOf("async function evaluate("), source.indexOf("\nconst invoke ="));

function devtools(scenario) {
  let elapsed = 0;
  let probes = 0;
  const context = vm.createContext({
    Date: { now: () => elapsed },
    AbortSignal,
    pkg: "dev.randomframe.android.debug",
    processId: () =>
      (scenario === "dead" || scenario === "hang") && probes > 0
        ? ""
        : scenario === "restart" && probes > 0
          ? "456"
          : "123",
    adb: (...args) => {
      if (args[0] === "forward") {
        return "";
      }
      if (args.join(" ") === "shell pidof dev.randomframe.android.debug") return "123";
      if (args[0] === "logcat") return "WebView startup evidence";
      if (args[0] === "shell") return "App process evidence";
      throw new Error(`Unexpected adb command: ${args.join(" ")}`);
    },
    sleep: async (ms) => {
      elapsed += ms;
    },
    fetch: async (_url, options) => {
      probes++;
      if (scenario === "hang") {
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("request did not abort")), 2000);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(options.signal.reason);
            },
            { once: true },
          );
        });
      }
      if (scenario !== "slow") throw new Error("DevTools connection refused");
      return {
        json: async () =>
          elapsed < 6000 ? [] : [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1" }],
      };
    },
    WebSocket: class {
      addEventListener(event, handler) {
        if (event === "open") queueMicrotask(handler);
        if (event === "message") queueMicrotask(() => handler({ data: '{"id":1,"result":{"result":{"value":42}}}' }));
      }
      send = () => undefined;
      close = () => undefined;
    },
  });
  vm.runInContext(evaluateSource, context);
  return { evaluate: context.evaluate, elapsed: () => elapsed, probes: () => probes };
}

test("DevTools discovery waits for a slow WebView beyond five seconds", async () => {
  const device = devtools("slow");
  assert.equal(await device.evaluate("21 * 2"), 42);
  assert.equal(device.elapsed(), 6000);
});

test("DevTools discovery fails promptly if the app dies", async () => {
  const device = devtools("dead");
  await assert.rejects(device.evaluate("21 * 2"), /app process.*123.*discovery/);
  assert.equal(device.probes(), 1);
});

test("a replacement app process cannot satisfy DevTools readiness", async () => {
  const device = devtools("restart");
  await assert.rejects(device.evaluate("21 * 2"), /app process.*123.*456.*discovery/);
  assert.equal(device.probes(), 1);
});

test("DevTools discovery has a deadline and retains the connection error and app logs", async () => {
  const device = devtools("unavailable");
  await assert.rejects(device.evaluate("21 * 2"), (error) => {
    assert.match(error.message, /WebView DevTools page is unavailable/);
    assert.match(error.message, /DevTools connection refused/);
    assert.match(error.message, /WebView startup evidence/);
    return true;
  });
  assert.equal(device.elapsed(), 30000);
});

test("a stalled discovery request is aborted so app liveness can be checked again", async () => {
  const device = devtools("hang");
  await assert.rejects(device.evaluate("21 * 2"), /app process changed.*The operation was aborted due to timeout/);
  assert.equal(device.probes(), 1);
});
