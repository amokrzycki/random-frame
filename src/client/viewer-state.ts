import { elements } from "./elements.js";
import type { FavoriteItem } from "./favorites.js";
import { getFavorites } from "./favorites.js";
import { loadPageSize } from "./history-pagination.js";
import type { HistoryItem, HistorySnapshot } from "./persistence.js";
import { getHistory } from "./persistence.js";
import type { LedgerDay } from "./statistics.js";
import { refreshUserPreferences } from "./user-preferences.js";

// Single owner of the viewer's cross-cutting runtime state; feature modules read and
// update the fields relevant to their own responsibility instead of holding copies.
export const state = {
  history: [] as HistoryItem[],
  favorites: [] as FavoriteItem[],
  index: -1,
  loading: true,
  // A network draw in flight, as opposed to any loading; only this spins the Draw button.
  drawing: false,
  historyLoadFailed: false,
  pageSize: loadPageSize(localStorage),
  pageIndex: 0,
  historyTab: "history" as "history" | "favourites",
  historyReset: false,
  navigationMode: "history" as "history" | "favourites",
  focusBeforeLoading: null as Element | null,
  historyReturnFocus: elements.toolsMenuButton as HTMLElement,
  ledger: [] as LedgerDay[],
  ledgerShown: 0,
};

export function applyHistory(snapshot: HistorySnapshot): void {
  state.history.splice(0, state.history.length, ...snapshot.history);
  state.index = snapshot.index;
}

export function applyFavorites(favorites: FavoriteItem[]): void {
  state.favorites.splice(0, state.favorites.length, ...favorites);
  const current = state.history[state.index];
  if (current && !isFavorite(current)) state.navigationMode = "history";
}

// Favorites keep the same newest-first positions as the dialog; history keeps its frame numbers.
export function navigationView(): { items: (HistoryItem | FavoriteItem)[]; index: number } {
  const current = state.history[state.index];
  if (state.navigationMode === "favourites" && current && isFavorite(current)) {
    const items = [...state.favorites].reverse();
    return { items, index: items.findIndex((item) => item.source === current.source && item.id === current.id) };
  }
  return { items: state.history, index: state.index };
}

export function isFavorite(frame: { source: string; id: string }): boolean {
  return state.favorites.some((favorite) => favorite.source === frame.source && favorite.id === frame.id);
}

export async function refreshPersistedView(): Promise<void> {
  const current = state.index >= 0 ? state.history[state.index] : undefined;
  const [history, favorites] = await Promise.all([getHistory(), getFavorites()]);
  await refreshUserPreferences();
  applyFavorites(favorites);
  applyHistory({
    ...history,
    index: current
      ? history.history.findIndex((item: HistoryItem) => item.source === current.source && item.id === current.id)
      : -1,
  });
  // Open dialogs built from this state (History, Stats) redraw themselves from it.
  document.dispatchEvent(new CustomEvent("persisted-view-refreshed"));
}

document.addEventListener("user-preferences", (event) => {
  const size = (event as CustomEvent).detail?.historyPageSize;
  if (size) state.pageSize = loadPageSize({ getItem: () => String(size) });
});
