import { invoke } from "@tauri-apps/api/core";

// IPC uses the same sixteen-byte array for every save, collection, membership and request ID.
export type OperationId = number[];
export interface FavoriteItem {
  source: string;
  id: string;
  sourcePageUrl: string;
  addedAt: number;
}
export interface SavedItem extends FavoriteItem {
  saveOperationIds: OperationId[];
}
export interface SavedCollection {
  collectionId: OperationId;
  name: string;
}
export interface SavedMembership {
  operationId: OperationId;
  collectionId: OperationId;
  favoriteOperationId: OperationId;
}
export interface SavedLibrary {
  items: SavedItem[];
  collections: SavedCollection[];
  memberships: SavedMembership[];
}
export interface SavedFrameRef {
  source: string;
  id: string;
  expectedSaveOperationIds: OperationId[];
}
export interface CollectionEditorRequest {
  requestId: OperationId;
  frame: SavedFrameRef;
  createCollections: SavedCollection[];
  addToCollectionIds: OperationId[];
  removeMembershipOperationIds: OperationId[];
}
export interface RemoveSavedRequest {
  requestId: OperationId;
  frames: SavedFrameRef[];
}
export interface SavedUndo {
  requestId: OperationId;
  frames: { item: FavoriteItem; collectionIds: OperationId[] }[];
}
export interface RemovedSaved {
  library: SavedLibrary;
  undo: SavedUndo;
}
export const operationKey = (id: OperationId): string => id.map((byte) => byte.toString(16).padStart(2, "0")).join("");
export const newOperationId = (): OperationId => Array.from(crypto.getRandomValues(new Uint8Array(16)));
export const savedFrameRef = (item: SavedItem): SavedFrameRef => ({
  source: item.source,
  id: item.id,
  expectedSaveOperationIds: item.saveOperationIds.map((id) => [...id]),
});
export function collectionNameError(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Enter a collection name.";
  if (new TextEncoder().encode(name).length > 128) return "Use a name of at most 128 UTF-8 bytes.";
  if (/\p{Cc}/u.test(name)) return "Remove control characters from the name.";
}
export function collectionLabels(collections: SavedCollection[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const collection of collections) {
    const same = collections.filter((other) => other.name === collection.name);
    labels.set(
      operationKey(collection.collectionId),
      same.length > 1 ? `${collection.name} (${same.indexOf(collection) + 1})` : collection.name,
    );
  }
  return labels;
}
export const getSavedLibrary = (): Promise<SavedLibrary> => invoke("get_saved_library");
export const saveFrame = (item: FavoriteItem, collectionId?: OperationId): Promise<SavedLibrary> =>
  invoke("save_frame", { item, collectionId });
export const commitCollectionEditor = (request: CollectionEditorRequest): Promise<SavedLibrary> =>
  invoke("commit_collection_editor", { request });
export const createCollection = (name: string): Promise<SavedLibrary> => invoke("create_collection", { name });
export const renameCollection = (collectionId: OperationId, name: string): Promise<SavedLibrary> =>
  invoke("rename_collection", { collectionId, name });
export const deleteCollection = (collectionId: OperationId): Promise<SavedLibrary> =>
  invoke("delete_collection", { collectionId });
export const removeSavedFrame = (request: RemoveSavedRequest): Promise<RemovedSaved> =>
  invoke("remove_saved_frame", { request });
export const clearSavedFrames = (request: RemoveSavedRequest): Promise<RemovedSaved> =>
  invoke("clear_saved_frames", { request });
export const restoreSavedFrames = (undo: SavedUndo): Promise<SavedLibrary> => invoke("restore_saved_frames", { undo });
