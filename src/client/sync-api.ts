import { invoke } from "@tauri-apps/api/core";

export type SyncState = "unpaired" | "idle" | "syncing" | "offline" | "error";

export interface DeviceSummary {
  deviceId: string;
  displayName: string;
  platform: string;
  joinedAt: number;
  lastSyncedAt: number | null;
  thisDevice: boolean;
}

export interface SyncStatus {
  supported: boolean;
  paired: boolean;
  state: SyncState;
  lastSuccessAt: number | null;
  lastSuccessRevision: number | null;
  dirty: boolean;
  lastErrorCategory: string | null;
  snapshotSchemaVersion: number;
  thisDeviceId: string | null;
  devices: DeviceSummary[];
}

export interface SyncError {
  category: string;
  details?: { local_revision: number; remote_revision: number };
}

export interface CreateSyncResult {
  recoveryKey: string;
  status: SyncStatus;
  localPairingError: SyncError | null;
}

export const getSyncStatus = (): Promise<SyncStatus> => invoke("get_sync_status");
export const createSync = (): Promise<CreateSyncResult> => invoke("create_sync");
// Restore: this device takes the Sync's copy and publishes nothing of its own.
// Merge: this device's synced data, deletions included, is combined with the Sync's.
export type JoinMode = "restore" | "merge";

// Counts only; the native side never sends identifiers.
export interface LocalSyncSummary {
  history: number;
  historyRemovals: number;
  favorites: number;
  favoriteRemovals: number;
  activityRemovals: number;
  meaningful: boolean;
}

export const getSyncJoinSummary = (): Promise<LocalSyncSummary> => invoke("get_sync_join_summary");
export const joinSync = (recoveryKey: string, mode: JoinMode): Promise<SyncStatus> =>
  invoke("join_sync", { recoveryKey, mode });
export const syncNow = (): Promise<SyncStatus> => invoke("sync_now");
export const startupSync = (): Promise<SyncStatus> => invoke("startup_sync");
export const leaveSync = (): Promise<SyncStatus> => invoke("leave_sync");
export const setSyncDeviceName = (name: string): Promise<void> => invoke("set_sync_device_name", { name });
export const getSyncRecoveryKey = (): Promise<string> => invoke("get_sync_recovery_key");
