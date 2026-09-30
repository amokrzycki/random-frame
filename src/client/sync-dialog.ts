import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { syncControls } from "./stage.js";
import { createSync, getSyncStatus, joinSync, leaveSync, type SyncStatus, startupSync, syncNow } from "./sync-api.js";
import { toast } from "./toast.js";
import { refreshPersistedView, state } from "./viewer-state.js";

const OFFLINE = "You’re offline. Try again when you’re back online.";
const OLDER_DATA = "Synced data looks older than what this device already has, so it was not applied.";

const errorCopy: Record<string, string> = {
  invalid_endpoint: "Sync isn’t available because no server is set up.",
  invalid_recovery_key: "This recovery key is not valid.",
  already_paired: "This device is already using Sync.",
  unpaired: "Sync isn’t turned on for this device.",
  already_syncing: "Sync is already in progress.",
  corrupt_local_state: "Sync settings on this device are damaged.",
  secure_storage: "This device’s secure storage isn’t available.",
  persistence: "Sync data could not be saved on this device.",
  invalid_remote_data: "Synced data could not be verified, so it was not applied.",
  offline: OFFLINE,
  timeout: "Sync took too long to respond. Try again.",
  tls: "Sync could not make a secure connection. Try again.",
  malformed_response: "Sync got a response it couldn’t read. Try again.",
  missing_chain: "This Sync could not be reached. Check the key and try again.",
  conflict: "Another device just synced. Try again.",
  rate_limited: "Give it a moment. Sync is busy, so try again shortly.",
  server_error: "Sync is unavailable right now. Try again later.",
  body_too_large: "Your synced data is too large to upload.",
  rollback_detected: OLDER_DATA,
  server_rollback_detected: OLDER_DATA,
};

function category(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("category" in error)) return null;
  return typeof error.category === "string" ? error.category : null;
}

// Errors the visitor has to fix first; running the same request again cannot help.
const notRetryable = new Set([
  "invalid_endpoint",
  "invalid_recovery_key",
  "already_paired",
  "unpaired",
  "corrupt_local_state",
  "body_too_large",
  "rollback_detected",
  "server_rollback_detected",
]);

function safeError(error: unknown): string {
  return errorCopy[category(error) ?? ""] ?? "Sync could not complete. Try again.";
}

let status: SyncStatus | null = null;
let busy = false;
let busyMessage = "";
let opener: HTMLElement | null = null;
let refreshAfterInitialize = false;
// What Try again repeats: the failed action, or the status check itself.
let retryAction: (() => Promise<unknown>) | null = null;

function showError(message: string, retry: (() => Promise<unknown>) | null = null): void {
  retryAction = retry;
  elements.syncErrorMessage.textContent = message;
  elements.syncRetry.hidden = !retry;
  elements.syncError.hidden = false;
  render();
}

function clearError(): void {
  retryAction = null;
  elements.syncErrorMessage.textContent = "";
  elements.syncError.hidden = true;
}

// Only problems flag the titlebar: a quiet icon means Sync is fine or not in use.
function setStatus(next: SyncStatus): void {
  status = next;
  const attention = next.paired && (next.state === "error" || next.state === "offline" || next.lastErrorCategory);
  if (attention) elements.toolsMenuButton.dataset.sync = "attention";
  else delete elements.toolsMenuButton.dataset.sync;
  if (attention) elements.syncButton.dataset.sync = "attention";
  else delete elements.syncButton.dataset.sync;
  elements.syncButton.setAttribute("aria-label", attention ? "Sync needs attention" : "Sync");
  // The dot is visual only; the name carries it for assistive technology.
  const label = attention ? "More, Sync needs attention" : "More";
  elements.toolsMenuButton.setAttribute("aria-label", label);
  elements.toolsMenuButton.dataset.tip = label;
}

const lastSyncedKey = "random-frame-last-synced";

function markSynced(value: SyncStatus): void {
  if (!value.paired || value.state !== "idle" || value.lastErrorCategory) return;
  try {
    localStorage.setItem(lastSyncedKey, String(Date.now()));
  } catch {
    // The time is a courtesy; Sync itself does not depend on it.
  }
}

