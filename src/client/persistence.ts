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
}

export function getHistory(): Promise<HistorySnapshot> {
  return invoke("get_history");
}

export function recordHistoryItem(item: HistoryItem): Promise<HistorySnapshot> {
  return invoke("record_history_item", { item });
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
