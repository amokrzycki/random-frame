import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import {
  createSync,
  type DeviceSummary,
  dissolveSync,
  getSyncCode,
  getSyncJoinSummary,
  getSyncStatus,
  type JoinMode,
  joinSync,
  type LocalSyncSummary,
  leaveSync,
  newSyncCode,
  removeSyncDevice,
  type SyncStatus,
  startupSync,
  syncNow,
} from "./sync-api.js";
import { toast } from "./toast.js";
import { refreshPersistedView } from "./viewer-state.js";

const OFFLINE = "You’re offline. Try again when you’re back online.";
const OLDER_DATA = "The Sync server returned older data than this device has already seen, so it was not applied.";
const NOT_APPLIED = "Nothing was changed on this device or in your Sync.";
const KEEPS_DATA = "Data on this device stays here.";
const END_WORD = "END";

const errorCopy: Record<string, string> = {
  left_locally: `This device left while offline, so the Sync wasn’t told. ${KEEPS_DATA} The administrator can remove it from the device list.`,
  revoked: `The administrator removed this device from the Sync. ${KEEPS_DATA} Ask for the current code to join again.`,
  closed: `This Sync has ended for all devices. ${KEEPS_DATA}`,
  credential_replaced: `This device’s access to the Sync was replaced, so it can no longer sync. ${KEEPS_DATA}`,
  left: `This device left the Sync. ${KEEPS_DATA} Ask the administrator for the current code to join again.`,
  master_required: "Only the administrator can do that.",
  master_cannot_leave: "The administrator can’t leave. End Sync for all devices instead.",
  no_code: "This Sync has no code yet. The administrator can create one with New code.",
  code_length: "The code has 24 words; this one has a different number.",
  code_word: "A word in the code isn’t a valid code word.",
  code_typo: "The code has a typo. Check the words and their order.",
  code_rejected:
    "This code wasn’t accepted. It may have been replaced, or the Sync may have ended. Ask the administrator for the current code.",
  operation_mismatch: "That change didn’t match what was in progress. Nothing was changed.",
  pending_operation: "A change to this Sync is still finishing. Try again in a moment.",
  invalid_endpoint: "Sync isn’t available because no server is set up.",
  already_paired: "This device is already connected to a Sync.",
  unpaired: "This device isn’t connected to a Sync.",
  migration_pending: "Saved data is still loading. Try again when loading finishes.",
  already_syncing: "Sync is already in progress.",
  corrupt_local_state: "Sync settings on this device are damaged.",
  secure_storage: "This device’s secure storage isn’t available, so Sync can’t continue.",
  persistence: "Sync data could not be saved on this device.",
  unsupported_platform: "Sync isn’t available on this device.",
  invalid_remote_data: `Synced data could not be verified, so it was not applied. ${NOT_APPLIED}`,
  offline: OFFLINE,
  timeout: "Sync took too long to respond. Try again.",
  tls: "Sync could not make a secure connection. Try again.",
  malformed_response: "Sync got a response it couldn’t read. Try again.",
  not_found: "No Sync was found. It may have ended. Ask the administrator.",
  conflict:
    "Other devices kept changing your Sync, so this sync couldn’t finish. Your data on this device is safe. Try again.",
  rate_limited: "Give it a moment. Sync is busy, so try again shortly.",
  server_error: "Sync is unavailable right now. Try again later.",
  body_too_large: "Your synced data is too large to upload. Nothing was removed.",
  rollback_detected: `${OLDER_DATA} ${NOT_APPLIED}`,
};

const connectionProblems = new Set(["offline", "timeout", "tls", "server_error", "rate_limited"]);
const codeProblems = new Set(["code_length", "code_word", "code_typo", "code_rejected", "no_code"]);
const endedStates = new Set(["revoked", "closed", "left", "left_locally", "credential_replaced"]);

function category(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("category" in error)) return null;
  return typeof error.category === "string" ? error.category : null;
}

const notRetryable = new Set([
  ...codeProblems,
  ...endedStates,
  "master_required",
  "master_cannot_leave",
  "operation_mismatch",
  "invalid_endpoint",
  "already_paired",
  "unpaired",
  "unsupported_platform",
  "corrupt_local_state",
  "body_too_large",
  "invalid_remote_data",
  "rollback_detected",
  "not_found",
]);

function safeError(error: unknown): string {
  const kind = category(error) ?? "";
  const details = typeof error === "object" && error !== null && "details" in error ? error.details : null;
  if (kind === "code_word" && typeof details === "number" && Number.isInteger(details) && details >= 0)
    return `Word ${details + 1} is not a valid code word.`;
  return errorCopy[kind] ?? "Sync could not complete. Try again.";
}

