import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { syncControls } from "./stage.js";
import {
  createSync,
  type DeviceSummary,
  getSyncJoinSummary,
  getSyncRecoveryKey,
  getSyncStatus,
  type JoinMode,
  joinSync,
  type LocalSyncSummary,
  leaveSync,
  type SyncStatus,
  setSyncDeviceName,
  startupSync,
  syncNow,
} from "./sync-api.js";
import { toast } from "./toast.js";
import { refreshPersistedView, state } from "./viewer-state.js";

const OFFLINE = "You’re offline. Try again when you’re back online.";
const OLDER_DATA = "The Sync server returned older data than this device has already seen, so it was not applied.";
const NOT_APPLIED = "Nothing was changed on this device or in your Sync.";

const errorCopy: Record<string, string> = {
  invalid_endpoint: "Sync isn’t available because no server is set up.",
  invalid_recovery_key: "This recovery key isn’t valid. Check that you copied all of it, then try again.",
  already_paired: "This device is already connected to a Sync.",
  unpaired: "This device isn’t connected to a Sync.",
  migration_pending: "Saved data is still loading. Try again when loading finishes.",
  already_syncing: "Sync is already in progress.",
  corrupt_local_state: "Sync settings on this device are damaged.",
  secure_storage: "This device’s secure storage isn’t available, so Sync can’t continue.",
  persistence: "Sync data could not be saved on this device.",
  unsupported_version: "This Sync was updated by a newer version of Random Frame. Update the app to continue.",
  unsupported_platform: "Sync isn’t available on this device.",
  schema_downgrade: `Synced data uses an older format, so it was not applied. ${NOT_APPLIED}`,
  invalid_remote_data: `Synced data could not be verified, so it was not applied. ${NOT_APPLIED}`,
  offline: OFFLINE,
  timeout: "Sync took too long to respond. Try again.",
  tls: "Sync could not make a secure connection. Try again.",
  malformed_response: "Sync got a response it couldn’t read. Try again.",
  missing_chain: "No Sync was found for this key. Check the key and try again.",
  conflict:
    "Other devices kept changing your Sync, so this sync couldn’t finish. Your data on this device is safe. Try again.",
  rate_limited: "Give it a moment. Sync is busy, so try again shortly.",
  server_error: "Sync is unavailable right now. Try again later.",
  body_too_large: "Your synced data is too large to upload. Nothing was removed.",
  rollback_detected: `${OLDER_DATA} ${NOT_APPLIED}`,
  server_rollback_detected: `${OLDER_DATA} ${NOT_APPLIED}`,
};

// Failures of the connection itself, as opposed to Sync data or this device needing attention.
const connectionProblems = new Set(["offline", "timeout", "tls", "server_error", "rate_limited"]);

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
  "unsupported_platform",
  "corrupt_local_state",
  "body_too_large",
  "unsupported_version",
  "schema_downgrade",
  "invalid_remote_data",
  "rollback_detected",
  "server_rollback_detected",
]);

function safeError(error: unknown): string {
  return errorCopy[category(error) ?? ""] ?? "Sync could not complete. Try again.";
}

const NAME_MAX = 128;

// Mirrors the native rule (1–128 characters after trimming, no control characters) so the reason is specific.
function nameProblem(name: string): string | null {
  if (!name) return "Enter a name for this device.";
  if ([...name].length > NAME_MAX) return `Use ${NAME_MAX} characters or fewer.`;
  if (/\p{Cc}/u.test(name)) return "Names can’t contain control characters.";
  return null;
}

// What this device holds before joining; null until read, or when it could not be read.
let joinSummary: LocalSyncSummary | null = null;
let joinSummaryLoaded = false;
let status: SyncStatus | null = null;
let checking = false;
let statusCheckFailed = false;
let busy = false;
let busyMessage = "";
let opener: HTMLElement | null = null;
let refreshAfterInitialize = false;
let nameEdited = false;
// What Try again repeats: the failed action, or the status check itself.
let retryAction: (() => Promise<unknown>) | null = null;

const count = new Intl.NumberFormat();
const plural = (n: number, one: string, many: string): string => `${count.format(n)} ${n === 1 ? one : many}`;

function totalDeletions(summary: LocalSyncSummary): number {
  return summary.historyRemovals + summary.favoriteRemovals + summary.activityRemovals;
}

