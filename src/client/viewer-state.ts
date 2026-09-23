import { elements } from "./elements.js";
import { loadPageSize } from "./history-pagination.js";
import type { HistoryItem, HistorySnapshot } from "./persistence.js";
import type { LedgerDay } from "./statistics.js";

// Single owner of the viewer's cross-cutting runtime state; feature modules read and
// update the fields relevant to their own responsibility instead of holding copies.
export const state = {
  history: [] as HistoryItem[],
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
