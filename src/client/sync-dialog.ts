import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { createSync, getSyncStatus, joinSync, leaveSync, type SyncStatus, startupSync, syncNow } from "./sync-api.js";

const errorCopy: Record<string, string> = {
  invalid_endpoint: "Sync is unavailable because its server is not configured.",
  invalid_recovery_key: "This recovery key is not valid.",
  already_paired: "This device is already paired.",
  unpaired: "Sync is not configured on this device.",
  already_syncing: "Sync is already in progress.",
  corrupt_local_state: "Local Sync configuration is inconsistent.",
  secure_storage: "Secure credential storage is unavailable.",
  persistence: "Local Sync data could not be saved.",
  invalid_remote_data: "Remote Sync data could not be verified.",
  offline: "Offline — local exploration still works.",
  timeout: "Sync server did not respond in time.",
  tls: "A secure connection to the Sync server could not be made.",
  malformed_response: "Sync server sent an unexpected response.",
  missing_chain: "This Sync could not be reached. Check the key and try again.",
  conflict: "Sync changed on another device. Try again.",
  rate_limited: "Sync is temporarily rate limited.",
  server_error: "Sync server is unavailable.",
  body_too_large: "Sync data is too large for the server.",
  rollback_detected: "Remote Sync state appears older than the state previously accepted by this device.",
  server_rollback_detected: "Remote Sync state appears older than the state previously accepted by this device.",
};

function category(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("category" in error)) return null;
  return typeof error.category === "string" ? error.category : null;
}

function safeError(error: unknown): string {
  return errorCopy[category(error) ?? ""] ?? "Sync could not complete. Try again.";
}

let status: SyncStatus | null = null;
let busy = false;
let busyMessage = "";
let opener: HTMLElement | null = null;

function showError(message: string): void {
  elements.syncError.textContent = message;
  elements.syncError.hidden = false;
}

function clearError(): void {
  elements.syncError.textContent = "";
  elements.syncError.hidden = true;
}

function statusMessage(value: SyncStatus): string {
  if (value.state === "syncing") return "Syncing…";
  if (value.lastErrorCategory) return errorCopy[value.lastErrorCategory] ?? "Sync needs attention.";
  if (!value.paired) return "Sync is not configured on this device.";
  if (value.state === "offline") return "Offline — local exploration still works.";
  if (value.state === "error") return "Sync needs attention.";
  return value.dirty ? "Local changes waiting to sync" : "Synced";
}

function render(): void {
  const paired = status?.paired ?? false;
  const showingKey = Boolean(elements.syncRecoveryKey.textContent);
  elements.syncStatus.textContent = busy ? busyMessage : status ? statusMessage(status) : "Checking Sync status…";
  elements.syncStatus.dataset.state = busy
    ? "syncing"
    : status?.lastErrorCategory
      ? "error"
      : (status?.state ?? "unpaired");
  elements.syncUnpaired.hidden = paired || showingKey || !status;
  elements.syncRecovery.hidden = !showingKey;
  elements.syncPaired.hidden = !paired || showingKey || !elements.syncLeaveConfirm.hidden;
  elements.syncRevision.textContent =
    status?.lastSuccessRevision == null ? "" : `Last accepted revision: ${status.lastSuccessRevision}`;
  elements.syncDirty.textContent = paired ? `Local changes pending: ${status?.dirty ? "yes" : "no"}` : "";
  elements.syncNow.disabled = busy || status?.state === "syncing";
  elements.syncEnable.disabled = busy || !status;
  elements.syncJoin.disabled = busy || !status;
  elements.syncLeave.disabled = busy || status?.state === "syncing";
  elements.syncLeaveConfirmButton.disabled = busy;
  elements.syncClose.disabled = busy;
}

async function refresh(): Promise<void> {
  try {
    status = await getSyncStatus();
    if (elements.syncDialog.open) render();
  } catch (error) {
    if (elements.syncDialog.open) showError(safeError(error));
  }
}

async function operate(message: string, action: () => Promise<SyncStatus>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  busyMessage = message;
  elements.syncDialog.dataset.busy = "true";
  clearError();
  render();
  try {
    status = await action();
    await refresh();
    render();
    return true;
  } catch (error) {
    showError(safeError(error));
    await refresh();
    return false;
  } finally {
    busy = false;
    delete elements.syncDialog.dataset.busy;
    render();
  }
}

export function bindSyncDialogEvents(): void {
  elements.syncButton.addEventListener("click", () => {
    if (elements.syncDialog.open) {
      void refresh();
      return;
    }
    opener = document.activeElement as HTMLElement | null;
    clearError();
    render();
    openDialog(elements.syncDialog);
    elements.syncClose.focus();
    void refresh();
  });
  elements.syncClose.addEventListener("click", () => closeDialog(elements.syncDialog));
  elements.syncDialog.addEventListener("close", () => {
    elements.syncRecoveryKey.textContent = "";
    elements.syncRecoveryInput.value = "";
    elements.syncJoinForm.hidden = true;
    elements.syncLeaveConfirm.hidden = true;
    clearError();
    onDialogClosed();
    (opener ?? elements.syncButton).focus?.();
  });
  elements.syncShowJoin.addEventListener("click", () => {
    elements.syncJoinForm.hidden = false;
    elements.syncRecoveryInput.focus();
  });
  elements.syncJoinCancel.addEventListener("click", () => {
    elements.syncJoinForm.hidden = true;
    elements.syncRecoveryInput.value = "";
    elements.syncShowJoin.focus();
  });
  elements.syncEnable.addEventListener("click", () => {
    void operate("Setting up Sync…", async () => {
      const result = await createSync();
      elements.syncRecoveryKey.textContent = result.recoveryKey;
      if (result.localPairingError) showError(safeError(result.localPairingError));
      elements.syncCopyKey.focus();
      return result.status;
    });
  });
  elements.syncCopyKey.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.syncRecoveryKey.textContent);
      elements.syncStatus.textContent = "Recovery key copied. Save it somewhere safe.";
    } catch {
      showError("Could not copy the key. Select and copy it manually.");
    }
  });
  elements.syncJoinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void operate("Joining Sync…", async () => {
      const result = await joinSync(elements.syncRecoveryInput.value.trim());
      elements.syncRecoveryInput.value = "";
      elements.syncJoinForm.hidden = true;
      return result;
    });
  });
  elements.syncNow.addEventListener("click", () => void operate("Syncing…", syncNow));
  elements.syncLeave.addEventListener("click", () => {
    elements.syncLeaveConfirm.hidden = false;
    render();
    elements.syncLeaveConfirmButton.focus();
  });
  elements.syncLeaveCancel.addEventListener("click", () => {
    elements.syncLeaveConfirm.hidden = true;
    render();
    elements.syncLeave.focus();
  });
  elements.syncLeaveConfirmButton.addEventListener("click", () => {
    void operate("Leaving Sync…", async () => {
      const result = await leaveSync();
      elements.syncLeaveConfirm.hidden = true;
      return result;
    });
  });
}

export async function runStartupSync(): Promise<void> {
  try {
    status = await startupSync();
  } catch {
    // Rust keeps the typed error in SyncStatus; an unpaired device needs no startup notice.
  }
  if (elements.syncDialog.open) await refresh();
}