// Time alone for today, date and time otherwise.
function lastSyncedAt(): string | null {
  try {
    const stored = Number(localStorage.getItem(lastSyncedKey));
    if (!stored) return null;
    const when = new Date(stored);
    const today = when.toDateString() === new Date().toDateString();
    return when.toLocaleString(undefined, today ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return null;
  }
}

function statusMessage(value: SyncStatus): string {
  if (value.state === "syncing") return "Syncing…";
  if (value.lastErrorCategory) return errorCopy[value.lastErrorCategory] ?? "Sync needs attention.";
  if (value.state === "offline") return OFFLINE;
  if (value.state === "error") return "Sync needs attention.";
  if (value.dirty) return "Changes waiting to sync";
  const at = lastSyncedAt();
  return at ? `Up to date · last synced ${at}` : "Up to date";
}

function render(): void {
  const paired = status?.paired ?? false;
  const showingKey = Boolean(elements.syncRecoveryKey.textContent);
  // An error already says what is wrong; the status line steps aside so the message appears once.
  // Not being paired is the default, not a status: the copy below already offers to turn Sync on.
  // While the key shows, nothing on the line is news: the key and its checkbox are the whole task.
  const idleUnpaired = !busy && status !== null && !status.paired && !status.lastErrorCategory;
  elements.syncStatus.hidden = showingKey || !elements.syncError.hidden || idleUnpaired;
  elements.syncStatus.textContent = busy ? busyMessage : status ? statusMessage(status) : "Checking Sync status…";
  elements.syncStatus.dataset.state = busy
    ? "syncing"
    : status?.lastErrorCategory
      ? "error"
      : (status?.state ?? "unpaired");
  elements.syncUnpaired.hidden = paired || showingKey || !status;
  elements.syncRecovery.hidden = !showingKey;
  elements.syncPaired.hidden = !paired || showingKey || !elements.syncLeaveConfirm.hidden;
  // The status line already says so when idle; offline and error states hide it.
  const settled = status?.state === "idle" && !status?.lastErrorCategory;
  elements.syncDirty.textContent = paired && status?.dirty && !settled ? "Changes waiting to sync" : "";
  elements.syncNow.disabled = busy || status?.state === "syncing";
  elements.syncEnable.disabled = busy || !status;
  elements.syncJoin.disabled = busy || !status;
  elements.syncLeave.disabled = busy || status?.state === "syncing";
  elements.syncLeaveConfirmButton.disabled = busy;
  elements.syncClose.disabled = busy || (showingKey && !elements.syncKeySaved.checked);
  // aria-disabled, not disabled: the note above already explains the gate, so Done keeps full strength and focus.
  elements.syncDone.setAttribute("aria-disabled", String(busy || !elements.syncKeySaved.checked));
}

async function refresh(): Promise<void> {
  try {
    setStatus(await getSyncStatus());
    if (retryAction === refresh) clearError();
    if (elements.syncDialog.open) render();
  } catch (error) {
    // An action's own error is worth more than a failed follow-up check.
    if (elements.syncDialog.open && elements.syncError.hidden) showError(safeError(error), refresh);
  }
}

async function refreshView(): Promise<boolean> {
  try {
    await refreshPersistedView();
    syncControls();
    if (retryAction === refreshView) clearError();
    render();
    return true;
  } catch (error) {
    showError(`Sync completed, but saved data could not be reloaded. ${safeError(error)}`, refreshView);
    return false;
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
    let result: SyncStatus;
    try {
      result = await action();
    } catch (error) {
      showError(safeError(error), notRetryable.has(category(error) ?? "") ? null : () => operate(message, action));
      await refresh();
      return false;
    }
    setStatus(result);
    markSynced(result);
    if (!state.loading && !(await refreshView())) return false;
    await refresh();
    render();
    return true;
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
  elements.syncDone.addEventListener("click", () => {
    if (elements.syncDone.getAttribute("aria-disabled") === "true") {
      if (!busy) elements.syncKeySaved.focus();
      return;
    }
    closeDialog(elements.syncDialog);
  });
  elements.syncRetry.addEventListener("click", async () => {
    const again = retryAction;
    clearError();
    await again?.();
    // The button just left the page; keep focus inside the dialog, on the error if it came back.
    if (!elements.syncDialog.contains(document.activeElement))
      (elements.syncError.hidden ? elements.syncClose : elements.syncRetry).focus();
  });
  elements.syncKeySaved.addEventListener("change", render);
  elements.syncDialog.addEventListener("close", () => {
    elements.syncRecoveryKey.textContent = "";
    elements.syncKeySaved.checked = false;
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
      elements.syncKeySaved.focus();
      return result.status;
    });
  });
  elements.syncCopyKey.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.syncRecoveryKey.textContent);
      toast.success("Recovery key copied");
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
    elements.syncLeaveCancel.focus();
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
    setStatus(await startupSync());
    if (status) markSynced(status);
    if (state.loading) refreshAfterInitialize = true;
    else {
      await refreshPersistedView();
      syncControls();
    }
  } catch {
    // Rust keeps the typed error in SyncStatus; read it for the titlebar flag. An unpaired device needs no notice.
    await refresh();
    return;
  }
  if (elements.syncDialog.open) await refresh();
}

export async function refreshAfterStartup(): Promise<void> {
  if (!refreshAfterInitialize) return;
  refreshAfterInitialize = false;
  await refreshPersistedView();
  syncControls();
}
