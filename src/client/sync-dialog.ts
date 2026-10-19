import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import {
  approveSyncUpgrade,
  cancelSyncAdminRecovery,
  createSync,
  createSyncInvitation,
  type DeviceSummary,
  dissolveSync,
  getSyncInvitation,
  getSyncJoinSummary,
  getSyncPairingRequest,
  getSyncRecoveryKey,
  getSyncStatus,
  type JoinMode,
  joinSync,
  type LocalSyncSummary,
  leaveSync,
  moveToManagedSync,
  recoverSyncAdmin,
  removeSyncDevice,
  type SyncStatus,
  setSyncDeviceName,
  startupSync,
  syncNow,
} from "./sync-api.js";
import { toast } from "./toast.js";
import { refreshPersistedView } from "./viewer-state.js";

const OFFLINE = "You’re offline. Try again when you’re back online.";
const OLDER_DATA = "The Sync server returned older data than this device has already seen, so it was not applied.";
const NOT_APPLIED = "Nothing was changed on this device or in your Sync.";

const errorCopy: Record<string, string> = {
  left_locally:
    "Disconnected on this device while offline. Server membership was not ended. The administrator can remove the old membership; a new invitation is needed to rejoin.",
  revoked: "This device was removed. Local data remains; ask the administrator for a new invitation to join again.",
  closed: "This Sync group was dissolved. Your local data and files remain.",
  credential_replaced: "Administration was recovered on another device. This installation can no longer sync.",
  left: "This device disconnected. Local data remains. A new invitation is needed to rejoin managed Sync.",
  master_required: "Only the administrator can manage this group.",
  master_cannot_leave:
    "The administrator cannot disconnect. Recover administration on another device, or dissolve the group.",
  invitation_expired: "This invitation expired or the group’s key changed. Ask the administrator for a new invitation.",
  invitation_consumed: "This invitation has already been used. Ask the administrator for a new one.",
  operation_mismatch: "The prepared operation does not match. No new change was committed.",
  no_invitation: "No invitation is saved on this device. Approve a device’s pairing request to create one.",
  pending_operation:
    "A prepared operation needs attention. Resume recovery to save the new administration code, or retry the original action.",
  managed_required: "This action requires managed Sync.",
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
  upgrade_required: "Collections need a newer Sync format. Review the upgrade before continuing.",
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
  "no_invitation",
  "left_locally",
  "revoked",
  "closed",
  "credential_replaced",
  "left",
  "master_required",
  "master_cannot_leave",
  "invitation_expired",
  "invitation_consumed",
  "operation_mismatch",
  "invalid_endpoint",
  "invalid_recovery_key",
  "already_paired",
  "unpaired",
  "unsupported_platform",
  "corrupt_local_state",
  "body_too_large",
  "unsupported_version",
  "schema_downgrade",
  "upgrade_required",
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

// Native parsing and credential validation remain authoritative; catch common paste mistakes here.
function pairingProblem(): string | null {
  const request = elements.syncPairingInput.value.trim();
  if (!request) return "Paste the pairing request generated on the new device.";
  if (!request.startsWith("rf-pair-v2-") || request.length <= 11 || request.length > 4096)
    return "Use the complete pairing request beginning with rf-pair-v2-, not an invitation or administration code.";
  return null;
}

function setPairingError(message: string | null): void {
  elements.syncPairingError.textContent = message ?? "";
  elements.syncPairingError.hidden = !message;
  if (message) elements.syncPairingInput.setAttribute("aria-invalid", "true");
  else elements.syncPairingInput.removeAttribute("aria-invalid");
}

// What this device holds before joining; null until read, or when it could not be read.
let joinSummary: LocalSyncSummary | null = null;
let joinSummaryLoaded = false;
let status: SyncStatus | null = null;
let checking = false;
let statusCheckFailed = false;
let busy = false;
let busyMessage = "";
let statusAnimation: Animation | undefined;
let opener: HTMLElement | null = null;
let nameEdited = false;
let recoveryPrepared = false;
let removeTarget: { memberId: string; name: string } | null = null;
const isMaster = (): boolean =>
  Boolean(status?.controlVerifiedAt && status.masterMemberId && status.masterMemberId === status.thisMemberId);
// What Try again repeats: the failed action, or the status check itself.
let upgradeAction:
  | { message: string; action: () => Promise<SyncStatus | undefined>; recoveryKey?: string | undefined }
  | undefined;
let retryAction: (() => Promise<unknown>) | null = null;

const count = new Intl.NumberFormat();
const plural = (n: number, one: string, many: string): string => `${count.format(n)} ${n === 1 ? one : many}`;

function totalDeletions(summary: LocalSyncSummary): number {
  return (
    summary.historyRemovals +
    summary.favoriteRemovals +
    summary.activityRemovals +
    (summary.collectionRemovals ?? 0) +
    (summary.membershipRemovals ?? 0)
  );
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
        summary.favorites > 0 ? plural(summary.favorites, "saved frame", "saved frames") : "",
        summary.collections > 0 ? plural(summary.collections, "collection", "collections") : "",
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
  elements.syncJoin.textContent = busy
    ? busyMessage
    : mode === "merge"
      ? "Merge this device"
      : mode === "restore"
        ? "Restore this device"
        : "Connect this device";
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
  elements.syncRetry.hidden = true;
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
  if (device.isMaster) {
    const badge = document.createElement("span");
    badge.className = "sync-device__role";
    badge.textContent = "Administrator";
    row.append(badge);
  }
  if (device.status && device.status !== "active") meta.textContent += ` · ${device.status}`;
  if (isMaster() && !device.thisDevice && device.status === "active" && device.memberId) {
    const remove = document.createElement("button");
    remove.className = "sync-dialog__button sync-dialog__button--danger";
    remove.type = "button";
    remove.textContent = "Remove device";
    remove.setAttribute("aria-label", `Remove ${device.displayName}, ${device.memberId.slice(0, 8)}`);
    remove.disabled = busy;
    remove.addEventListener("click", () => {
      removeTarget = { memberId: device.memberId as string, name: device.displayName };
      elements.syncRemoveTarget.textContent = `${removeTarget.name} · member ${removeTarget.memberId.slice(0, 8)}`;
      elements.syncRemoveConfirm.hidden = false;
      render();
      elements.syncRemoveCancel.focus();
    });
    row.append(remove);
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
  if (next.snapshotSchemaVersion >= 3 && next.lastErrorCategory !== "upgrade_required") upgradeAction = undefined;
  statusCheckFailed = false;
  renderDevices(next);
  renderAttention();
}

function renderAttention(): void {
  const attention =
    retryAction === refreshView ||
    (status?.paired && (status.state === "error" || status.state === "offline" || status.lastErrorCategory));
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
  if (value.state === "upgrade_required" || value.lastErrorCategory === "upgrade_required")
    return "Sync needs an upgrade";
  if (value.state === "updating_key") return "Updating the key automatically…";
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

function computeHeadline(
  busy: boolean,
  checking: boolean,
  statusCheckFailed: boolean,
  status: SyncStatus | null,
): string {
  if (status?.state === "updating_key") return "Updating the key automatically…";
  if (busy) return busyMessage;
  if (checking) return "Checking Sync status…";
  if (statusCheckFailed) return "Could not check Sync status";
  if (!elements.syncError.hidden) return "Sync needs attention";
  if (status) return statusHeadline(status);
  return "Checking Sync status…";
}

function computeState(busy: boolean, checking: boolean, statusCheckFailed: boolean, status: SyncStatus | null): string {
  if (status?.state === "updating_key") return "updating_key";
  if (busy || checking) return "syncing";
  if (status?.lastErrorCategory === "upgrade_required") return "upgrade_required";
  if (statusCheckFailed || !elements.syncError.hidden || status?.lastErrorCategory) return "error";
  return status?.state ?? "unpaired";
}

function render(): void {
  renderAttention();
  renderJoin();
  const upgrading = Boolean(upgradeAction || (status?.paired && status.lastErrorCategory === "upgrade_required"));
  elements.syncUpgrade.hidden = !upgrading;
  elements.syncUpgradeConfirm.disabled = elements.syncUpgradeLater.disabled = busy;
  const paired = status?.paired ?? false;
  const supported = status?.supported ?? true;
  const showingKey = Boolean(elements.syncRecoveryKey.textContent);
  const gated = showingKey && Boolean(elements.syncRecovery.dataset.gated);
  elements.syncJoinActions.hidden = elements.syncJoinForm.hidden || upgrading || showingKey;
  const confirming =
    !elements.syncLeaveConfirm.hidden || !elements.syncRemoveConfirm.hidden || !elements.syncDissolveConfirm.hidden;
  // While the key shows, nothing on the status lines is news: the key and its checkbox are the whole task.
  const headline = computeHeadline(busy, checking, statusCheckFailed, status);
  const detail = !busy && status && elements.syncError.hidden ? statusDetail(status) : "";
  elements.syncStatus.hidden = showingKey;
  const nextState = computeState(busy, checking, statusCheckFailed, status);
  if (elements.syncStatus.textContent !== headline || elements.syncStatus.dataset.state !== nextState) {
    statusAnimation?.cancel();
    elements.syncStatus.textContent = headline;
    elements.syncStatus.dataset.state = nextState;
    if (elements.syncDialog.open && !showingKey)
      statusAnimation = elements.syncStatus.animate([{ opacity: 0.65 }, { opacity: 1 }], {
        duration: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 160,
        easing: window.getComputedStyle?.(elements.syncDialog).getPropertyValue("--ease-out").trim() || "ease-out",
      });
  }
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
  elements.syncUnpaired.hidden = paired || showingKey || !status || upgrading;
  elements.syncRecovery.hidden = !showingKey;
  elements.syncKeyConfirm.hidden = !gated;
  elements.syncPaired.hidden = !paired || showingKey || confirming || upgrading;
  elements.syncNow.hidden = !paired || showingKey || confirming || upgrading || !supported;
  elements.syncNow.textContent = busy && busyMessage === "Syncing…" ? "Syncing…" : "Sync now";
  elements.syncCreateInvitation.textContent =
    busy && busyMessage === "Approving the device…" ? "Creating invitation…" : "Create invitation";
  elements.syncDissolve.hidden = !isMaster();
  elements.syncMemberNote.hidden = !status?.thisMemberId || isMaster();
  elements.syncAdminKeyNote.hidden = Boolean(status?.thisMemberId) && !isMaster();
  elements.syncAdminKeyNote.textContent = status?.thisMemberId
    ? "Keep your administration code safe. It lets you recover administration on another device."
    : "Keep your legacy recovery key safe. Anyone with it can connect to this Sync.";
  elements.syncNow.disabled = busy || !supported || status?.state === "syncing" || status?.state === "updating_key";
  elements.syncShowKey.disabled = busy || !supported;
  elements.syncShowKey.hidden = Boolean(status?.thisMemberId) && !isMaster();
  elements.syncShowKey.textContent = status?.thisMemberId ? "Show administration code" : "Show recovery key";
  elements.syncDevicesNote.textContent = status?.thisMemberId
    ? "Membership verified by the server. Last synced does not mean online."
    : "Devices known from past syncs. This list doesn’t show which ones are online or still connected.";
  elements.syncLegacyMove.hidden = !paired || Boolean(status?.thisMemberId);
  elements.syncAdminTools.hidden = !isMaster();
  elements.syncMasterNote.hidden = !isMaster();
  elements.syncLegacySource.hidden = !status?.legacySourceId;
  elements.syncLegacySource.textContent = status?.legacySourceId
    ? `New group created from legacy ${status.legacySourceId}. The legacy group may still be accessible; creating this group did not close it.`
    : "";
  elements.syncRecoveryCancel.hidden = !recoveryPrepared;
  elements.syncNameInput.disabled = busy || !supported;
  elements.syncEnable.disabled = busy || !supported || !status;
  elements.syncJoin.disabled = busy || !supported || !status || !joinSummaryLoaded || selectedJoinMode() === null;
  for (const option of [elements.syncJoinRestore, elements.syncJoinMerge]) option.disabled = busy;
  elements.syncLeave.disabled =
    busy || !supported || status?.state === "syncing" || status?.state === "updating_key" || isMaster();
  elements.syncLeaveConfirmButton.disabled = busy;
  elements.syncClose.disabled = busy || recoveryPrepared || (gated && !elements.syncKeySaved.checked);
  elements.syncDone.textContent = recoveryPrepared ? "Save code and finish recovery" : gated ? "Done" : "Hide code";
  for (const control of [
    elements.syncPairingRequest,
    elements.syncAdminCode,
    elements.syncAdminRecover,
    elements.syncMove,
    elements.syncPairingInput,
    elements.syncCreateInvitation,
    elements.syncShowInvitation,
    elements.syncDissolve,
    elements.syncRemoveCancel,
    elements.syncRemoveDevice,
    elements.syncDissolveCancel,
    elements.syncDissolveWord,
    elements.syncRecoveryCancel,
  ])
    control.disabled = busy || !supported;
  elements.syncDissolveSubmit.disabled = busy || elements.syncDissolveWord.value !== "DISSOLVE";
  // aria-disabled, not disabled: the note above already explains the gate, so Done keeps full strength and focus.
  elements.syncDone.setAttribute("aria-disabled", String(busy || (gated && !elements.syncKeySaved.checked)));
}

// The key lives in the DOM only while it is on screen.
function showKey(key: string, gated: boolean): void {
  const admin = key.startsWith("rf-admin-v2-");
  const invite = key.startsWith("rf-invite-v2-");
  const pairing = key.startsWith("rf-pair-v2-");
  const label = admin ? "Administration code" : invite ? "Invitation" : pairing ? "Pairing request" : "Recovery key";
  elements.syncRecoveryTitle.textContent = invite ? "Invitation ready" : `Your ${label.toLowerCase()}`;
  elements.syncKeyAbout.textContent = admin
    ? recoveryPrepared
      ? "Save this new administration code before finishing recovery. It becomes active only after recovery succeeds; the previous code then stops working. If recovery is rejected, this prepared code is not active."
      : "Keep this code somewhere safe. It can recover administration on a new device and replace this device’s access. It is separate from invitations and the data key; do not send it to participants."
    : invite
      ? "Send this one-use invitation to the device whose request you approved. It expires in 24 hours or when the group’s key changes. It grants no administration access."
      : pairing
        ? "Send this request to the administrator. It binds approval to this installation’s credentials. Paste the invitation the administrator gives you in Connect this device."
        : "Keep this legacy key somewhere safe. Anyone with it can connect to the old Sync.";
  elements.syncCopyKey.textContent = `Copy ${label.toLowerCase()}`;
  elements.syncRecoveryKey.setAttribute("aria-label", label);
  elements.syncKeySavedLabel.textContent = `I’ve saved this ${label.toLowerCase()} somewhere safe`;
  elements.syncRecoveryKey.textContent = key;
  if (gated) elements.syncRecovery.dataset.gated = "true";
  else delete elements.syncRecovery.dataset.gated;
}

function hideKey(): void {
  elements.syncRecoveryKey.textContent = "";
  delete elements.syncRecovery.dataset.gated;
  delete elements.syncRecovery.dataset.recovering;
  recoveryPrepared = false;
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
    if (retryAction === refreshView) clearError();
    render();
    return true;
  } catch (error) {
    showError(`Sync finished, but saved data could not be reloaded. ${safeError(error)}`, refreshView);
    return false;
  }
}

// An action that returns a status changed saved data, so open views reload from it.
// Return `undefined` for read-only operations (e.g. showing the recovery key) that
// don't change sync state — the refresh at the end is still useful, but we skip
// setStatus() since no status fields changed.
async function operate(
  message: string,
  action: () => Promise<SyncStatus | undefined>,
  recoveryKey?: string,
): Promise<boolean> {
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
      try {
        await refreshPersistedView();
      } catch {
        // Keep the action's original error and retry; a pending journal may still block reads.
      }
      if (category(error) === "upgrade_required") {
        upgradeAction = { message, action, recoveryKey };
        clearError();
      } else
        showError(
          safeError(error),
          notRetryable.has(category(error) ?? "") ? null : () => operate(message, action, recoveryKey),
        );
      await refresh();
      return false;
    }
    if (result) {
      upgradeAction = undefined;
      setStatus(result);
      if (!(await refreshView())) return false;
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
  await refresh();
  await refreshView();
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
  busyMessage = "Saving device name…";
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
  for (const toggle of elements.syncDialog.querySelectorAll<HTMLButtonElement>(".sync-disclosure__toggle")) {
    const body = toggle.nextElementSibling as HTMLElement;
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(expanded));
      body.inert = !expanded;
      if (!expanded && body.contains(document.activeElement)) toggle.focus();
    });
  }
  elements.syncDialog.addEventListener("focusin", (event) => {
    (event.target as HTMLElement).scrollIntoView?.({ block: "nearest" });
  });
  elements.syncUpgradeLater.addEventListener("click", () => closeDialog(elements.syncDialog));
  elements.syncUpgradeConfirm.addEventListener("click", async () => {
    const pending = upgradeAction ?? { message: "Syncing…", action: syncNow, recoveryKey: undefined };
    await operate(
      pending.message,
      async () => {
        await approveSyncUpgrade(pending.recoveryKey);
        upgradeAction = undefined;
        return pending.action();
      },
      pending.recoveryKey,
    );
    focusWhenSettled(status?.lastErrorCategory === "upgrade_required" ? elements.syncUpgradeLater : elements.syncNow);
  });
  window.addEventListener("resize", () => {
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
    if (retryAction !== refreshView) clearError();
    render();
    openDialog(elements.syncDialog);
    elements.syncClose.focus();
    void refresh();
  });
  elements.syncClose.addEventListener("click", () => closeDialog(elements.syncDialog));
  elements.syncDone.addEventListener("click", async () => {
    const gated = Boolean(elements.syncRecovery.dataset.gated);
    if (gated && elements.syncDone.getAttribute("aria-disabled") === "true") {
      if (!busy) elements.syncKeySaved.focus();
      return;
    }
    if (recoveryPrepared) {
      await operate("Confirming the prepared recovery…", async () => {
        const result = await recoverSyncAdmin("", true);
        recoveryPrepared = false;
        delete elements.syncRecovery.dataset.recovering;
        hideKey();
        return result.status;
      });
      focusWhenSettled(elements.syncNow);
      return;
    }
    if (gated) {
      closeDialog(elements.syncDialog);
      return;
    }
    const key = elements.syncRecoveryKey.textContent;
    const returnTo = key.startsWith("rf-pair-v2-")
      ? elements.syncPairingRequest
      : key.startsWith("rf-invite-v2-")
        ? elements.syncCreateInvitation
        : status?.paired
          ? elements.syncShowKey
          : elements.syncRecoveryInput;
    hideKey();
    render();
    focusWhenSettled(returnTo);
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
    if (!status?.paired) upgradeAction = undefined;
    elements.syncJoinForm.hidden = true;
    delete elements.syncDialog.dataset.joining;
    elements.syncLeaveConfirm.hidden = true;
    elements.syncNameError.hidden = true;
    elements.syncNameInput.removeAttribute("aria-invalid");
    nameEdited = false;
    elements.syncAdminCode.value = "";
    elements.syncPairingInput.value = "";
    setPairingError(null);
    elements.syncRemoveConfirm.hidden = true;
    elements.syncDissolveConfirm.hidden = true;
    elements.syncDissolveWord.value = "";
    removeTarget = null;
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
      showKey(result.adminRecoveryCode, true);
      return result.status;
    });
    focusWhenSettled(created ? elements.syncKeySaved : elements.syncEnable);
  });
  elements.syncCopyKey.addEventListener("click", async () => {
    try {
      await writeText(elements.syncRecoveryKey.textContent);
      toast.success("Copied");
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
    const recoveryKey = elements.syncRecoveryInput.value.trim();
    const joined = await operate(
      mode === "restore" ? "Restoring this device…" : "Merging this device…",
      async () => {
        const result = await joinSync(recoveryKey, mode);
        resetJoin();
        elements.syncJoinForm.hidden = true;
        delete elements.syncDialog.dataset.joining;
        return result;
      },
      recoveryKey,
    );
    focusWhenSettled(
      joined ? elements.syncNow : upgradeAction ? elements.syncUpgradeLater : elements.syncRecoveryInput,
    );
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
  elements.syncPairingRequest.addEventListener("click", async () => {
    const shown = await operate("Preparing this device’s pairing request…", async () => {
      showKey(await getSyncPairingRequest(), false);
      return undefined;
    });
    focusWhenSettled(shown ? elements.syncCopyKey : elements.syncPairingRequest);
  });
  elements.syncPairingInput.addEventListener("input", () => setPairingError(null));
  elements.syncPairingInput.addEventListener("blur", () => {
    if (elements.syncPairingInput.value.trim()) setPairingError(pairingProblem());
  });
  elements.syncInvitationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const problem = pairingProblem();
    setPairingError(problem);
    if (problem) {
      elements.syncPairingInput.focus();
      return;
    }
    const request = elements.syncPairingInput.value.trim();
    const created = await operate("Approving the device…", async () => {
      showKey(await createSyncInvitation(request), false);
      elements.syncPairingInput.value = "";
      setPairingError(null);
      return undefined;
    });
    if (!created && !elements.syncError.hidden) {
      const message = elements.syncErrorMessage.textContent.replace("recovery key", "pairing request");
      elements.syncErrorMessage.textContent = message;
      setPairingError(message);
    }
    focusWhenSettled(created ? elements.syncCopyKey : elements.syncPairingInput);
  });
  elements.syncShowInvitation.addEventListener("click", async () => {
    const shown = await operate("Reading the latest invitation…", async () => {
      showKey(await getSyncInvitation(), false);
      return undefined;
    });
    focusWhenSettled(shown ? elements.syncCopyKey : elements.syncShowInvitation);
  });
  elements.syncMove.addEventListener("click", async () => {
    const moved = await operate("Creating a new managed group…", async () => {
      const result = await moveToManagedSync();
      showKey(result.adminRecoveryCode, true);
      return result.status;
    });
    focusWhenSettled(moved ? elements.syncKeySaved : upgradeAction ? elements.syncUpgradeLater : elements.syncMove);
  });
  elements.syncAdminRecoverForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = elements.syncAdminCode.value.trim();
    const prepared = await operate(
      "Preparing administration recovery…",
      async () => {
        const result = await recoverSyncAdmin(code);
        elements.syncAdminCode.value = "";
        recoveryPrepared = result.prepared;
        if (recoveryPrepared) elements.syncRecovery.dataset.recovering = "true";
        showKey(result.adminRecoveryCode, true);
        return result.status;
      },
      code,
    );
    focusWhenSettled(
      prepared ? elements.syncKeySaved : upgradeAction ? elements.syncUpgradeLater : elements.syncAdminCode,
    );
  });
  elements.syncRecoveryCancel.addEventListener("click", async () => {
    await operate("Cancelling prepared recovery…", async () => {
      await cancelSyncAdminRecovery();
      hideKey();
      return undefined;
    });
    focusWhenSettled(elements.syncAdminCode);
  });
  elements.syncRemoveCancel.addEventListener("click", () => {
    elements.syncRemoveConfirm.hidden = true;
    removeTarget = null;
    render();
    elements.syncNow.focus();
  });
  elements.syncRemoveDevice.addEventListener("click", async () => {
    if (!removeTarget) return;
    const memberId = removeTarget.memberId;
    await operate("Removing device and updating the key…", async () => {
      const result = await removeSyncDevice(memberId);
      elements.syncRemoveConfirm.hidden = true;
      removeTarget = null;
      return result;
    });
    focusWhenSettled(elements.syncNow);
  });
  elements.syncDissolve.addEventListener("click", () => {
    elements.syncDissolveConfirm.hidden = false;
    elements.syncDissolveWord.value = "";
    render();
    elements.syncDissolveCancel.focus();
  });
  elements.syncDissolveWord.addEventListener("input", render);
  elements.syncDissolveCancel.addEventListener("click", () => {
    elements.syncDissolveConfirm.hidden = true;
    elements.syncDissolveWord.value = "";
    render();
    elements.syncDissolve.focus();
  });
  elements.syncDissolveConfirm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (elements.syncDissolveWord.value !== "DISSOLVE") {
      elements.syncDissolveWord.focus();
      return;
    }
    await operate("Dissolving the group…", async () => {
      const result = await dissolveSync();
      elements.syncDissolveConfirm.hidden = true;
      elements.syncDissolveWord.value = "";
      return result;
    });
    focusWhenSettled(elements.syncEnable);
  });
  elements.syncLeave.addEventListener("click", () => {
    if (isMaster()) {
      showError(errorCopy.master_cannot_leave ?? "The administrator cannot disconnect.");
      return;
    }
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
  } catch {
    // GET may have persisted remote changes before a failed PUT; project them without claiming delivery.
    await refresh();
    await refreshView();
    return;
  }
  await refreshView();
  if (elements.syncDialog.open) await refresh();
}