// Streamlining is allowed only when the native check says nothing synced is saved here.
// A device that holds nothing but deletions is not empty.
function joinIsStreamlined(): boolean {
  return joinSummaryLoaded && joinSummary !== null && !joinSummary.meaningful;
}

// The one place a join mode is decided: the checked option, never a button label.
function selectedJoinMode(): JoinMode | null {
  if (joinIsStreamlined()) return "restore";
  if (elements.syncJoinMerge.checked) return "merge";
  if (elements.syncJoinRestore.checked) return "restore";
  return null;
}

function renderJoin(): void {
  const summary = joinSummary;
  const streamlined = joinIsStreamlined();
  elements.syncJoinFresh.hidden = !streamlined;
  elements.syncJoinModes.hidden = streamlined;
  const deletions = summary ? totalDeletions(summary) : 0;
  // Aggregate counts only. Deletions are the signal worth stating; the rest is context.
  const parts = summary
    ? [
        summary.history > 0 ? plural(summary.history, "history item", "history items") : "",
        summary.favorites > 0 ? plural(summary.favorites, "favorite", "favorites") : "",
        deletions > 0 ? plural(deletions, "previous deletion", "previous deletions") : "",
      ].filter(Boolean)
    : [];
  elements.syncJoinLocal.hidden = !summary?.meaningful;
  elements.syncJoinLocal.textContent = summary?.meaningful
    ? parts.length
      ? `This device currently has ${parts.join(", ")}.`
      : "This device already has saved data of its own."
    : "";
  elements.syncJoinMergeDeletions.hidden = deletions === 0;
  elements.syncJoinMergeDeletions.textContent =
    deletions > 0
      ? `This device has ${plural(deletions, "previous deletion", "previous deletions")} that will also be merged.`
      : "";
  const mode = selectedJoinMode();
  elements.syncJoin.textContent =
    mode === "merge" ? "Merge this device" : mode === "restore" ? "Restore this device" : "Connect this device";
}

async function loadJoinSummary(): Promise<void> {
  joinSummary = null;
  joinSummaryLoaded = false;
  renderJoin();
  try {
    joinSummary = await getSyncJoinSummary();
  } catch {
    // Unknown is not empty: keep both choices and show no counts.
    joinSummary = null;
  }
  joinSummaryLoaded = true;
  renderJoin();
  render();
  if (document.activeElement === elements.syncJoinTitle && joinIsStreamlined()) elements.syncRecoveryInput.focus();
}

function resetJoin(): void {
  elements.syncRecoveryInput.value = "";
  elements.syncJoinRestore.checked = false;
  elements.syncJoinMerge.checked = false;
  joinSummary = null;
  joinSummaryLoaded = false;
  renderJoin();
}

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

const platformNames: Record<string, string> = {
  linux: "Linux",
  windows: "Windows",
  macos: "macOS",
  android: "Android",
  ios: "iOS",
};

const recorded = (at: number | null | undefined): at is number => typeof at === "number" && at > 0;

function formatWhen(at: number | null | undefined): string {
  return recorded(at)
    ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Not yet recorded";
}

function formatLastSynced(at: number): string {
  const when = new Date(at);
  if (when.toDateString() !== new Date().toDateString()) return formatWhen(at);
  return `Today, ${when.toLocaleTimeString(undefined, { timeStyle: "short" })}`;
}

