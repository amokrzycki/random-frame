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

// Legacy Prnt.sc IDs are a sequential base-36 counter, not a fixed 6-character
// code: the upper bound is the empirically observed end of the legacy namespace.
const LEGACY_MAX_VALUE = 4_773_622_239;
// Shared validation pattern for Prnt.sc IDs: lowercase alphanumeric, 1-7 chars
export const PRNTSC_ID_PATTERN = /^[a-z0-9]{1,7}$/;

export function adjacentPrntscId(id: string, offset: number): string | null {
  if (!PRNTSC_ID_PATTERN.test(id) || ![-1, 1].includes(offset)) return null;
  const value = Number.parseInt(id, 36) + offset;
  return value >= 0 && value <= LEGACY_MAX_VALUE ? value.toString(36) : null;
}

export interface NearbySlot {
  index: number;
  offset: number;
  id: string | null;
}
export interface NearbyWindow {
  centerId: string;
  slots: [NearbySlot, NearbySlot, NearbySlot, NearbySlot, NearbySlot, NearbySlot, NearbySlot, NearbySlot, NearbySlot];
  previousCenterId: string | null;
  nextCenterId: string | null;
}
export function nearbyWindow(id: string): NearbyWindow {
  const center = Number.parseInt(id, 36);
  if (!PRNTSC_ID_PATTERN.test(id) || center > LEGACY_MAX_VALUE) throw new Error("Invalid image identifier");
  const at = (value: number) => (value >= 0 && value <= LEGACY_MAX_VALUE ? value.toString(36) : null);
  return {
    centerId: center.toString(36),
    slots: Array.from({ length: 9 }, (_, index) => ({
      index,
      offset: index - 4,
      id: at(center + index - 4),
    })) as NearbyWindow["slots"],
    previousCenterId: at(center - 4),
    nextCenterId: at(center + 4),
  };
}
