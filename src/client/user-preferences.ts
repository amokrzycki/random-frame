import { DEFAULT_PAGE_SIZE, PAGE_SIZE_STORAGE_KEY } from "./history-pagination.js";
import { getUserPreferences, setUserPreferences, type UserPreferences } from "./persistence.js";

const themeKey = "random-frame-theme";
let mutationGeneration = 0;
let pendingMutations = 0;
let mutationQueue: Promise<unknown> = Promise.resolve();

export async function updateUserPreferences(preferences: Partial<UserPreferences>): Promise<void> {
  const generation = ++mutationGeneration;
  pendingMutations += 1;
  const result = mutationQueue.then(() => setUserPreferences(preferences));
  mutationQueue = result.catch(() => undefined);
  try {
    const saved = await result;
    if (generation === mutationGeneration) applyUserPreferences(saved);
  } finally {
    pendingMutations -= 1;
  }
}

export function applyUserPreferences(preferences: UserPreferences | null): void {
  if (!preferences) return;
  try {
    if (preferences.theme) localStorage.setItem(themeKey, preferences.theme);
    else localStorage.removeItem(themeKey);
    if (preferences.historyPageSize) localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(preferences.historyPageSize));
    else localStorage.removeItem(PAGE_SIZE_STORAGE_KEY);
  } catch {
    // Rust remains authoritative when the early-render cache is unavailable.
  }
  // Absent registers are authoritative defaults for presentation, without creating synced values.
  document.dispatchEvent(
    new CustomEvent("user-preferences", {
      detail: {
        theme: preferences.theme ?? "system",
        historyPageSize: preferences.historyPageSize ?? DEFAULT_PAGE_SIZE,
      },
    }),
  );
}

export async function initializeUserPreferences(): Promise<void> {
  await refreshUserPreferences();
}

export async function refreshUserPreferences(): Promise<void> {
  const generation = mutationGeneration;
  const preferences = await getUserPreferences();
  if (generation === mutationGeneration && pendingMutations === 0) applyUserPreferences(preferences);
}
