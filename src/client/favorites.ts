import { invoke } from "@tauri-apps/api/core";

export interface FavoriteItem {
  source: string;
  id: string;
  sourcePageUrl: string;
  addedAt: number;
}

export function getFavorites(): Promise<FavoriteItem[]> {
  return invoke("get_favorites");
}

// Adds the frame, or removes it when it is already a favorite; resolves to the saved list.
export function toggleFavorite(item: FavoriteItem): Promise<FavoriteItem[]> {
  return invoke("toggle_favorite", { item });
}

export function clearFavorites(): Promise<void> {
  return invoke("clear_favorites");
}
