import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import { describeError } from "./errors.js";
import {
  type CollectionEditorRequest,
  collectionLabels,
  collectionNameError,
  commitCollectionEditor,
  createCollection,
  deleteCollection,
  newOperationId,
  operationKey,
  type RemoveSavedRequest,
  removeSavedFrame,
  renameCollection,
  restoreSavedFrames,
  type SavedCollection,
  type SavedItem,
  type SavedMembership,
  type SavedUndo,
  savedFrameRef,
} from "./favorites.js";
import { ensureThumbnail } from "./frame-cache.js";
import { syncControls } from "./stage.js";
import { toast } from "./toast.js";
import { applySavedLibrary, mutateSavedLibrary, refreshPersistedView, state } from "./viewer-state.js";

interface Draft {
  item: SavedItem;
  observed: SavedMembership[];
  initial: Set<string>;
  selected: Set<string>;
  collections: SavedCollection[];
  created: SavedCollection[];
  request?: CollectionEditorRequest;
  removal?: RemoveSavedRequest;
  moveFrom?: string | undefined;
}
let draft: Draft | undefined;
let busy = false;
const changed = (): void => {
  if (draft) delete draft.request;
};
const notifyLibrary = (): void => {
  syncControls();
  document.dispatchEvent(new CustomEvent("persisted-view-refreshed"));
};
function setBusy(next: boolean): void {
  busy = next;
  if (next) elements.collectionsDialog.dataset.busy = "true";
  else delete elements.collectionsDialog.dataset.busy;
  elements.collectionsForm.setAttribute("aria-busy", String(next));
  elements.collectionsChoices.disabled = next;
  for (const control of [
    elements.collectionsApply,
    elements.collectionsCancel,
    elements.collectionsClose,
    elements.collectionsAdd,
    elements.collectionsRemove,
    elements.collectionsName,
    elements.collectionsReopen,
    elements.collectionsMoveButton,
    elements.collectionsMoveTarget,
  ])
    control.disabled = next;
}
function editorError(error: unknown): void {
  const stale = (error as { kind?: string })?.kind === "stale_saved_frame";
  elements.collectionsError.textContent = stale
    ? "This save changed while you were editing. Your choices are still here. Open the current save to begin a new edit."
    : (error as { kind?: string })?.kind === "invalid-input"
      ? `${(error as { message: string }).message} Your choices are still here.`
      : describeError(error, "Changes could not be saved. Your choices are still here; try Apply again.").message;
  elements.collectionsError.hidden = false;
  elements.collectionsReopen.hidden =
    !stale || !state.favorites.some((x) => x.source === draft?.item.source && x.id === draft.item.id);
  elements.collectionsError.focus();
}
function renderChoices(): void {
  if (!draft) return;
  const labels = collectionLabels([...draft.collections, ...draft.created]);
  elements.collectionsChoices.replaceChildren();
  for (const collection of [...draft.collections, ...draft.created]) {
    const key = operationKey(collection.collectionId);
    const label = document.createElement("label");
    const box = document.createElement("input");
    const name = document.createElement("span");
    box.type = "checkbox";
    box.checked = draft.selected.has(key);
    box.dataset.collectionId = key;
    name.textContent = labels.get(key) ?? collection.name;
    label.className = "collections-choice";
    name.className = "collections-choice__name";
    label.append(box, name);
    box.addEventListener("change", () => {
      if (!draft) return;
      if (box.checked) draft.selected.add(key);
      else draft.selected.delete(key);
      changed();
    });
    elements.collectionsChoices.append(label);
  }
}
function renderMove(): void {
  if (!draft) return;
  const targets = [...draft.collections, ...draft.created].filter(
    (c) => operationKey(c.collectionId) !== draft?.moveFrom,
  );
  elements.collectionsMove.hidden = !draft.moveFrom || !targets.length;
  const labels = collectionLabels(targets);
  elements.collectionsMoveTarget.replaceChildren();
  for (const collection of targets) {
    const option = document.createElement("option");
    option.value = operationKey(collection.collectionId);
    option.textContent = labels.get(option.value) ?? collection.name;
    elements.collectionsMoveTarget.append(option);
  }
}
export function openCollections(item: SavedItem, moveFrom?: string): void {
  if (busy) return;
  const saves = new Set(item.saveOperationIds.map(operationKey));
  const observed = state.library.memberships.filter((m) => saves.has(operationKey(m.favoriteOperationId)));
  const initial = new Set(observed.map((m) => operationKey(m.collectionId)));
  draft = {
    item: structuredClone(item),
    observed: structuredClone(observed),
    initial,
    selected: new Set(initial),
    collections: structuredClone(state.library.collections),
    created: [],
    moveFrom,
  };
  elements.collectionsFrame.textContent = `${item.source === "prntsc" ? "prnt.sc" : item.source}/${item.id}`;
  elements.collectionsName.value = "";
  elements.collectionsName.removeAttribute("aria-invalid");
  elements.collectionsNameError.hidden = true;
  elements.collectionsError.hidden = true;
  elements.collectionsReopen.hidden = true;
  renderChoices();
  renderMove();
  openDialog(elements.collectionsDialog);
  (elements.collectionsChoices.querySelector<HTMLInputElement>("input") ?? elements.collectionsName).focus();
}
function addDraftCollection(): void {
  if (!draft || busy) return;
  const error = collectionNameError(elements.collectionsName.value);
  elements.collectionsNameError.textContent = error ?? "";
  elements.collectionsNameError.hidden = !error;
  elements.collectionsName.setAttribute("aria-invalid", String(Boolean(error)));
  if (error) {
    elements.collectionsName.focus();
    return;
  }
  const collection = { collectionId: newOperationId(), name: elements.collectionsName.value.trim() };
  draft.created.push(collection);
  draft.selected.add(operationKey(collection.collectionId));
  elements.collectionsName.value = "";
  changed();
  renderChoices();
  renderMove();
  elements.announcer.textContent = `${collection.name} added to choices. Apply creates the collection.`;
  elements.collectionsName.focus();
}
async function applyEditor(): Promise<void> {
  if (!draft || busy) return;
  // An unsubmitted name stays in the draft; make its required action explicit before closing it.
  if (elements.collectionsName.value.trim()) {
    elements.collectionsNameError.textContent = "Add this name to choices before applying, or clear the field.";
    elements.collectionsNameError.hidden = false;
    return elements.collectionsName.focus();
  }
  const editor = draft;
  const all = [...editor.collections, ...editor.created];
  editor.request ??= {
    requestId: newOperationId(),
    frame: savedFrameRef(editor.item),
    createCollections: editor.created,
    addToCollectionIds: all
      .filter(
        (c) => editor.selected.has(operationKey(c.collectionId)) && !editor.initial.has(operationKey(c.collectionId)),
      )
      .map((c) => c.collectionId),
    removeMembershipOperationIds: editor.observed
      .filter((m) => !editor.selected.has(operationKey(m.collectionId)))
      .map((m) => m.operationId),
  };
  setBusy(true);
  try {
    await mutateSavedLibrary(async () =>
      applySavedLibrary(await commitCollectionEditor(editor.request as CollectionEditorRequest)),
    );
    notifyLibrary();
    setBusy(false);
    closeDialog(elements.collectionsDialog);
    toast.success("Collections updated");
  } catch (error) {
    if ((error as { kind?: string })?.kind === "stale_saved_frame") {
      try {
        await refreshPersistedView();
      } catch {
        /* Keep the draft and the original stale error. */
      }
    }
    editorError(error);
  } finally {
    setBusy(false);
  }
}
export async function restoreSavedUndo(undo: SavedUndo): Promise<boolean> {
  try {
    await mutateSavedLibrary(async () => applySavedLibrary(await restoreSavedFrames(undo)));
    notifyLibrary();
    for (const item of state.favorites) void ensureThumbnail(item).catch(() => false);
    return true;
  } catch (error) {
    toast.error(
      describeError(error, "Saved frames could not be restored. Undo is still available; try again.").message,
    );
    return false;
  }
}
export async function removeSavedWithUndo(item: SavedItem, request?: RemoveSavedRequest): Promise<boolean> {
  const frozen = request ?? { requestId: newOperationId(), frames: [savedFrameRef(item)] };
  try {
    const result = await mutateSavedLibrary(async () => {
      const result = await removeSavedFrame(frozen);
      applySavedLibrary(result.library);
      return result;
    });
    notifyLibrary();
    toast.info("Removed from all saved", { label: "Undo", run: () => restoreSavedUndo(result.undo) });
    return true;
  } catch (error) {
    if (elements.collectionsDialog.open) {
      if ((error as { kind?: string })?.kind === "stale_saved_frame") {
        try {
          await refreshPersistedView();
        } catch {
          /* Keep the original error and draft. */
        }
      }
      editorError(error);
    } else toast.error(describeError(error, "That saved frame could not be removed. Try again.").message);
    return false;
  }
}

