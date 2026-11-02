import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

// Exercise the driver against the real client state; replace only the subsequent workload.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("../src/client/"))
      return nextResolve(
        new URL(`../dist/test-client/${specifier.split("/").at(-1).replace(/\.ts$/, ".js")}`, import.meta.url).href,
        context,
      );
    if (specifier === "./native-retention.mjs")
      return {
        url: "data:text/javascript,export async function retentionWorkload(){return {ran:true}}",
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});

test("native startup accepts eager baselines and still rejects eager reads in demand builds", async (t) => {
  globalThis.document = new FakeDocument(ids);
  document.body.innerText = "";
  globalThis.localStorage = new FakeStorage();
  globalThis.requestAnimationFrame = (callback) => setImmediate(callback);
  let report;
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === "performance_config") return { samples: "0", launch: "0", mode: "retention" };
        assert.equal(command, "performance_report");
        report(args.payload);
      },
    },
  };
  const { state } = await import("../dist/test-client/viewer-state.js");
  const { elements } = await import("../dist/test-client/elements.js");
  const { setState } = await import("../dist/test-client/stage.js");
  state.history = [{ source: "prntsc", id: "abc123", viewedAt: 1, sourcePageUrl: "" }];
  state.index = 0;
  state.loading = false;
  setState("image");
  Object.assign(elements.image, { src: "blob:fixture", complete: true, naturalWidth: 1920 });
  for (const [command, reads, error] of [
    ["load_thumbnail_cache", 0, false],
    ["list_thumbnail_cache", 1, false],
    ["list_thumbnail_cache", 3, true],
    ["unrelated_command", 0, true],
  ]) {
    await t.test(`${command} with ${reads} reads`, async () => {
      globalThis.__rf = {
        ipc: [
          { name: command, phase: "startup" },
          ...Array.from({ length: reads }, () => ({ name: "read_thumbnail_cache", phase: "startup" })),
        ],
        urls: new Map(),
        milestones: {},
        spans: [],
        frames: [],
      };
      const reported = new Promise((resolve) => {
        report = resolve;
      });
      await import(`../performance/native-driver.mjs?startup=${command}-${reads}`);
      const result = await reported;
      if (error) assert.match(result.error, /IPC probe|thumbnail files eagerly/);
      else assert.equal(result.retention?.ran, true, JSON.stringify(result));
    });
  }
});
