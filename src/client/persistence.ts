import { invoke } from "@tauri-apps/api/core";

export interface HistoryItem {
  source: string;
  id: string;
  sourcePageUrl: string;
  viewedAt: number;
}

export interface HistorySnapshot {
  history: HistoryItem[];
  index: number;
}

export interface ExplorationStats {
  explored: number;
  total: number;
  viewable: number;
  unavailable: number;
  unclassified: number;
}

export interface DailyActivity {
  date: string;
  viewed: number;
  rejected: number;
}

export interface ViewingActivity {
  viewedTotal: number;
  days: DailyActivity[];
  localViewTimes: (number | null)[];
}

export function getHistory(): Promise<HistorySnapshot> {
  return invoke("get_history");
}

export function recordHistoryItem(item: HistoryItem, legacyImport = false): Promise<HistorySnapshot> {
  return invoke("record_history_item", { item, legacyImport });
}

export function selectHistoryItem(index: number): Promise<HistorySnapshot> {
  return invoke("select_history_item", { index });
}

// orderAt is the frame's place in history, handed back so an undo can restore it there.
export interface RemovedFrame {
  snapshot: HistorySnapshot;
  orderAt: number;
}

export function removeHistoryItem(source: string, id: string): Promise<RemovedFrame> {
  return invoke("remove_history_item", { source, id });
}

export function restoreHistoryItem(item: HistoryItem, orderAt: number): Promise<HistorySnapshot> {
  return invoke("restore_history_item", { item, orderAt });
}

export function clearHistory(): Promise<void> {
  return invoke("clear_history");
}

export function getExplorationStats(): Promise<ExplorationStats> {
  return invoke("get_exploration_stats");
}

export function getViewingActivity(): Promise<ViewingActivity> {
  return invoke("get_viewing_activity");
}

export function migrateViewingStats(legacyDay: string, legacyToday: number, legacyTotal: number): Promise<void> {
  return invoke("migrate_viewing_stats", { legacyDay, legacyToday, legacyTotal });
}