let management: { mode: "create" | "rename" | "delete"; collection?: SavedCollection | undefined } | undefined;
let manageBusy = false;
export function openCollectionManagement(mode: "create" | "rename" | "delete", collection?: SavedCollection): void {
  if (manageBusy || (mode !== "create" && !collection)) return;
  management = { mode, collection: collection && structuredClone(collection) };
  elements.collectionManageTitle.textContent =
    mode === "create" ? "New collection" : mode === "rename" ? "Rename collection" : "Delete collection?";
  elements.collectionManageApply.textContent =
    mode === "create" ? "Create collection" : mode === "rename" ? "Rename collection" : "Delete collection";
  elements.collectionManageApply.classList.toggle("sync-dialog__button--danger", mode === "delete");
  elements.collectionManageCopy.textContent = `Delete “${collection?.name}”? Its images stay in All saved and in their other collections.`;
  elements.collectionManageCopy.hidden = mode !== "delete";
  elements.collectionManageField.hidden = mode === "delete";
  elements.collectionManageName.value = mode === "rename" ? (collection?.name ?? "") : "";
  elements.collectionManageName.removeAttribute("aria-invalid");
  elements.collectionManageError.hidden = true;
  openDialog(elements.collectionManageDialog);
  (mode === "delete" ? elements.collectionManageCancel : elements.collectionManageName).focus();
}
async function applyManagement(): Promise<void> {
  if (!management || manageBusy) return;
  const { mode, collection } = management;
  const error = mode !== "delete" && collectionNameError(elements.collectionManageName.value);
  if (error) {
    elements.collectionManageError.textContent = error;
    elements.collectionManageError.hidden = false;
    elements.collectionManageName.setAttribute("aria-invalid", "true");
    return elements.collectionManageName.focus();
  }
  manageBusy = true;
  elements.collectionManageDialog.dataset.busy = "true";
  elements.collectionManageApply.disabled =
    elements.collectionManageCancel.disabled =
    elements.collectionManageName.disabled =
      true;
  const name = elements.collectionManageName.value.trim();
  try {
    await mutateSavedLibrary(async () => {
      const library =
        mode === "create"
          ? await createCollection(name)
          : mode === "rename"
            ? await renameCollection((collection as SavedCollection).collectionId, name)
            : await deleteCollection((collection as SavedCollection).collectionId);
      applySavedLibrary(library);
    });
    notifyLibrary();
    delete elements.collectionManageDialog.dataset.busy;
    closeDialog(elements.collectionManageDialog);
    toast.success(
      mode === "create"
        ? "Collection created"
        : mode === "rename"
          ? "Collection renamed"
          : "Collection deleted. Images stay saved.",
    );
  } catch (error) {
    elements.collectionManageError.textContent = describeError(
      error,
      "The collection could not be updated. Try again.",
    ).message;
    elements.collectionManageError.hidden = false;
    elements.collectionManageError.focus();
  } finally {
    manageBusy = false;
    delete elements.collectionManageDialog.dataset.busy;
    elements.collectionManageApply.disabled =
      elements.collectionManageCancel.disabled =
      elements.collectionManageName.disabled =
        false;
  }
}
export function bindCollectionEvents(): void {
  elements.collectionsAdd.addEventListener("click", addDraftCollection);
  elements.collectionsName.addEventListener("input", changed);
  elements.collectionsName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addDraftCollection();
    }
  });
  elements.collectionsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void applyEditor();
  });
  for (const button of [elements.collectionsCancel, elements.collectionsClose])
    button.addEventListener("click", () => closeDialog(elements.collectionsDialog));
  elements.collectionsDialog.addEventListener("close", () => {
    draft = undefined;
    onDialogClosed();
    if (!elements.lightboxDialog.open && !elements.historyDialog.open) elements.favoriteButton.focus();
  });
  elements.collectionsReopen.addEventListener("click", () => {
    const item = state.favorites.find((x) => x.source === draft?.item.source && x.id === draft.item.id);
    if (item) openCollections(item, draft?.moveFrom);
  });
  elements.collectionsMoveButton.addEventListener("click", () => {
    if (!draft || busy) return;
    const target = elements.collectionsMoveTarget.value;
    if (!target) return;
    draft.selected.delete(draft.moveFrom ?? "");
    draft.selected.add(target);
    changed();
    renderChoices();
    elements.announcer.textContent = "Move selected. Apply commits the move.";
  });
  elements.collectionsRemove.addEventListener("click", async () => {
    if (!draft || busy) return;
    draft.removal ??= { requestId: newOperationId(), frames: [savedFrameRef(draft.item)] };
    const editor = draft;
    setBusy(true);
    const removed = await removeSavedWithUndo(editor.item, editor.removal);
    setBusy(false);
    if (removed) closeDialog(elements.collectionsDialog);
  });
  elements.collectionManageCancel.addEventListener("click", () => closeDialog(elements.collectionManageDialog));
  elements.collectionManageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void applyManagement();
  });
  elements.collectionManageDialog.addEventListener("close", () => {
    management = undefined;
    onDialogClosed();
  });
  // Sync updates available names, never the form's choices or identity of the edited save.
  document.addEventListener("persisted-view-refreshed", () => {
    if (!draft || !elements.collectionsDialog.open) return;
    const labels = collectionLabels(state.library.collections);
    for (const label of elements.collectionsChoices.querySelectorAll<HTMLLabelElement>("label")) {
      const box = label.querySelector<HTMLInputElement>("input");
      const text = label.querySelector<HTMLElement>("span");
      if (!box || !text || draft.created.some((c) => operationKey(c.collectionId) === box.dataset.collectionId))
        continue;
      const name = labels.get(box.dataset.collectionId ?? "");
      if (name) text.textContent = name;
      else
        text.textContent = `${draft.collections.find((c) => operationKey(c.collectionId) === box.dataset.collectionId)?.name ?? "Collection"} (unavailable)`;
    }
  });
}
