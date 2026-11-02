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
