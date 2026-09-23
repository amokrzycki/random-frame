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
  // Unique-id counts classified since tracking began; see formatExploredBreakdown.
  viewable: number;
  unavailable: number;
}

export interface DailyActivity {
  date: string;
  viewed: number;
  rejected: number;
}

export interface ViewingActivity {
  viewedTotal: number;
  days: DailyActivity[];
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
