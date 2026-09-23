import { invoke } from "@tauri-apps/api/core";

export type SyncState = "unpaired" | "idle" | "syncing" | "offline" | "error";

export interface SyncStatus {
  paired: boolean;
  state: SyncState;
  lastSuccessRevision: number | null;
  dirty: boolean;
  lastErrorCategory: string | null;
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
export const joinSync = (recoveryKey: string): Promise<SyncStatus> => invoke("join_sync", { recoveryKey });
export const syncNow = (): Promise<SyncStatus> => invoke("sync_now");
export const startupSync = (): Promise<SyncStatus> => invoke("startup_sync");
export const leaveSync = (): Promise<SyncStatus> => invoke("leave_sync");