function setCodeError(message: string | null): void {
  elements.syncCodeError.textContent = message ?? "";
  elements.syncCodeError.hidden = !message;
  if (message) elements.syncCodeInput.setAttribute("aria-invalid", "true");
  else elements.syncCodeInput.removeAttribute("aria-invalid");
}

let joinSummary: LocalSyncSummary | null = null;
let joinSummaryLoaded = false;
let status: SyncStatus | null = null;
let checking = false;
let statusCheckFailed = false;
let busy = false;
let busyMessage = "";
let statusAnimation: Animation | undefined;
let opener: HTMLElement | null = null;
let removeTarget: { memberId: string; name: string } | null = null;
const isMaster = (): boolean => Boolean(status?.masterMemberId && status.masterMemberId === status.thisMemberId);
const hasEnded = (value: SyncStatus | null): boolean =>
  Boolean(value && !value.paired && value.membershipState && endedStates.has(value.membershipState));
let retryAction: (() => Promise<unknown>) | null = null;

const count = new Intl.NumberFormat();
const plural = (n: number, one: string, many: string): string => `${count.format(n)} ${n === 1 ? one : many}`;

function totalDeletions(summary: LocalSyncSummary): number {
  return (
    summary.historyRemovals +
    summary.favoriteRemovals +
    summary.activityRemovals +
    summary.collectionRemovals +
    summary.membershipRemovals
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
        : "Join this Sync";
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
}

function resetJoin(): void {
  elements.syncCodeInput.value = "";
  setCodeError(null);
  elements.syncJoinRestore.checked = false;
  elements.syncJoinMerge.checked = false;
  joinSummary = null;
  joinSummaryLoaded = false;
  renderJoin();
}

function showError(message: string, retry: (() => Promise<unknown>) | null = null, label = "Try again"): void {
  retryAction = retry;
  elements.syncRetry.textContent = label;
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
  const memberId = device.memberId;
  if (isMaster() && !device.thisDevice && device.status === "active" && memberId) {
    const remove = document.createElement("button");
    remove.className = "sync-dialog__button sync-dialog__button--danger";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${device.displayName}, ${memberId.slice(0, 8)}`);
    remove.disabled = busy;
    remove.addEventListener("click", () => {
      removeTarget = { memberId, name: device.displayName };
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
}

// The code lives in the DOM only while it is on screen.
function showCode(code: string): void {
  elements.syncCode.textContent = code;
}

function hideCode(): void {
  elements.syncCode.textContent = "";
}

// Only problems flag the titlebar: a quiet icon means Sync is fine or not in use.
function setStatus(next: SyncStatus): void {
  status = next;
  statusCheckFailed = false;
  if (!isMaster()) hideCode();
  renderDevices(next);
  renderAttention();
}

function renderAttention(): void {
  const attention =
    retryAction === refreshView ||
    ((status?.paired || hasEnded(status)) &&
      (status?.state === "error" || status?.state === "offline" || status?.lastErrorCategory));
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
  if (hasEnded(value)) return "This device is no longer syncing";
  if (!value.paired && !value.lastErrorCategory) return "Sync is off";
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
  if (statusCheckFailed || !elements.syncError.hidden || status?.lastErrorCategory) return "error";
  return status?.state ?? "unpaired";
}

function render(): void {
  renderAttention();
  renderJoin();
  const paired = status?.paired ?? false;
  const supported = status?.supported ?? true;
  const ended = hasEnded(status);
  const master = isMaster();
  const showingCode = Boolean(elements.syncCode.textContent);
  const codeMissing = master && !showingCode && !status?.codeReady;
  elements.syncJoinActions.hidden = elements.syncJoinForm.hidden;
  const confirming =
    !elements.syncLeaveConfirm.hidden ||
    !elements.syncRemoveConfirm.hidden ||
    !elements.syncDissolveConfirm.hidden ||
    !elements.syncNewCodeConfirm.hidden;
  const headline = computeHeadline(busy, checking, statusCheckFailed, status);
  const detail = !busy && status && elements.syncError.hidden ? statusDetail(status) : "";
  const nextState = computeState(busy, checking, statusCheckFailed, status);
  if (elements.syncStatus.textContent !== headline || elements.syncStatus.dataset.state !== nextState) {
    statusAnimation?.cancel();
    elements.syncStatus.textContent = headline;
    elements.syncStatus.dataset.state = nextState;
    if (elements.syncDialog.open)
      statusAnimation = elements.syncStatus.animate([{ opacity: 0.65 }, { opacity: 1 }], {
        duration: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 160,
        easing: window.getComputedStyle?.(elements.syncDialog).getPropertyValue("--ease-out").trim() || "ease-out",
      });
  }
  elements.syncStatusDetail.hidden = !detail;
  elements.syncStatusDetail.textContent = detail;
  elements.syncLastSynced.hidden = !paired || !supported;
  elements.syncLastSynced.textContent = `Last synced on this device: ${
    status?.lastSuccessAt ? formatLastSynced(status.lastSuccessAt) : "Never"
  }`;
  // The headline already says so when nothing else is wrong; this line covers the rest.
  elements.syncDirty.hidden = !paired || !supported || !status?.dirty || busy || headline === "Changes waiting to sync";
  elements.syncScope.hidden = confirming || ended || !status;
  elements.syncUnpaired.hidden = paired || ended || !status;
  elements.syncEnded.hidden = !ended;
  elements.syncPaired.hidden = !paired || confirming;
  elements.syncNow.hidden = !paired || confirming || !supported;
  elements.syncNow.textContent = busy && busyMessage === "Syncing…" ? "Syncing…" : "Sync now";
  elements.syncNow.disabled = busy || !supported || status?.state === "syncing" || status?.state === "updating_key";
  elements.syncCodePanel.hidden = !master;
  elements.syncCodeAbout.hidden = codeMissing;
  elements.syncCodeMissing.hidden = !codeMissing;
  elements.syncCode.hidden = !showingCode;
  elements.syncCopyCode.hidden = !showingCode;
  elements.syncShowCode.hidden = codeMissing;
  elements.syncShowCode.textContent = showingCode ? "Hide code" : "Show code";
  elements.syncNewCode.className = codeMissing ? "primary-action" : "sync-dialog__button";
  elements.syncDissolve.hidden = !master;
  elements.syncLeave.hidden = master;
  elements.syncEnable.disabled = busy || !supported || !status;
  elements.syncJoin.disabled = busy || !supported || !status || !joinSummaryLoaded || selectedJoinMode() === null;
  for (const option of [elements.syncJoinRestore, elements.syncJoinMerge]) option.disabled = busy;
  elements.syncLeave.disabled = busy || !supported || status?.state === "syncing" || status?.state === "updating_key";
  elements.syncLeaveConfirmButton.disabled = busy;
  elements.syncClose.disabled = busy;
  for (const control of [
    elements.syncShowCode,
    elements.syncCopyCode,
    elements.syncNewCode,
    elements.syncNewCodeCancel,
    elements.syncNewCodeSubmit,
    elements.syncStartOver,
    elements.syncDissolve,
    elements.syncRemoveCancel,
    elements.syncRemoveDevice,
    elements.syncDissolveCancel,
    elements.syncDissolveWord,
  ])
    control.disabled = busy || !supported;
  elements.syncDissolveSubmit.disabled = busy || elements.syncDissolveWord.value !== END_WORD;
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
    if (elements.syncDialog.open && elements.syncError.hidden) {
      const message = `Current Sync status could not be verified. ${safeError(error)}`;
      // Damaged local Sync state cannot be repaired; starting over is the only way out.
      if (category(error) === "corrupt_local_state")
        showError(message, () => operate("Starting over…", leaveSync), "Reset Sync on this device");
      else showError(message, notRetryable.has(category(error) ?? "") ? null : refresh);
    }
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

// A returned status means saved data changed: update the status and reload open views.
// `undefined` means nothing changed (e.g. showing the code).
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
      try {
        await refreshPersistedView();
      } catch {
        // Keep the action's original error and retry; a pending journal may still block reads.
      }
      if (codeProblems.has(category(error) ?? "") && !elements.syncJoinForm.hidden) setCodeError(safeError(error));
      else showError(safeError(error), notRetryable.has(category(error) ?? "") ? null : () => operate(message, action));
      await refresh();
      return false;
    }
    if (result) {
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

const afterEnd = (): HTMLElement => (elements.syncEnded.hidden ? elements.syncEnable : elements.syncStartOver);

async function onSyncStateChanged(): Promise<void> {
  await refresh();
  await refreshView();
}

async function createCode(): Promise<void> {
  const created = await operate("Creating a new code…", async () => {
    hideCode();
    showCode(await newSyncCode());
    elements.syncNewCodeConfirm.hidden = true;
    return undefined;
  });
  focusWhenSettled(
    created
      ? elements.syncCopyCode
      : elements.syncNewCodeConfirm.hidden
        ? elements.syncNewCode
        : elements.syncNewCodeSubmit,
  );
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
  window.addEventListener("resize", () => {
    if (elements.syncDialog.open && !elements.syncJoinForm.hidden && document.activeElement === elements.syncCodeInput)
      elements.syncCodeInput.scrollIntoView({ block: "nearest" });
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
  elements.syncRetry.addEventListener("click", async () => {
    const again = retryAction;
    clearError();
    await again?.();
    // The button just left the page; keep focus inside the dialog, on the error if it came back.
    if (!elements.syncDialog.contains(document.activeElement))
      (elements.syncError.hidden ? elements.syncClose : elements.syncRetry).focus();
  });
  elements.syncDialog.addEventListener("close", () => {
    hideCode();
    resetJoin();
    elements.syncJoinForm.hidden = true;
    delete elements.syncDialog.dataset.joining;
    elements.syncLeaveConfirm.hidden = true;
    elements.syncRemoveConfirm.hidden = true;
    elements.syncNewCodeConfirm.hidden = true;
    elements.syncDissolveConfirm.hidden = true;
    elements.syncDissolveWord.value = "";
    removeTarget = null;
    clearError();
    render();
    onDialogClosed();
    (opener ?? elements.syncButton).focus?.();
  });
  elements.syncShowJoin.addEventListener("click", () => {
    elements.syncJoinForm.hidden = false;
    elements.syncDialog.dataset.joining = "true";
    elements.syncCodeInput.focus();
    void loadJoinSummary();
    render();
  });
  for (const option of [elements.syncJoinRestore, elements.syncJoinMerge])
    option.addEventListener("change", () => {
      renderJoin();
      render();
    });
  elements.syncCodeInput.addEventListener("input", () => setCodeError(null));
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
      if (result.code) showCode(result.code);
      return result.status;
    });
    focusWhenSettled(
      created ? (elements.syncCode.hidden ? elements.syncNewCode : elements.syncCopyCode) : elements.syncEnable,
    );
  });
  elements.syncCopyCode.addEventListener("click", async () => {
    try {
      await writeText(elements.syncCode.textContent);
      toast.success("Copied");
    } catch {
      document.getSelection?.()?.selectAllChildren(elements.syncCode);
      showError("Couldn’t copy the code. It’s selected above, so copy it by hand.");
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
    setCodeError(null);
    // Fixed at submit, so Try again repeats exactly this choice.
    const code = elements.syncCodeInput.value.trim();
    const joined = await operate(mode === "restore" ? "Restoring this device…" : "Merging this device…", async () => {
      const result = await joinSync(code, mode);
      resetJoin();
      elements.syncJoinForm.hidden = true;
      delete elements.syncDialog.dataset.joining;
      return result;
    });
    focusWhenSettled(joined ? elements.syncNow : elements.syncCodeInput);
  });
  elements.syncNow.addEventListener("click", async () => {
    await operate("Syncing…", syncNow);
    focusWhenSettled(elements.syncNow);
  });
  elements.syncShowCode.addEventListener("click", async () => {
    if (elements.syncCode.textContent) {
      hideCode();
      render();
      elements.syncShowCode.focus();
      return;
    }
    const shown = await operate("Reading your code…", async () => {
      showCode(await getSyncCode());
      return undefined;
    });
    focusWhenSettled(shown ? elements.syncCopyCode : elements.syncShowCode);
  });
  elements.syncNewCode.addEventListener("click", () => {
    elements.syncNewCodeConfirm.hidden = false;
    render();
    elements.syncNewCodeCancel.focus();
  });
  elements.syncNewCodeCancel.addEventListener("click", () => {
    elements.syncNewCodeConfirm.hidden = true;
    render();
    elements.syncNewCode.focus();
  });
  elements.syncNewCodeSubmit.addEventListener("click", () => void createCode());
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
      hideCode();
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
    if (elements.syncDissolveWord.value !== END_WORD) {
      elements.syncDissolveWord.focus();
      return;
    }
    const ended = await operate("Ending Sync for all devices…", async () => {
      const result = await dissolveSync();
      elements.syncDissolveConfirm.hidden = true;
      elements.syncDissolveWord.value = "";
      return result;
    });
    focusWhenSettled(ended ? afterEnd() : elements.syncDissolveSubmit);
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
    const left = await operate("Leaving this Sync…", async () => {
      const result = await leaveSync();
      elements.syncLeaveConfirm.hidden = true;
      return result;
    });
    focusWhenSettled(left ? afterEnd() : elements.syncLeaveConfirmButton);
  });
  elements.syncStartOver.addEventListener("click", async () => {
    const reset = await operate("Starting over…", leaveSync);
    focusWhenSettled(reset ? elements.syncEnable : elements.syncStartOver);
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
