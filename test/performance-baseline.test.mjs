import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("component benchmarks support legacy cache IPC and reject failed cache operations", async (t) => {
  for (const script of ["bench-client.mjs", "browser.mjs"])
    for (const failure of ["", "initialize", "save"])
      await t.test(`${script}: ${failure || "legacy baseline"}`, () => {
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          import { registerHooks } from 'node:module';
          import { FakeDocument, FakeStorage, ids } from './test/dom-fakes.mjs';
          const failure = ${JSON.stringify(failure)};
          registerHooks({
            resolve(specifier, context, next) {
              if (specifier.startsWith('../src/client/'))
                return next(new URL('./dist/test-client/' + specifier.split('/').at(-1).replace(/\\.ts$/, '.js'), import.meta.url).href, context);
              return next(specifier, context);
            },
            load(url, context, next) {
              const result = next(url, context);
              if (url.endsWith('/frame-cache.js'))
                return { ...result, source: String(result.source).replaceAll('"list_thumbnail_cache"', '"load_thumbnail_cache"') };
              if (url.endsWith('/@tauri-apps/api/core.js'))
                return { ...result, source: String(result.source).replace(
                  'return window.__TAURI_INTERNALS__.invoke(cmd, args, options);',
                  'if ((' + JSON.stringify(failure === 'initialize') + ' && cmd === "load_thumbnail_cache") || (' + JSON.stringify(failure === 'save') + ' && cmd === "save_thumbnail_cache")) throw Error("fixture disk failure"); return window.__TAURI_INTERNALS__.invoke(cmd, args, options);') };
              return result;
            }
          });
          globalThis.document = new FakeDocument(ids);
          document.getElementById = id => document.querySelector('#' + id);
          const create = document.createElement.bind(document);
          document.createElement = tag => tag === 'canvas' ? { toDataURL: () => 'data:image/jpeg;base64,AA==' } : create(tag);
          globalThis.localStorage = new FakeStorage();
          globalThis.window = new EventTarget();
          globalThis.location = { href: 'http://fixture/performance.html' };
          globalThis.setTimeout = callback => { queueMicrotask(callback); return 1; };
          await import('./performance/${script}');
          if (window.runPerformanceBenchmark) console.log(JSON.stringify(await window.runPerformanceBenchmark()));
        `,
          ],
          { encoding: "utf8", timeout: 20000 },
        );
        assert.equal(result.error, undefined);
        if (failure) {
          assert.notEqual(result.status, 0, "a failed cache operation must not produce a benchmark report");
          assert.match(result.stderr, /[Tt]humbnail.*(initializ|sav|persist)/);
        } else {
          assert.equal(result.status, 0, result.stderr);
          const report = JSON.parse(result.stdout);
          assert.equal(report.results.filter((row) => row.name === "unchanged-save-ipc-calls").length, 3);
        }
      });
});
