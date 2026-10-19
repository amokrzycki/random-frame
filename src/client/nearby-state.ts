import type { NearbyResolution, NearbyWindowState } from "./api.js";
import type { NearbyWindow } from "./navigation.js";
import { nearbyWindow } from "./navigation.js";

export type TilePhase = "boundary" | "queued" | "loading" | "ready" | "unavailable" | "retryable" | "unsaved";
export interface TileState {
  id: string | null;
  index: number;
  current: boolean;
  phase: TilePhase;
  requestId: number;
  message: string;
  kind?: string;
  retryAfterMs?: number;
  evidence?: number;
}
export function nearbyTiles(window: NearbyWindow, anchor: string): TileState[] {
  return window.slots.map(({ id, index }) => ({
    id,
    index,
    current: id === anchor,
    phase: id === null ? "boundary" : id === anchor ? "ready" : "queued",
    requestId: 0,
    message: "",
  }));
}
export function queueOrder(tiles: readonly TileState[]): TileState[] {
  return tiles
    .filter((tile) => tile.phase === "queued")
    .sort((a, b) => Math.abs(a.index - 4) - Math.abs(b.index - 4) || a.index - b.index);
}
interface Dependencies {
  setWindow(centerId: string, generation: number): Promise<NearbyWindowState>;
  resolve(id: string, generation: number, retry: boolean): Promise<NearbyResolution>;
  changed(): void;
}
// This queue owns only gallery work; viewer loading and durable writes retain their existing owners.
export class NearbySession {
  readonly anchor: string;
  window: NearbyWindow;
  tiles: TileState[];
  generation = 0;
  active = true;
  paused = false;
  private acknowledged = 0;
  private inFlight = 0;
  private serial = 0;
  private retryIds = new Set<string>();
  constructor(
    anchor: string,
    private readonly dependencies: Dependencies,
  ) {
    this.anchor = nearbyWindow(anchor).centerId;
    this.window = nearbyWindow(anchor);
    this.tiles = nearbyTiles(this.window, this.anchor);
  }
  async move(center: string): Promise<void> {
    if (!this.active) return;
    const generation = ++this.generation;
    const previous = new Map(this.tiles.filter((tile) => tile.id).map((tile) => [tile.id, tile]));
    this.window = nearbyWindow(center);
    this.tiles = nearbyTiles(this.window, this.anchor).map((tile) => {
      const old = previous.get(tile.id);
      return old ? { ...old, index: tile.index } : tile;
    });
    this.dependencies.changed();
    try {
      const result = await this.dependencies.setWindow(this.window.centerId, generation);
      if (!this.active || generation !== this.generation) return;
      // Compare window structure directly instead of JSON.stringify for better performance
      if (
        result.window.centerId !== this.window.centerId ||
        result.window.slots.length !== this.window.slots.length ||
        !result.window.slots.every((slot, i) => slot.id === this.window.slots[i]?.id)
      ) {
        throw new Error("Nearby window did not match source range");
      }
      for (const tile of this.tiles) {
        const evidence = tile.id ? result.evidence[tile.id] : undefined;
        if (evidence !== undefined) tile.evidence = evidence;
        // Evidence bitmask: bit 1 (value 2) = rejected-only, meaning unavailable
        if (tile.id && !tile.current && tile.phase === "queued" && result.evidence[tile.id] === 2)
          tile.phase = "unavailable";
      }
      this.acknowledged = generation;
    } catch (error) {
      if (!this.active || generation !== this.generation) return;
      for (const tile of this.tiles)
        if (tile.phase === "queued") {
          tile.phase = "retryable";
          tile.message = error instanceof Error ? error.message : "Source could not be loaded";
        }
    }
    this.dependencies.changed();
    this.pump();
  }
  retry(id?: string): void {
    if (!this.active || this.paused) return;
    for (const tile of this.tiles) {
      if (tile.id && (!id || tile.id === id) && ["retryable", "unsaved"].includes(tile.phase)) {
        tile.phase = "queued";
        this.retryIds.add(tile.id);
      }
    }
    if (this.acknowledged !== this.generation) void this.move(this.window.centerId);
    else this.pump();
  }
  private pump(): void {
    if (!this.active || this.paused || this.acknowledged !== this.generation) return;
    while (this.inFlight < 2) {
      const tile = queueOrder(this.tiles)[0];
      if (!tile?.id) break;
      const id = tile.id;
      const requestId = ++this.serial;
      tile.requestId = requestId;
      tile.phase = "loading";
      this.inFlight++;
      const retry = this.retryIds.delete(id);
      void this.dependencies
        .resolve(id, this.generation, retry)
        .then((result) => {
          if (!this.active) return;
          const current = this.tiles.find((tile) => tile.id === id && tile.requestId === requestId);
          if (!current) return;
          if (result.state === "canceled") {
            current.phase = "queued";
            return;
          }
          current.phase = result.state === "available" ? "ready" : result.state;
          current.message = "message" in result ? result.message : "";
          if (result.state === "retryable") {
            current.kind = result.kind;
            if (result.retryAfterMs) current.retryAfterMs = result.retryAfterMs;
          }
        })
        .catch((error) => {
          const current = this.active && this.tiles.find((tile) => tile.id === id && tile.requestId === requestId);
          if (current) {
            current.phase = "retryable";
            current.message = error instanceof Error ? error.message : "Preview could not be loaded";
            // Preserve error kind for status display
            if (typeof error === "object" && error !== null && "kind" in error) {
              current.kind = String((error as { kind: unknown }).kind);
            }
          }
        })
        .finally(() => {
          this.inFlight--;
          if (this.active) {
            this.dependencies.changed();
            this.pump();
          }
        });
    }
    this.dependencies.changed();
  }
  close(): void {
    this.active = false;
    this.generation++;
  }
}
