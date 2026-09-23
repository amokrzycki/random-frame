import { elements } from "./elements.js";
import type { FavoriteItem } from "./favorites.js";
import { loadPageSize } from "./history-pagination.js";
import type { HistoryItem, HistorySnapshot } from "./persistence.js";
import type { LedgerDay } from "./statistics.js";

// Single owner of the viewer's cross-cutting runtime state; feature modules read and
// update the fields relevant to their own responsibility instead of holding copies.
export const state = {
  history: [] as HistoryItem[],
  favorites: [] as FavoriteItem[],
  index: -1,
  loading: true,
  // A network draw in flight, as opposed to any loading; only this spins the Draw next button.
  drawing: false,
  pageSize: loadPageSize(localStorage),
  pageIndex: 0,
  focusBeforeLoading: null as Element | null,
  historyReturnFocus: elements.historyButton as HTMLElement,
  ledger: [] as LedgerDay[],
  ledgerShown: 0,
};

export function applyHistory(snapshot: HistorySnapshot): void {
  state.history.splice(0, state.history.length, ...snapshot.history);
  state.index = snapshot.index;
}

export function applyFavorites(favorites: FavoriteItem[]): void {
  state.favorites.splice(0, state.favorites.length, ...favorites);
}

export function isFavorite(frame: { source: string; id: string }): boolean {
  return state.favorites.some((favorite) => favorite.source === frame.source && favorite.id === frame.id);
}
