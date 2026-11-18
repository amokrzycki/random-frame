import { invoke } from "@tauri-apps/api/core";

export type SyncState = "unpaired" | "idle" | "syncing" | "updating_key" | "offline" | "error";

export interface DeviceSummary {
  deviceId: string;
  displayName: string;
  platform: string;
  joinedAtMs: number;
  lastSyncedAtMs: number | null;
  thisDevice: boolean;
  memberId: string | null;
  status: string | null;
  isMaster: boolean;
}

export interface SyncStatus {
  supported: boolean;
  paired: boolean;
  state: SyncState;
  lastSuccessAt: number | null;
  lastSuccessRevision: number | null;
  dirty: boolean;
  lastErrorCategory: string | null;
  thisDeviceId: string | null;
  devices: DeviceSummary[];
  groupState: string | null;
  membershipState: string | null;
  masterMemberId: string | null;
  thisMemberId: string | null;
  credentialVersion: number | null;
  keyEpoch: number | null;
  controlVerifiedAt: number | null;
  codeReady: boolean;
}

export interface SyncError {
  category: string;
  details?: unknown;
}

export interface CreateSyncResult {
  code: string | null;
  status: SyncStatus;
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
  collections: number;
  collectionRemovals: number;
  memberships: number;
  membershipRemovals: number;
  activityRemovals: number;
  meaningful: boolean;
}

export const getSyncJoinSummary = (): Promise<LocalSyncSummary> => invoke("get_sync_join_summary");
export const joinSync = (code: string, mode: JoinMode): Promise<SyncStatus> => invoke("join_sync", { code, mode });
let syncing: Promise<SyncStatus> | undefined;
function synchronize(command: "sync_now" | "startup_sync"): Promise<SyncStatus> {
  syncing ??= invoke<SyncStatus>(command).finally(() => {
    syncing = undefined;
  });
  return syncing;
}
export const syncNow = (): Promise<SyncStatus> => synchronize("sync_now");
export const startupSync = (): Promise<SyncStatus> => synchronize("startup_sync");
export const leaveSync = (): Promise<SyncStatus> => invoke("leave_sync");
export const getSyncCode = (): Promise<string> => invoke("get_sync_code");
export const newSyncCode = (): Promise<string> => invoke("new_sync_code");
export const removeSyncDevice = (memberId: string): Promise<SyncStatus> => invoke("remove_sync_device", { memberId });
export const dissolveSync = (): Promise<SyncStatus> => invoke("dissolve_sync");