function deviceRow(device: DeviceSummary): HTMLLIElement {
  const row = document.createElement("li");
  const name = document.createElement("span");
  const meta = document.createElement("span");
  row.className = "sync-device";
  name.className = "sync-device__name";
  name.textContent = device.displayName;
  meta.className = "sync-device__meta";
  // textContent only: device names come from other devices.
  meta.textContent = [
    platformNames[device.platform.toLowerCase()] ?? device.platform,
    `First joined: ${formatWhen(device.joinedAtMs)}`,
    `Last synced: ${formatWhen(device.lastSyncedAtMs)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  row.append(name);
  if (device.thisDevice) {
    const badge = document.createElement("span");
    badge.className = "sync-device__badge";
    badge.textContent = "This device";
    row.append(badge);
    row.dataset.thisDevice = "";
  }
  row.append(meta);
  return row;
}

function renderDevices(next: SyncStatus): void {
  const devices = [...next.devices].sort((a, b) => Number(b.thisDevice) - Number(a.thisDevice));
  elements.syncDevices.replaceChildren(...devices.map(deviceRow));
  const self = next.devices.find((device) => device.thisDevice);
  if (self && !nameEdited) elements.syncNameInput.value = self.displayName;
}

// Only problems flag the titlebar: a quiet icon means Sync is fine or not in use.
function setStatus(next: SyncStatus): void {
  status = next;
  statusCheckFailed = false;
  renderDevices(next);
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

// A finished sync says nothing about changes other devices have not uploaded yet, so it never claims "up to date".
function statusHeadline(value: SyncStatus): string {
  if (!value.supported) return "Sync isn’t available on this device";
  if (!value.paired && !value.lastErrorCategory) return "Sync is off";
  if (value.state === "syncing") return "Syncing…";
  if (value.state === "offline" || connectionProblems.has(value.lastErrorCategory ?? ""))
    return "Sync couldn’t connect";
  if (value.state === "error" || value.lastErrorCategory) return "Sync needs attention";
  if (value.dirty) return "Changes waiting to sync";
  return value.lastSuccessAt ? "Sync completed" : "Sync is on";
}

function statusDetail(value: SyncStatus): string {
  if (value.lastErrorCategory) return errorCopy[value.lastErrorCategory] ?? "Sync could not complete. Try again.";
  return value.state === "offline" ? OFFLINE : "";
}

function render(): void {
  elements.syncJoinActions.hidden = elements.syncJoinForm.hidden;
  const paired = status?.paired ?? false;
  const supported = status?.supported ?? true;
  const showingKey = Boolean(elements.syncRecoveryKey.textContent);
  const gated = showingKey && Boolean(elements.syncRecovery.dataset.gated);
  const confirming = !elements.syncLeaveConfirm.hidden;
  // While the key shows, nothing on the status lines is news: the key and its checkbox are the whole task.
  const headline = busy
    ? busyMessage
    : checking
      ? "Checking Sync status…"
      : statusCheckFailed
        ? "Could not check Sync status"
        : !elements.syncError.hidden
          ? "Sync needs attention"
          : status
            ? statusHeadline(status)
            : "Checking Sync status…";
  const detail = !busy && status && elements.syncError.hidden ? statusDetail(status) : "";
  elements.syncStatus.hidden = showingKey;
  elements.syncStatus.textContent = headline;
  elements.syncStatus.dataset.state =
    busy || checking
      ? "syncing"
      : statusCheckFailed || !elements.syncError.hidden || status?.lastErrorCategory
        ? "error"
        : (status?.state ?? "unpaired");
  elements.syncStatusDetail.hidden = showingKey || !detail;
  elements.syncStatusDetail.textContent = detail;
  elements.syncLastSynced.hidden = showingKey || !paired || !supported;
  elements.syncLastSynced.textContent = `Last synced on this device: ${
    status?.lastSuccessAt ? formatLastSynced(status.lastSuccessAt) : "Never"
  }`;
  // The headline already says so when nothing else is wrong; this line covers the rest.
  elements.syncDirty.hidden =
    showingKey || !paired || !supported || !status?.dirty || busy || headline === "Changes waiting to sync";
  elements.syncScope.hidden = showingKey || confirming || !status;
  elements.syncUnpaired.hidden = paired || showingKey || !status;
  elements.syncRecovery.hidden = !showingKey;
  elements.syncKeyConfirm.hidden = !gated;
  elements.syncPaired.hidden = !paired || showingKey || confirming;
  elements.syncNow.disabled = busy || !supported || status?.state === "syncing";
  elements.syncShowKey.disabled = busy || !supported;
  elements.syncNameInput.disabled = busy || !supported;
  elements.syncEnable.disabled = busy || !supported || !status;
  elements.syncJoin.disabled = busy || !supported || !status || !joinSummaryLoaded || selectedJoinMode() === null;
  for (const option of [elements.syncJoinRestore, elements.syncJoinMerge]) option.disabled = busy;
  elements.syncLeave.disabled = busy || !supported || status?.state === "syncing";
  elements.syncLeaveConfirmButton.disabled = busy;
  elements.syncClose.disabled = busy || (gated && !elements.syncKeySaved.checked);
  elements.syncDone.textContent = gated ? "Done" : "Hide recovery key";
  // aria-disabled, not disabled: the note above already explains the gate, so Done keeps full strength and focus.
  elements.syncDone.setAttribute("aria-disabled", String(busy || (gated && !elements.syncKeySaved.checked)));
}

// The key lives in the DOM only while it is on screen.
function showKey(key: string, gated: boolean): void {
  elements.syncRecoveryKey.textContent = key;
  if (gated) elements.syncRecovery.dataset.gated = "true";
  else delete elements.syncRecovery.dataset.gated;
}

function hideKey(): void {
  elements.syncRecoveryKey.textContent = "";
  delete elements.syncRecovery.dataset.gated;
  elements.syncKeySaved.checked = false;
}

async function refresh(): Promise<void> {
  if (checking) return;
  checking = true;
  render();
  try {
    setStatus(await getSyncStatus());
    if (retryAction === refresh) clearError();
    if (elements.syncDialog.open) render();
  } catch (error) {
    statusCheckFailed = true;
    // An action's own error is worth more than a failed follow-up check.
    if (elements.syncDialog.open && elements.syncError.hidden)
      showError(
        `Current Sync status could not be verified. ${safeError(error)}`,
        notRetryable.has(category(error) ?? "") ? null : refresh,
      );
  } finally {
    checking = false;
    render();
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

// An action that returns a status changed saved data, so open views reload from it.
// Return `undefined` for read-only operations (e.g. showing the recovery key) that
// don't change sync state — the refresh at the end is still useful, but we skip
// setStatus() since no status fields changed.
async function operate(message: string, action: () => Promise<SyncStatus | undefined>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  busyMessage = message;
  elements.syncDialog.dataset.busy = "true";
  clearError();
  render();
  try {
    let result: SyncStatus | undefined;
    try {
      result = await action();
    } catch (error) {
      // Restore can replace local stores before credential or config saves fail.
      if (!state.loading) {
        try {
          await refreshPersistedView();
          syncControls();
        } catch {
          // Keep the action's original error and retry; a pending journal may still block reads.
        }
      }
      showError(safeError(error), notRetryable.has(category(error) ?? "") ? null : () => operate(message, action));
      await refresh();
      return false;
    }
    if (result) {
      setStatus(result);
      if (!state.loading && !(await refreshView())) return false;
    }
    await refresh();
    render();
    return true;
  } finally {
    busy = false;
    delete elements.syncDialog.dataset.busy;
    render();
  }
}

// Disabled controls drop focus while an action runs; hand it back once the dialog settles.
function focusWhenSettled(target: HTMLElement): void {
  if (elements.syncDialog.open && !target.hidden) target.focus();
}

async function onSyncStateChanged(): Promise<void> {
  // Our own actions reload the views themselves once they finish.
  const own = busy;
  await refresh();
  if (own || state.loading) return;
  try {
    await refreshPersistedView();
    syncControls();
  } catch {
    // The next open or sync reads the saved data again.
  }
}

async function renameDevice(): Promise<void> {
  if (busy) return;
  const name = elements.syncNameInput.value.trim();
  const problem = nameProblem(name);
  elements.syncNameError.hidden = !problem;
  elements.syncNameError.textContent = problem ?? "";
  elements.syncNameInput.setAttribute("aria-invalid", String(Boolean(problem)));
  if (problem) {
    elements.syncNameInput.focus();
    return;
  }
  busy = true;
  render();
  try {
    await setSyncDeviceName(name);
    nameEdited = false;
    elements.syncNameInput.value = name;
    toast.success("Device name saved");
  } catch (error) {
    elements.syncNameError.textContent = `${safeError(error)} Your name was not changed.`;
    elements.syncNameError.hidden = false;
    elements.syncNameInput.setAttribute("aria-invalid", "true");
  } finally {
    busy = false;
    render();
  }
  // The new name rides in the roster and counts as a change waiting to sync.
  await refresh();
  elements.syncNameInput.focus();
}

export function bindSyncDialogEvents(): void {
  window.addEventListener?.("resize", () => {
    if (
      elements.syncDialog.open &&
      !elements.syncJoinForm.hidden &&
      document.activeElement === elements.syncRecoveryInput
    )
      elements.syncRecoveryInput.scrollIntoView({ block: "nearest" });
  });
  if (
    (window as unknown as { __TAURI_INTERNALS__?: { transformCallback?: unknown } }).__TAURI_INTERNALS__
      ?.transformCallback
  ) {
    void listen("sync-state-changed", () => {
      void onSyncStateChanged();
    });
  }
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
    const gated = Boolean(elements.syncRecovery.dataset.gated);
    if (gated && elements.syncDone.getAttribute("aria-disabled") === "true") {
      if (!busy) elements.syncKeySaved.focus();
      return;
    }
    if (gated) {
      closeDialog(elements.syncDialog);
      return;
    }
    hideKey();
    render();
    focusWhenSettled(elements.syncShowKey);
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
    hideKey();
    resetJoin();
    elements.syncJoinForm.hidden = true;
    delete elements.syncDialog.dataset.joining;
    elements.syncLeaveConfirm.hidden = true;
    elements.syncNameError.hidden = true;
    elements.syncNameInput.removeAttribute("aria-invalid");
    nameEdited = false;
    if (status) renderDevices(status);
    clearError();
    render();
    onDialogClosed();
    (opener ?? elements.syncButton).focus?.();
  });
  elements.syncShowJoin.addEventListener("click", () => {
    elements.syncJoinForm.hidden = false;
    elements.syncDialog.dataset.joining = "true";
    elements.syncJoinTitle.focus();
    void loadJoinSummary();
    render();
  });
  for (const option of [elements.syncJoinRestore, elements.syncJoinMerge])
    option.addEventListener("change", () => {
      renderJoin();
      render();
    });
  elements.syncJoinCancel.addEventListener("click", () => {
    elements.syncJoinForm.hidden = true;
    delete elements.syncDialog.dataset.joining;
    resetJoin();
    clearError();
    render();
    elements.syncShowJoin.focus();
  });
  elements.syncEnable.addEventListener("click", async () => {
    const created = await operate("Starting Sync…", async () => {
      const result = await createSync();
      showKey(result.recoveryKey, true);
      // The Sync exists and the key is on screen; only this device's own connection failed.
      if (result.localPairingError)
        showError(
          `Your Sync was created, but this device couldn’t finish connecting. ${safeError(result.localPairingError)} Save your recovery key, then connect this device with it.`,
        );
      return result.status;
    });
    focusWhenSettled(created ? elements.syncKeySaved : elements.syncEnable);
  });
  elements.syncCopyKey.addEventListener("click", async () => {
    try {
      await writeText(elements.syncRecoveryKey.textContent);
      toast.success("Recovery key copied");
    } catch {
      document.getSelection?.()?.selectAllChildren(elements.syncRecoveryKey);
      showError("Couldn’t copy the key. It’s selected above, so copy it by hand.");
    }
  });
  elements.syncJoinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mode = selectedJoinMode();
    if (busy || !joinSummaryLoaded) return;
    if (!mode) {
      showError("Choose how this device should join your Sync.");
      elements.syncJoinRestore.focus();
      return;
    }
    // Fixed at submit, so Try again repeats exactly this choice.
    const joined = await operate(mode === "restore" ? "Restoring this device…" : "Merging this device…", async () => {
      const result = await joinSync(elements.syncRecoveryInput.value.trim(), mode);
      resetJoin();
      elements.syncJoinForm.hidden = true;
      delete elements.syncDialog.dataset.joining;
      return result;
    });
    focusWhenSettled(joined ? elements.syncNow : elements.syncRecoveryInput);
  });
  elements.syncNow.addEventListener("click", async () => {
    await operate("Syncing…", syncNow);
    focusWhenSettled(elements.syncNow);
  });
  elements.syncNameInput.addEventListener("input", () => {
    nameEdited = true;
    elements.syncNameError.hidden = true;
    elements.syncNameInput.removeAttribute("aria-invalid");
  });
  elements.syncNameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void renameDevice();
  });
  elements.syncShowKey.addEventListener("click", async () => {
    const shown = await operate("Reading your recovery key…", async () => {
      showKey(await getSyncRecoveryKey(), false);
      return undefined;
    });
    focusWhenSettled(shown ? elements.syncCopyKey : elements.syncShowKey);
  });
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
  elements.syncLeaveConfirmButton.addEventListener("click", async () => {
    const left = await operate("Disconnecting this device…", async () => {
      const result = await leaveSync();
      elements.syncLeaveConfirm.hidden = true;
      return result;
    });
    focusWhenSettled(left ? elements.syncEnable : elements.syncLeaveConfirmButton);
  });
}

export async function runStartupSync(): Promise<void> {
  try {
    setStatus(await startupSync());
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
