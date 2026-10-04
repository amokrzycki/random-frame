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
  frameViews?: FrameView[];
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
  lastView: ViewStamp;
}

export interface ViewStamp {
  at_ms: number;
  day: string;
  day_inferred: boolean;
}

export function removeHistoryItem(source: string, id: string): Promise<RemovedFrame> {
  return invoke("remove_history_item", { source, id });
}

export function restoreHistoryItem(item: HistoryItem, orderAt: number, lastView: ViewStamp): Promise<HistorySnapshot> {
  return invoke("restore_history_item", { item, orderAt, lastView });
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

export interface FrameView {
  source: string;
  id: string;
  atMs: number;
  day: string;
  dayInferred: boolean;
}

export interface UserPreferences {
  theme: "system" | "light" | "dark" | null;
  historyPageSize: number | null;
}

export function getUserPreferences(): Promise<UserPreferences> {
  return invoke("get_user_preferences");
}

export function setUserPreferences(
  preferences: Partial<UserPreferences>,
  legacyImport = false,
): Promise<UserPreferences> {
  return invoke("set_user_preferences", { preferences, legacyImport });
}

export function prepareHistoryClear(legacyPending = false): Promise<string> {
  return invoke("prepare_history_clear", { legacyPending });
}

export function commitHistoryClear(requestId: string): Promise<void> {
  return invoke("commit_history_clear", { requestId });
}

export function cancelHistoryClear(requestId: string): Promise<void> {
  return invoke("cancel_history_clear", { requestId });
}

export function importSessionHistory(items: HistoryItem[], index: number): Promise<HistorySnapshot> {
  return invoke("import_session_history", { items, index });
}

export function completeStateImports(): Promise<void> {
  return invoke("complete_state_imports");
}
