export function nextHistoryIndex(index: number, length: number): number | null {
  return index + 1 < length ? index + 1 : null;
}

export function shouldShowEntryDialog(storedAcceptance: string | null): boolean {
  return storedAcceptance !== "accepted";
}

export function historyFromStorage(value: string | null): { history: { id: string }[]; index: number } {
  try {
    const stored: unknown = JSON.parse(value ?? "");
    if (
      typeof stored !== "object" ||
      stored === null ||
      !("history" in stored) ||
      !("index" in stored) ||
      !Array.isArray(stored.history) ||
      !stored.history.every(
        (item) => typeof item === "object" && item !== null && "id" in item && typeof item.id === "string",
      ) ||
      typeof stored.index !== "number" ||
      !Number.isInteger(stored.index) ||
      stored.index < -1 ||
      stored.index >= stored.history.length
    )
      return { history: [], index: -1 };
    return { history: stored.history, index: stored.index };
  } catch {
    return { history: [], index: -1 };
  }
}

export function frameNumberToIndex(value: string, length: number): number | null {
  const frameNumber = Number(value);
  return Number.isInteger(frameNumber) && frameNumber >= 1 && frameNumber <= length ? frameNumber - 1 : null;
}

export function historyIndexForId(history: readonly { id: string }[], id: string): number {
  return history.findIndex((item) => item.id === id);
}

export function adjacentPrntscId(id: string, offset: number): string | null {
  if (!/^[a-z0-9]{6}$/.test(id) || ![-1, 1].includes(offset)) return null;
  const value = Number.parseInt(id, 36) + offset;
  return value >= 0 && value < 36 ** 6 ? value.toString(36).padStart(6, "0") : null;
}
