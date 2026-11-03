import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids, libraryOf } from "./dom-fakes.mjs";

const settle = async () => {
  for (let i = 0; i < 18; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("gallery preview recovery preserves scope, nodes, focus, accounting and retained files", async (t) => {
  const names = ["document", "window", "localStorage", "createImageBitmap", "getComputedStyle"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const document = new FakeDocument(ids);
  const create = document.createElement.bind(document);
  let retryOffscreen = false;
  document.createElement = (tag) => {
    if (tag === "canvas")
      return {
        getContext: () => ({
          drawImage() {
            /* Canvas double. */
          },
        }),
        toDataURL: () => "data:image/jpeg;base64,AQ==",
      };
    const element = create(tag);
    if (tag === "img") {
      const decode = element.decode.bind(element);
      element.decode = async () => {
        if (retryOffscreen)
          assert.equal(element.loading, "eager", "requested offscreen retry must not wait for lazy intersection");
        return decode();
      };
    }
    return element;
  };
  const calls = [];
  const disk = new Map([
    ["prntsc:abc5", "data:image/jpeg;base64,/w=="],
    ["prntsc:abc0", "data:image/jpeg;base64,AQ=="],
  ]);
  let broken = true,
    active = 0,
    peak = 0;
  let hold = false;
  const releases = [];
  const failures = new Map([
    ["abc9", "network"],
    ["abc8", "timeout"],
    ["abc7", "not-found"],
    ["abc6", "invalid-response"],
  ]);
  const window = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        calls.push({ command, args });
        if (command === "list_thumbnail_cache") return [...disk].map(([key]) => [key, 1]).concat([["prntsc:abc4", 1]]);
        if (command === "read_thumbnail_cache") return disk.get(args.key) ?? null;
        if (command === "save_thumbnail_cache") {
          for (const [key, bytes] of args.entries)
            disk.set(key, `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
          for (const key of disk.keys()) if (!args.keep.includes(key)) disk.delete(key);
          return;
        }
        if (command === "get_thumbnail_image") {
          active++;
          peak = Math.max(peak, active);
          if (hold)
            await new Promise((resolve) => {
              releases.push(resolve);
            });
          active--;
          if (broken && failures.has(args.id)) throw { kind: failures.get(args.id) };
          return new Uint8Array([1]).buffer;
        }
        throw new Error(`Unexpected mutation/command: ${command}`);
      },
    },
  });
  Object.assign(globalThis, {
    document,
    window,
    localStorage: new FakeStorage(),
    createImageBitmap: async () => ({
      width: 100,
      height: 100,
      close() {
        /* Bitmap double. */
      },
    }),
    getComputedStyle: () => ({ gridTemplateColumns: "100px 100px 100px" }),
  });
  const { state } = await import("../dist/test-client/viewer-state.js");
  const { bindHistoryDialogEvents, openHistory } = await import("../dist/test-client/history-dialog.js");
  const { persistThumbnails } = await import("../dist/test-client/frame-cache.js");
  state.history = Array.from({ length: 14 }, (_, i) => ({
    source: "prntsc",
    id: `abc${i.toString(36)}`,
    sourcePageUrl: "",
    viewedAt: 1,
    addedAt: 1,
  }));
  state.index = 13;
  state.loading = false;
  state.pageSize = 10;
  state.library = libraryOf(state.history);
  state.favorites = state.library.items;
  const before = structuredClone({ history: state.history, library: state.library, index: state.index });
  const get = (id) => document.querySelector(`#${id}`);
  bindHistoryDialogEvents();
  openHistory(get("history-tool-button"));
  await settle();
  assert.equal(get("history-preview-feedback")?.hidden, false, "requested failures have a gallery explanation");
  assert.match(get("history-preview-status").textContent, /could not load/);
  assert.match(get("history-preview-status").textContent, /unavailable/);
  assert.ok(peak <= 3);
  assert.equal(
    disk.get("prntsc:abc5"),
    "data:image/jpeg;base64,/w==",
    "failed decode retains pinned bytes until a replacement exists",
  );
  assert.ok(
    calls.some((x) => x.command === "get_thumbnail_image" && x.args.id === "abc4"),
    "a missing advertised cache entry regenerates through the normal source path",
  );
  const nodes = [...get("history-grid").children];
  const failed = nodes.map((x) => x.children[0]).filter((x) => x.getAttribute("data-empty") === "true");
  assert.equal(failed.length, 5, "network, timeout, not-found, invalid response and corrupt disk image");
  assert.ok(failed.some((x) => x.getAttribute("aria-description")?.includes("unavailable")));
  const requestCount = () => calls.filter((x) => x.command === "get_thumbnail_image").length;
  const requests = requestCount();
  get("history-body").scrollTop = 142;
  get("history-preview-feedback").getBoundingClientRect = () => ({ height: 96 });
  const retry = get("history-preview-retry");
  retry.focus();
  broken = false;
  retryOffscreen = true;
  retry.click();
  retry.click();
  await settle();
  assert.equal(
    requestCount() - requests,
    4,
    "only retryable requested failures, never confirmed not-found or untouched pages",
  );
  assert.deepEqual(get("history-grid").children, nodes, "retry does not rebuild the grid");
  assert.equal(get("history-body").scrollTop, 142);
  assert.equal(
    get("history-preview-feedback").style.minHeight,
    "96px",
    "recovery cannot shrink its feedback row and clamp scroll",
  );
  assert.equal(document.activeElement, retry);
  assert.equal(retry.getAttribute("aria-disabled"), "true");
  assert.match(get("history-preview-status").textContent, /unavailable/);
  assert.equal(get("history-grid").children.filter((x) => x.children[0].hasAttribute("data-empty")).length, 1);
  assert.equal(get("history-filter-all").getAttribute("aria-selected"), "true");
  assert.deepEqual({ history: state.history, library: state.library, index: state.index }, before);
  await persistThumbnails();
  assert.ok(disk.has("prntsc:abc0"), "retained off-page Saved file survives retry");
  assert.equal(
    disk.get("prntsc:abc5"),
    "data:image/jpeg;base64,AQ==",
    "corrupt pinned file is replaced only after recovery",
  );

  retryOffscreen = false;

  // A page switch interrupts queued work; a late failed request cannot taint the new tab.
  get("history-close-button").click();
  failures.set("abc1", "network");
  broken = true;
  hold = true;
  openHistory(get("history-tool-button"));
  get("history-page-next").click();
  await settle();
  get("history-filter-favorites").click();
  hold = false;
  for (const resume of releases) resume();
  await settle();
  assert.equal(get("history-filter-favorites").getAttribute("aria-selected"), "true");
  assert.equal(get("history-preview-status").textContent.includes("could not load"), false, "stale failure is ignored");
  get("history-close-button").click();
  await settle();

  // Source cooldowns disable manual retry without repeatedly hammering the provider.
  const realNow = Date.now;
  const realTimeout = globalThis.setTimeout;
  let now = realNow();
  let resumeCooldown;
  Date.now = () => now;
  globalThis.setTimeout = (run, delay, ...args) => {
    if (delay >= 2000) {
      resumeCooldown = run;
      return 0;
    }
    return realTimeout(run, delay, ...args);
  };
  t.after(() => {
    Date.now = realNow;
    globalThis.setTimeout = realTimeout;
  });
  for (const [index, kind] of ["upstream-rate-limited", "upstream-forbidden"].entries()) {
    const frame = { source: "prntsc", id: `rate0${index}`, sourcePageUrl: "", viewedAt: 1, addedAt: 1 };
    state.history = [frame];
    state.index = 0;
    state.library = libraryOf([frame]);
    state.favorites = state.library.items;
    failures.set(frame.id, kind);
    broken = true;
    openHistory(get("history-tool-button"));
    await settle();
    assert.match(get("history-preview-status").textContent, /wait a moment/);
    const attempts = requestCount();
    retry.click();
    retry.click();
    await settle();
    assert.equal(requestCount(), attempts, "cooldown prevents extra attempts");
    assert.equal(retry.getAttribute("aria-disabled"), "true");
    now += 10001;
    resumeCooldown();
    assert.equal(retry.getAttribute("aria-disabled"), "false");
    broken = false;
    retry.focus();
    retry.click();
    await settle();
    assert.equal(requestCount(), attempts + 1);
    assert.equal(document.activeElement, retry);
    assert.equal(get("history-filter-favorites").getAttribute("aria-selected"), "true");
    assert.match(get("history-preview-status").textContent, /Previews loaded/);
    get("history-close-button").click();
    await settle();
    assert.equal(document.activeElement, get("history-tool-button"), "close restores the opener");
  }
});

test("preview source retries retain the existing bounded local rate-limit protection", async (t) => {
  const originalWindow = globalThis.window;
  const originalTimeout = globalThis.setTimeout;
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.setTimeout = originalTimeout;
  });
  let attempts = 0,
    succeed = true;
  const delays = [];
  globalThis.setTimeout = (run, delay) => {
    delays.push(delay);
    queueMicrotask(run);
    return 0;
  };
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command) => {
        assert.equal(command, "get_thumbnail_image");
        attempts++;
        if (!succeed || attempts <= 2) throw { kind: "rate-limited" };
        return new Uint8Array([1]).buffer;
      },
    },
  };
  const { getThumbnailBlob } = await import("../dist/test-client/api.js");
  assert.equal((await getThumbnailBlob("abc123", "prntsc")).size, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [350, 350]);
  attempts = 0;
  delays.length = 0;
  succeed = false;
  await assert.rejects(getThumbnailBlob("abc123", "prntsc"), (error) => error.kind === "rate-limited");
  assert.equal(attempts, 21);
  assert.equal(delays.length, 20);
  assert.ok(delays.every((delay) => delay === 350));
});
