import { invoke } from "@tauri-apps/api/core";

export type SyncState = "unpaired" | "idle" | "syncing" | "updating_key" | "offline" | "error" | "upgrade_required";

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
  snapshotSchemaVersion: number;
  thisDeviceId: string | null;
  devices: DeviceSummary[];
  groupState: string | null;
  membershipState: string | null;
  masterMemberId: string | null;
  thisMemberId: string | null;
  credentialVersion: number | null;
  keyEpoch: number | null;
  controlVerifiedAt: number | null;
  legacySourceId: string | null;
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
export const createSync = (): Promise<CreateManagedSyncResult> => invoke("create_sync");
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
export const joinSync = (recoveryKey: string, mode: JoinMode): Promise<SyncStatus> =>
  invoke("join_sync", { recoveryKey, mode });
export const syncNow = (): Promise<SyncStatus> => invoke("sync_now");
export const startupSync = (): Promise<SyncStatus> => invoke("startup_sync");
export const leaveSync = (): Promise<SyncStatus> => invoke("leave_sync");
export const setSyncDeviceName = (name: string): Promise<void> => invoke("set_sync_device_name", { name });
export const getSyncRecoveryKey = (): Promise<string> => invoke("get_sync_recovery_key");

export const approveSyncUpgrade = (recoveryKey?: string): Promise<void> =>
  invoke("approve_sync_upgrade", { recoveryKey });
export interface CreateManagedSyncResult {
  groupId: string;
  adminRecoveryCode: string;
  status: SyncStatus;
  sourceLegacyId: string | null;
  prepared: boolean;
}
export const getSyncPairingRequest = (): Promise<string> => invoke("get_sync_pairing_request");
export const createSyncInvitation = (request: string): Promise<string> => invoke("create_sync_invitation", { request });
export const moveToManagedSync = (): Promise<CreateManagedSyncResult> => invoke("move_to_managed_sync");
export const recoverSyncAdmin = (code: string, confirmed = false): Promise<CreateManagedSyncResult> =>
  invoke("recover_sync_admin", { code, confirmed });
export const removeSyncDevice = (memberId: string): Promise<SyncStatus> => invoke("remove_sync_device", { memberId });
export const dissolveSync = (): Promise<SyncStatus> => invoke("dissolve_sync");

export const cancelSyncAdminRecovery = (): Promise<void> => invoke("cancel_sync_admin_recovery");

export const getSyncInvitation = (): Promise<string> => invoke("get_sync_invitation");
