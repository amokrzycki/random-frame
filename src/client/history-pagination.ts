// Presentation-only paging over the full local history; the stored history is never sliced.
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;
export const PAGE_SIZE_STORAGE_KEY = "random-frame-history-page-size";

export function parsePageSize(value: unknown): PageSize {
  const size = Number(value);
  return PAGE_SIZES.find((allowed) => allowed === size) ?? DEFAULT_PAGE_SIZE;
}

export function loadPageSize(storage: Pick<Storage, "getItem">): PageSize {
  try {
    return parsePageSize(storage.getItem(PAGE_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

export function savePageSize(storage: Pick<Storage, "setItem">, size: PageSize): void {
  try {
    storage.setItem(PAGE_SIZE_STORAGE_KEY, String(size));
  } catch {
    // The choice still applies for this session when storage is unavailable.
  }
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

export function pageOf(itemIndex: number, size: number): number {
  return Math.max(0, Math.floor(itemIndex / size));
}

export interface HistoryPage {
  page: number;
  pages: number;
  start: number;
  end: number;
}

// Clamps a possibly stale page index (e.g. after records disappear) to one that exists.
export function historyPage(total: number, page: number, size: number): HistoryPage {
  const pages = pageCount(total, size);
  const clamped = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1);
  const start = clamped * size;
  return { page: clamped, pages, start, end: Math.min(total, start + size) };
}
