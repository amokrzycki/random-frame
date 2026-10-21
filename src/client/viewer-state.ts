import { elements } from "./elements.js";
import { getSavedLibrary, operationKey, type SavedItem, type SavedLibrary } from "./favorites.js";
import { loadPageSize, parsePageSize } from "./history-pagination.js";
import type { HistoryItem, HistorySnapshot } from "./persistence.js";
import { getHistory } from "./persistence.js";
import type { LedgerDay } from "./statistics.js";
import { refreshUserPreferences } from "./user-preferences.js";

// Single owner of the viewer's cross-cutting runtime state; feature modules read and
// update the fields relevant to their own responsibility instead of holding copies.
export const state = {
  history: [] as HistoryItem[],
  favorites: [] as SavedItem[],
  library: { items: [], collections: [], memberships: [] } as SavedLibrary,
  savedFilter: "all",
  navigationSavedFilter: "all",
  index: -1,
  loading: true,
  // A network draw in flight, as opposed to any loading; only this spins the Draw button.
  drawing: false,
  historyLoadFailed: false,
  pageSize: loadPageSize(),
  pageIndex: 0,
  historyTab: "history" as "history" | "favourites",
  historyReset: false,
  navigationMode: "history" as "history" | "favourites",
  focusBeforeLoading: null as Element | null,
  historyReturnFocus: elements.toolsMenuButton as HTMLElement,
  ledger: [] as LedgerDay[],
  ledgerShown: 0,
};

let historyGeneration = 0;
let favoritesGeneration = 0;
let refreshRequested = false;
let refreshPromise: Promise<void> | undefined;
let resumeRefresh: (() => void) | undefined;

// Resume through a promise so intermediate idle transitions can start follow-up navigation first.
export function setViewerLoading(loading: boolean): Promise<void> | undefined {
  state.loading = loading;
  if (!loading) resumeRefresh?.();
  return refreshPromise;
}

export function applyHistory(snapshot: HistorySnapshot): void {
  historyGeneration++;
  state.history.splice(0, state.history.length, ...snapshot.history);
  state.index = snapshot.index;
}

export function applySavedLibrary(library: SavedLibrary): void {
  favoritesGeneration++;
  state.library = library;
  state.favorites.splice(0, state.favorites.length, ...library.items);
  const collectionExists = library.collections.some((c) => operationKey(c.collectionId) === state.savedFilter);
  if (state.savedFilter !== "all" && state.savedFilter !== "none" && !collectionExists) state.savedFilter = "all";
  if (state.savedFilter === "none" && !uncollectedItems().length) state.savedFilter = "all";
  const current = state.history[state.index];
  if (current && !isFavorite(current)) state.navigationMode = "history";
  else if (
    current &&
    state.navigationMode === "favourites" &&
    !filteredSavedItems(state.navigationSavedFilter).some((x) => x.source === current.source && x.id === current.id)
  )
    state.navigationSavedFilter = "all";
}

// Favorites keep the same newest-first positions as the dialog; history keeps its frame numbers.
export function navigationView(): { items: (HistoryItem | SavedItem)[]; index: number } {
  const current = state.history[state.index];
  if (state.navigationMode === "favourites" && current && isFavorite(current)) {
    const items = filteredSavedItems(state.navigationSavedFilter).slice().reverse();
    return { items, index: items.findIndex((item) => item.source === current.source && item.id === current.id) };
  }
  return { items: state.history, index: state.index };
}

export function isFavorite(frame: { source: string; id: string }): boolean {
  return state.favorites.some((favorite) => favorite.source === frame.source && favorite.id === frame.id);
}

export function uncollectedItems(): SavedItem[] {
  const assigned = new Set(state.library.memberships.map((m) => operationKey(m.favoriteOperationId)));
  return state.favorites.filter((item) => !item.saveOperationIds.some((id) => assigned.has(operationKey(id))));
}
export function filteredSavedItems(filter = state.savedFilter): SavedItem[] {
  if (filter === "all") return state.favorites;
  if (filter === "none") return uncollectedItems();
  const assigned = new Set(
    state.library.memberships
      .filter((m) => operationKey(m.collectionId) === filter)
      .map((m) => operationKey(m.favoriteOperationId)),
  );
  return state.favorites.filter((item) => item.saveOperationIds.some((id) => assigned.has(operationKey(id))));
}
let libraryMutations: Promise<unknown> = Promise.resolve();
let libraryPending = 0;
export function mutateSavedLibrary<T>(run: () => Promise<T>): Promise<T> {
  favoritesGeneration++;
  libraryPending++;
  const result = libraryMutations.then(run).finally(() => {
    libraryPending--;
  });
  libraryMutations = result.catch(() => undefined);
  return result;
}

export function refreshPersistedView(): Promise<void> {
  refreshRequested = true;
  // Same-turn requests share a read; requests during a read require one more pass.
  refreshPromise ??= Promise.resolve().then(async () => {
    try {
      while (refreshRequested) {
        if (state.loading) await new Promise<void>((resolve) => (resumeRefresh = resolve));
        if (state.loading) continue;
        resumeRefresh = undefined;
        refreshRequested = false;
        try {
          const historyAtStart = historyGeneration;
          const favoritesAtStart = favoritesGeneration;
          await libraryMutations;
          const [history, library] = await Promise.all([getHistory(), getSavedLibrary()]);
          await refreshUserPreferences();
          const historyStale = state.loading || historyAtStart !== historyGeneration;
          const favoritesStale = libraryPending > 0 || favoritesAtStart !== favoritesGeneration;
          // Only the domain overtaken by an interaction is stale. Other remote changes remain useful.
          if (!historyStale) {
            const current = state.history[state.index];
            applyHistory({
              ...history,
              index: current
                ? history.history.findIndex((item) => item.source === current.source && item.id === current.id)
                : -1,
            });
          }
          if (!favoritesStale) applySavedLibrary(library);
          if (historyStale || favoritesStale) refreshRequested = true;
          // Open dialogs and the stage redraw from each accepted projection without moving focus.
          if (!historyStale || !favoritesStale) document.dispatchEvent(new CustomEvent("persisted-view-refreshed"));
        } catch (error) {
          // A later request still deserves its own read, even when the preceding read failed.
          if (!refreshRequested) throw error;
        }
      }
    } finally {
      // A failed read rejects the shared request; only an explicit request retries it.
      refreshPromise = undefined;
      refreshRequested = false;
      resumeRefresh = undefined;
    }
  });
  return refreshPromise;
}

document.addEventListener("user-preferences", (event) => {
  const size = (event as CustomEvent).detail?.historyPageSize;
  if (size) state.pageSize = parsePageSize(size);
});
