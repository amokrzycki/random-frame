import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../.github/tools/android-nearby.mjs", import.meta.url), "utf8");
const runResourceChecks = vm.runInNewContext(
  `${source.slice(source.indexOf("async function runResourceChecks("))};runResourceChecks`,
);
const native = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const commands = new Set(
  native.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/)[1].match(/\b\w+\b/g),
);

async function seedResources({ omitLast = false } = {}) {
  const cache = new Map([["prntsc:existing", 100]]);
  const recorded = [];
  const finished = new Error("native fixtures checked");
  const invoke = async (command, args) => {
    assert.ok(commands.has(command), `Command ${command} not found`);
    if (command === "list_thumbnail_cache") return [...cache];
    if (command === "record_nearby_history_item") {
      recorded.push(args.item.id);
      return;
    }
    if (command === "save_thumbnail_cache") {
      assert.ok(args.keep.includes("prntsc:existing"), "seeding preserves existing thumbnails");
      assert.equal(args.entries.length, 41);
      for (const [key, bytes] of args.entries.slice(0, omitLast ? -1 : undefined)) {
        assert.ok(args.keep.includes(key));
        cache.set(key, bytes.length);
      }
      return;
    }
    assert.equal(command, "select_history_item");
  };
  const context = vm.createContext({
    window: { __nearbySmoke: {}, __TAURI_INTERNALS__: { invoke } },
    document: {
      createElement: () => ({
        getContext: () => ({ fillRect: () => undefined }),
        toBlob: (callback) => callback(new Blob([new Uint8Array([255, 216, 255, 217])])),
      }),
    },
    Date,
    Uint8Array,
  });
  try {
    await runResourceChecks({
      adb: () => "TOTAL PSS: 100",
      evaluate: (expression) =>
        expression.includes("URL.createObjectURL") ? true : vm.runInContext(expression, context),
      check: (ok, message) => {
        assert.ok(ok, message);
        if (message.startsWith("41 native")) throw finished;
      },
    });
    assert.fail("resource checks did not reach native fixture setup");
  } catch (error) {
    if (error !== finished) throw error;
  }
  assert.equal(recorded.length, 41);
  assert.equal(cache.size, 42);
  assert.deepEqual(Array.from(context.window.__nearbyMemory.ids), recorded);
}

test("Android resource fixtures use registered cache commands and preserve existing keys", async () => {
  await seedResources();
});

test("Android resource fixtures refuse decoder stress if a thumbnail was not persisted", async () => {
  await assert.rejects(seedResources({ omitLast: true }), /Native fixture was not persisted; refuse source fallback/);
});

async function cycleResources({ leak = false } = {}) {
  let elapsed = 0;
  let opens = 0;
  let closes = 0;
  let tiles = 0;
  let closing = false;
  const timers = [];
  const schedule = (callback, ms) => timers.push({ at: elapsed + ms, callback });
  const urls = { createObjectURL: () => `blob:${opens}`, revokeObjectURL: () => undefined };
  const original = { ...urls };
  const dialog = { open: false };
  const fixture = { active: 0 };
  const context = vm.createContext({
    URL: urls,
    Date: { now: () => elapsed },
    window: { __nearbySmoke: fixture },
    document: {
      querySelectorAll: () => Array(tiles).fill({}),
      querySelector: (selector) => {
        if (selector === "#nearby-dialog") return dialog;
        if (selector === "#nearby-button")
          return {
            click() {
              if (dialog.open) return;
              opens++;
              dialog.open = true;
              tiles = 9;
              const url = urls.createObjectURL(new Blob());
              fixture.active++;
              schedule(() => {
                fixture.active--;
                if (!leak) urls.revokeObjectURL(url);
              }, 1500);
            },
          };
        assert.equal(selector, "#nearby-close");
        return {
          click() {
            if (closing) return;
            closing = true;
            schedule(() => {
              closes++;
              dialog.open = false;
              tiles = 0;
              closing = false;
            }, 1000);
          },
        };
      },
    },
    setTimeout: (callback, ms) => {
      const target = elapsed + ms;
      while (timers.sort((a, b) => a.at - b.at)[0]?.at <= target) {
        const next = timers.shift();
        elapsed = next.at;
        next.callback();
      }
      elapsed = target;
      queueMicrotask(callback);
    },
  });
  const finished = new Error("gallery cycles checked");
  await assert.rejects(
    runResourceChecks({
      evaluate: (expression) => vm.runInContext(expression, context),
      check: (ok, message) => {
        assert.ok(ok, message);
        throw finished;
      },
    }).finally(() => {
      assert.deepEqual(urls, original, "URL instrumentation is restored on success and failure");
      assert.ok(elapsed <= 45100, "cleanup stays below the 60-second DevTools evaluation limit");
    }),
    (error) => error === finished,
  );
  assert.equal(opens, 12, "each cycle actually opens the dialog");
  assert.equal(closes, 12);
  return elapsed;
}

test("Android gallery resource checks wait for slow close events and outstanding decode URLs", async () => {
  assert.ok((await cycleResources()) >= 12 * 1500);
});

test("Android gallery resource checks still reject leaked URLs with bounded diagnostics", async () => {
  await assert.rejects(cycleResources({ leak: true }), /Nearby cleanup timed out.*"liveUrls":1/);
});
