// Saved-library memory-retention workload for the disposable native benchmark build.
// Runs after startup readiness when RF_MODE=retention; it never ships in production.
import { invoke } from "@tauri-apps/api/core";
import { closeDialog } from "../src/client/dialogs.ts";
import { elements } from "../src/client/elements.ts";
import { thumbnails } from "../src/client/frame-cache.ts";
import { openHistory } from "../src/client/history-dialog.ts";
import { state } from "../src/client/viewer-state.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, timeout = 60000) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) throw Error(`Retention condition timed out: ${predicate}`);
    await sleep(10);
  }
}
const count = (name) => __rf.ipc.filter((span) => span.name === name).length;

export async function retentionWorkload() {
  const checkpoints = [];
  const pages = [];
  const latencies = {};
  const live = () => {
    let chars = 0;
    for (const image of thumbnails.values()) chars += image.length;
    return { loaded: thumbnails.size, dataUrlChars: chars };
  };
  const mark = async (name, settle = 1000) => {
    await sleep(settle);
    checkpoints.push({
      name,
      at: performance.timeOrigin + performance.now(),
      ...live(),
      gridImages: elements.historyGrid.querySelectorAll("img").length,
      reads: count("read_thumbnail_cache"),
      saves: count("save_thumbnail_cache"),
      sourceCalls: count("get_thumbnail_image"),
    });
  };
  // Every visible tile resolved to a decoded image: loaded, not merely requested.
  const finishVisible = async () => {
    await paint();
    await until(() => {
      const body = elements.historyBody.getBoundingClientRect();
      const tiles = [...elements.historyGrid.querySelectorAll(".history-item")].filter((tile) => {
        const rect = tile.getBoundingClientRect();
        return rect.width > 0 && rect.bottom > body.top && rect.top < body.bottom;
      });
      return (
        tiles.length > 0 &&
        tiles.every((tile) => {
          const image = tile.querySelector("img");
          return !tile.hasAttribute("data-loading") && image?.complete && image.naturalWidth > 0;
        })
      );
    });
  };
  const scrollPage = async () => {
    const body = elements.historyBody;
    for (let y = 0; y < body.scrollHeight; y += Math.max(100, body.clientHeight - 140)) {
      body.scrollTop = y;
      await finishVisible();
    }
    body.scrollTop = body.scrollHeight;
    await finishVisible();
  };
  const closeSaved = async () => {
    closeDialog(elements.historyDialog);
    await until(() => !elements.historyDialog.open);
    await paint();
  };
  // Reopening restores the remembered page, so move with the real Next/Previous controls.
  // Intermediate renders are synchronous and their queued tile loads are cancelled.
  const jump = async (page) => {
    while (state.pageIndex !== page)
      (state.pageIndex < page ? elements.historyPageNext : elements.historyPagePrevious).click();
    await finishVisible();
  };
  const openSaved = async (page) => {
    state.historyTab = "favourites";
    state.savedFilter = "all";
    openHistory();
    await jump(page);
  };
  const timed = async (name, action) => {
    __rf.phase = name;
    const reads = count("read_thumbnail_cache");
    const start = performance.now();
    await action();
    await finishVisible();
    latencies[name] ??= [];
    latencies[name].push({ ms: performance.now() - start, reads: count("read_thumbnail_cache") - reads });
  };
  const total = () => Math.ceil(state.favorites.length / state.pageSize);
  const traverse = async (label) => {
    const last = total() - 1;
    if (state.pageIndex !== 0) throw Error("Traversal must start on the first page");
    for (let page = 0; page <= last; page++) {
      __rf.phase = `${label}-page`;
      await scrollPage();
      const visited = Math.min((page + 1) * state.pageSize, state.favorites.length);
      if (visited % 1000 === 0 || page === last) await mark(`${label}-${visited}`, 600);
      if (page < last) {
        await timed(`${label}-next`, () => elements.historyPageNext.click());
        pages.push({ label, page: page + 1 });
      }
    }
  };
  const diskFiles = async () => (await invoke("list_thumbnail_cache")).length;

  state.historyTab = "favourites";
  state.savedFilter = "all";
  state.pageIndex = 0;
  openHistory();
  elements.historyPageSize.value = "100";
  elements.historyPageSize.dispatchEvent(new Event("change"));
  await finishVisible();
  const library = state.favorites.length;
  const filesBefore = await diskFiles();
  await mark("start");

  await traverse("first");
  await closeSaved();
  await mark("first-closed");
  await sleep(15000);
  await mark("first-idle15s");

  // Second complete traversal: a bounded cache must neither leak nor thrash badly.
  await openSaved(0);
  await traverse("second");
  await closeSaved();
  await sleep(15000);
  await mark("second-idle15s");

  // Hits: Next+Previous and a short walk over pages the cache just held.
  const mid = Math.floor(total() / 2);
  await openSaved(mid);
  for (let i = 0; i < 20; i++) {
    await timed("pair-next", () => elements.historyPageNext.click());
    await timed("pair-previous", () => elements.historyPagePrevious.click());
  }
  await closeSaved();
  // Misses: long-ago pages reopened from disk, with the network never involved.
  for (const page of [0, Math.floor(total() / 4), mid, total() - 1, 1, Math.floor(total() / 3)]) {
    state.historyTab = "favourites";
    openHistory();
    await jump(page === 0 ? 1 : page - 1);
    await timed("revisit", () => (page === 0 ? elements.historyPagePrevious : elements.historyPageNext).click());
    if (state.pageIndex !== page) throw Error(`Revisit landed on page ${state.pageIndex}, not ${page}`);
    await closeSaved();
  }
  await mark("revisited");
  await sleep(15000);
  await mark("final-idle15s");
  const filesAfter = await diskFiles();
  if (filesAfter !== filesBefore) throw Error(`Disk thumbnails changed: ${filesBefore} -> ${filesAfter}`);
  if (count("get_thumbnail_image")) throw Error("Offline Saved browsing reached the source");
  return { library, filesBefore, filesAfter, checkpoints, latencies, pages: pages.length };
}
