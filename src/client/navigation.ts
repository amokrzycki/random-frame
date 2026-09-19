export function nextHistoryIndex(index: number, length: number): number | null {
  return index + 1 < length ? index + 1 : null;
}

export function shouldShowEntryDialog(storedAcceptance: string | null): boolean {
  return storedAcceptance !== "accepted";
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
