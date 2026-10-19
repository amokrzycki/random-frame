import { closeNearby, getNearbyThumbnail, type NearbyResolution, resolveNearbyFrame, setNearbyWindow } from "./api.js";
import { closeDialog, onDialogClosed, openDialog } from "./dialogs.js";
import { elements } from "./elements.js";
import {
  blobKey,
  blobs,
  borrowBlobUrl,
  cacheEncodedThumbnail,
  cacheThumbnail,
  discardThumbnail,
  persistThumbnails,
  shareThumbnail,
  thumbnailFor,
  thumbnailGeneration,
} from "./frame-cache.js";
import { openNearbyFrame } from "./frame-loader.js";
import { nearbyWindow } from "./navigation.js";
import { NearbySession, type TilePhase, type TileState } from "./nearby-state.js";
import { decodedUrl, getViewState } from "./stage.js";
import { toast } from "./toast.js";
import { state } from "./viewer-state.js";

// Default upstream pause duration when Retry-After is absent
const DEFAULT_PAUSE_DURATION_MS = 10_000;
// Maximum safe delay for setTimeout in browsers (2^31 - 1 ms)
const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647;

interface TileNode {
  li: HTMLLIElement;
  control: HTMLButtonElement | HTMLDivElement;
  image: HTMLImageElement;
  well: HTMLElement;
  id: HTMLElement;
  status: HTMLElement;
  phase: string;
}
let session: NearbySession | undefined;
let sessionId = "";
let anchorUrl = "";
let releaseAnchor: (() => void) | undefined;
let lastNotice = "";
let selected: string | undefined;
const nodes = new Map<string, TileNode>();
let animation: Animation | undefined;
let loadingTimer: ReturnType<typeof setTimeout> | undefined;
let summaryTimer: ReturnType<typeof setTimeout> | undefined;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
let pauseUntil = 0;
let loadingVisible = false;
let thumbnailNotice = false;
let bound = false;
const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

function settleMotion(): void {
  animation?.cancel();
  animation = undefined;
  for (const node of nodes.values())
    node.image.getAnimations?.().forEach((effect) => {
      effect.cancel();
    });
}
function describeTile(tile: TileState): string {
  const id = tile.id ?? "Outside source range";
  if (tile.current && tile.phase === "ready") return `Current frame ${tile.id}`;
  if (tile.phase === "ready") return `Open Prnt.sc frame ${tile.id}`;
  if (isActionablePhase(tile.phase)) return `Retry preview for ${tile.id}, ${tile.message}`;
  if (tile.phase === "unavailable") return `${id}, unavailable`;
  if (tile.phase === "loading" || tile.phase === "queued") {
    const wasChecked = tile.evidence !== undefined && (tile.evidence & 1) !== 0;
    return `${id}, ${wasChecked ? "previously checked; loading preview" : "loading preview"}`;
  }
  return `${id}, outside range`;
}
function isActionablePhase(phase: TilePhase): boolean {
  return phase === "ready" || phase === "retryable" || phase === "unsaved";
}
function stop(selectedId?: string): void {
  if (!session?.active) return;
  session.close();
  settleMotion();
  elements.nearbyDialog.removeAttribute("data-pending");
  clearTimeout(loadingTimer);
  clearTimeout(summaryTimer);
  clearTimeout(pauseTimer);
  void closeNearby(sessionId, selectedId).catch((error) => {
    // Replaced session is already canceled; log other errors for diagnostics
    if (error && typeof error === "object" && "kind" in error && error.kind !== "not-found") {
      console.warn("closeNearby failed:", error);
    }
  });
}
function activate(tile: TileState): void {
  if (!session?.active || !tile.id || selected) return;
  if (tile.phase === "retryable" || tile.phase === "unsaved") {
    if (Date.now() >= pauseUntil) session.retry(tile.id);
    return;
  }
  if (tile.phase !== "ready") return;
  selected = tile.current ? undefined : tile.id;
  stop(selected);
  closeDialog(elements.nearbyDialog);
}
function makeNode(tile: TileState): TileNode {
  const li = document.createElement("li");
  const actionable = isActionablePhase(tile.phase);
  const control = document.createElement(actionable ? "button" : "div");
  if (control.tagName === "BUTTON") (control as HTMLButtonElement).type = "button";
  control.className = "nearby-tile";
  const well = document.createElement("span");
  well.className = "nearby-well";
  const image = document.createElement("img");
  image.alt = "";
  image.hidden = true;
  well.append(image);
  const caption = document.createElement("span");
  caption.className = "nearby-caption";
  const id = document.createElement("span");
  id.className = "nearby-id";
  const status = document.createElement("span");
  status.className = "nearby-state";
  caption.append(id, status);
  control.append(well, caption);
  li.append(control);
  let pointerGeneration = -1;
  control.addEventListener("pointerdown", () => {
    pointerGeneration = session?.generation ?? -1;
  });
  control.addEventListener("click", (event) => {
    if ((event as MouseEvent).detail > 0 && pointerGeneration !== session?.generation) return;
    const current = session?.tiles.find((item) => item.id === tile.id && item.index === Number(li.dataset.index));
    if (current) activate(current);
  });
  return { li, control, image, well, id, status, phase: tile.phase };
}
function render(): void {
  if (!session?.active) return;
  const active = document.activeElement as HTMLElement | null;
  const wanted = new Set<string>();
  for (const tile of session.tiles) {
    const key = tile.id ?? `boundary-${tile.index}`;
    wanted.add(key);
    let node = nodes.get(key);
    const actionable = isActionablePhase(tile.phase);
    const previousPhase = node?.phase;
    if (node && (node.control.tagName === "BUTTON") !== actionable) {
      const focused = node.control === active;
      node.li.remove();
      nodes.delete(key);
      node = undefined;
      if (focused) elements.nearbyClose.focus();
    }
    if (!node) {
      node = makeNode(tile);
      if (previousPhase) node.phase = previousPhase;
      nodes.set(key, node);
    }
    node.li.dataset.index = String(tile.index);
    node.control.dataset.state = tile.phase;
    node.control.toggleAttribute("data-current", tile.current);
    node.control.setAttribute("aria-busy", String(tile.phase === "loading" || tile.phase === "queued"));
    if (tile.current) node.control.setAttribute("aria-current", "true");
    else node.control.removeAttribute("aria-current");
    node.id.textContent = tile.id ?? "—";
    node.status.textContent =
      tile.phase === "unsaved"
        ? "Check not saved · Retry"
        : tile.current
          ? "Current"
          : {
              boundary: "Outside range",
              queued: "",
              loading: "",
              ready: "",
              unavailable: "Unavailable",
              retryable: tile.kind === "invalid-response" ? "Preview unavailable" : "Try again",
              unsaved: "Check not saved · Retry",
            }[tile.phase];
    node.control.setAttribute("aria-label", describeTile(tile));
    if (tile.message) {
      node.status.id = `nearby-error-${tile.id}`;
      node.control.setAttribute("aria-describedby", node.status.id);
      node.control.title = tile.message;
    } else {
      node.control.removeAttribute("aria-describedby");
      node.control.removeAttribute("title");
    }
    const image = tile.current ? anchorUrl : tile.id && thumbnailFor(blobKey("prntsc", tile.id));
    if (image && (tile.phase === "ready" || tile.current)) {
      if (node.image.getAttribute("src") !== image) {
        node.image.src = image;
        node.image.hidden = false;
        if (node.phase !== "ready" && !reduced?.matches)
          node.image.animate?.([{ opacity: 0 }, { opacity: 1 }], {
            duration: 180,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          });
      }
    } else {
      node.image.hidden = true;
      node.image.removeAttribute("src");
    }
    node.phase = tile.phase;
    elements.nearbyGrid.append(node.li);
  }
  for (const [key, node] of nodes)
    if (!wanted.has(key)) {
      node.li.remove();
      nodes.delete(key);
    }
  if (active?.isConnected && elements.nearbyGrid.contains(active)) active.focus({ preventScroll: true });
  elements.nearbyCenter.textContent = session.window.centerId;
  elements.nearbyPrevious.setAttribute("aria-disabled", String(!session.window.previousCenterId));
  elements.nearbyNext.setAttribute("aria-disabled", String(!session.window.nextCenterId));
  const pending = session.tiles.some((tile) => tile.phase === "queued" || tile.phase === "loading");
  const failed = session.tiles.filter((tile) => tile.phase === "retryable").length;
  const unsaved = session.tiles.some((tile) => tile.phase === "unsaved");
  elements.nearbyRetry.hidden = failed < 2;
  elements.nearbyRetry.setAttribute("aria-disabled", String(Date.now() < pauseUntil));
  if (pending && !loadingTimer && !loadingVisible)
    loadingTimer = setTimeout(() => {
      loadingTimer = undefined;
      loadingVisible = true;
      render();
    }, 150);
  if (!pending) {
    clearTimeout(loadingTimer);
    loadingTimer = undefined;
    loadingVisible = false;
  }
  elements.nearbyDialog.toggleAttribute("data-pending", pending && loadingVisible && !document.hidden);
  elements.nearbyStatus.textContent = unsaved
    ? "Some checks could not be saved. Retry their tiles."
    : Date.now() < pauseUntil
      ? "Prnt.sc is limiting requests. Try again shortly."
      : pending && loadingVisible
        ? "Loading previews"
        : "";
  const notice = unsaved
    ? "Some checks could not be saved. Retry their tiles."
    : Date.now() < pauseUntil
      ? "Prnt.sc is limiting requests. Try again shortly."
      : "";
  if (notice && notice !== lastNotice) {
    lastNotice = notice;
    elements.nearbyLive.textContent = notice;
  }
  clearTimeout(summaryTimer);
  if (!pending && !notice)
    summaryTimer = setTimeout(() => {
      if (!session?.active) return;
      const ready = session.tiles.filter((tile) => tile.phase === "ready" && !tile.current).length;
      const missing = session.tiles.filter((tile) => tile.phase === "unavailable").length;
      const message = `${ready} previews available, ${missing} unavailable, ${failed} need retry`;
      if (elements.nearbyLive.textContent !== message) elements.nearbyLive.textContent = message;
    }, 180);
}
async function move(direction: -1 | 1): Promise<void> {
  if (!session?.active) return;
  const moving = session;
  const center = direction < 0 ? session.window.previousCenterId : session.window.nextCenterId;
  if (!center) return;
  const button = direction < 0 ? elements.nearbyPrevious : elements.nearbyNext;
  button.focus();
  settleMotion();
  const generation = moving.generation + 1;
  await moving.move(center);
  if (session !== moving || !moving.active || moving.generation !== generation) return;
  elements.nearbyLive.textContent = `Nearby frames centered on ${center}, in source order`;
  if (!reduced?.matches)
    animation = elements.nearbyGrid.animate?.(
      [
        { transform: `translateX(${direction * 4}px)`, opacity: 0.85 },
        { transform: "translateX(0)", opacity: 1 },
      ],
      { duration: 200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
}
export function openNearby(): void {
  const current = state.history[state.index];
  if (
    elements.nearbyDialog.open ||
    elements.nearbyButton.disabled ||
    state.loading ||
    state.historyLoadFailed ||
    getViewState() !== "image" ||
    current?.source !== "prntsc"
  )
    return;
  const cached = blobs.get(blobKey(current.source, current.id));
  if (!cached) return;
  const anchor = nearbyWindow(current.id).centerId;
  sessionId = crypto.randomUUID();
  anchorUrl = cached.url;
  releaseAnchor = borrowBlobUrl(cached.url);
  lastNotice = "";
  selected = undefined;
  pauseUntil = 0;
  thumbnailNotice = false;
  elements.frameMenuButton.focus();
  const id = sessionId;
  let anchorRepairStarted = false;
  const resolveTile = async (
    frameId: string,
    generation: number,
    retry: boolean,
    recoverHandle = true,
  ): Promise<NearbyResolution> => {
    const cacheGeneration = thumbnailGeneration();
    if (
      frameId === anchor &&
      !(await cacheThumbnail(blobKey("prntsc", anchor), cached.blob, true, cacheGeneration, retry))
    )
      return { state: "unsaved", kind: "persistence", message: "The current check could not be saved locally" };
    const result = await resolveNearbyFrame(id, generation, frameId, retry);
    if (!session?.active || sessionId !== id || !session.tiles.some((tile) => tile.id === frameId))
      return { state: "canceled" };
    if (result.state === "retryable" && ["upstream-forbidden", "upstream-rate-limited"].includes(result.kind)) {
      pauseUntil = Math.max(pauseUntil, Date.now() + (result.retryAfterMs ?? DEFAULT_PAUSE_DURATION_MS));
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(
        () => {
          pauseTimer = undefined;
          render();
        },
        Math.min(MAX_SET_TIMEOUT_DELAY_MS, Math.max(0, pauseUntil - Date.now())),
      );
    }
    if (result.state !== "available") return result;
    const key = blobKey("prntsc", frameId);
    try {
      await shareThumbnail(key, async () => {
        if (thumbnailFor(key)) return true;
        const bytes = await getNearbyThumbnail(id, result.thumbnailHandle);
        const url = await decodedUrl(new Blob([bytes], { type: "image/jpeg" }));
        URL.revokeObjectURL(url);
        if (!session?.active || sessionId !== id || !session.tiles.some((tile) => tile.id === frameId)) return false;
        return cacheEncodedThumbnail(key, new Uint8Array(bytes), false, cacheGeneration);
      });
    } catch (error) {
      if (
        recoverHandle &&
        typeof error === "object" &&
        error !== null &&
        "kind" in error &&
        error.kind === "not-found" &&
        session?.active &&
        sessionId === id &&
        session.tiles.some((tile) => tile.id === frameId)
      )
        return resolveTile(frameId, session.generation, false, false);
      throw error;
    }
    if (!session?.active || sessionId !== id || !session.tiles.some((tile) => tile.id === frameId))
      return { state: "canceled" };
    if (!thumbnailFor(key)) {
      const err = new Error("Preview unavailable. Try again.");
      (err as { kind?: string }).kind = "invalid-response";
      throw err;
    }
    void persistThumbnails().then((ok) => {
      if (!ok && !thumbnailNotice && session?.active && sessionId === id) {
        thumbnailNotice = true;
        toast.error("Thumbnails could not be saved locally");
      }
    });
    return result;
  };
  session = new NearbySession(anchor, {
    setWindow: async (center, generation) => {
      const result = await setNearbyWindow(id, generation, center, anchor);
      if (session?.active && sessionId === id && generation === session.generation) {
        await Promise.all(
          session.tiles.map(async (tile) => {
            const key = tile.id && blobKey("prntsc", tile.id);
            const cached = key && thumbnailFor(key);
            if (tile.id && !tile.current && tile.phase === "queued" && (result.evidence[tile.id] ?? 0) & 1 && cached) {
              const probe = document.createElement("img");
              probe.src = cached;
              try {
                await probe.decode();
                if (session?.active && sessionId === id && generation === session.generation) tile.phase = "ready";
              } catch {
                if (key) discardThumbnail(key, cached);
              } finally {
                probe.removeAttribute("src");
              }
            }
          }),
        );
      }
      if (
        session?.active &&
        sessionId === id &&
        session.generation === generation &&
        !((result.evidence[anchor] ?? 0) & 1) &&
        !anchorRepairStarted
      ) {
        anchorRepairStarted = true;
        void resolveTile(anchor, generation, false)
          .then((result) => {
            if (!session?.active || sessionId !== id) return;
            const tile = session.tiles.find((tile) => tile.current);
            if (!tile || result.state === "canceled") return;
            if (result.state === "unsaved" || result.state === "retryable") {
              tile.phase = result.state;
              tile.message = result.message;
              if (result.state === "retryable" && "kind" in result) {
                tile.kind = result.kind;
              }
              render();
            }
          })
          .catch((error) => {
            if (!session?.active || sessionId !== id) return;
            const tile = session.tiles.find((tile) => tile.current);
            if (tile) {
              tile.phase = "unsaved";
              tile.message = error instanceof Error ? error.message : "The current check could not be saved";
              render();
            }
          });
      }
      return result;
    },
    resolve: resolveTile,
    changed: render,
  });
  render();
  openDialog(elements.nearbyDialog);
  elements.nearbyClose.focus();
  nodes.get(anchor)?.li.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  void session.move(anchor);
}
export function bindNearbyEvents(): void {
  if (bound) return;
  bound = true;
  elements.nearbyButton.addEventListener("click", openNearby);
  elements.nearbyClose.addEventListener("click", () => closeDialog(elements.nearbyDialog));
  elements.nearbyPrevious.addEventListener("click", () => void move(-1));
  elements.nearbyNext.addEventListener("click", () => void move(1));
  elements.nearbyRetry.addEventListener("click", () => {
    if (Date.now() >= pauseUntil) session?.retry();
  });
  elements.nearbyDialog.addEventListener("dialog-dismiss", () => stop(selected));
  elements.nearbyDialog.addEventListener("close", () => {
    stop(selected);
    const target = selected;
    selected = undefined;
    nodes.clear();
    elements.nearbyGrid.replaceChildren();
    session = undefined;
    anchorUrl = "";
    releaseAnchor?.();
    releaseAnchor = undefined;
    onDialogClosed();
    elements.frameMenuButton.focus();
    if (target) void openNearbyFrame(target);
  });
  elements.nearbyGrid.addEventListener("keydown", (event) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key) || !session?.active) return;
    event.preventDefault();
    event.stopPropagation();
    const actionable = session.tiles.filter((tile) => isActionablePhase(tile.phase));
    const current = actionable.find((tile) => nodes.get(tile.id ?? "")?.control === document.activeElement);
    let target: TileState | undefined;
    if (event.key === "Home") target = actionable[0];
    else if (event.key === "End") target = actionable.at(-1);
    else if (current) {
      const deltas: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -3,
        ArrowDown: 3,
      };
      const delta = deltas[event.key] ?? 0;
      for (let index = current.index + delta; index >= 0 && index < 9; index += delta) {
        if (Math.abs(delta) === 1 && Math.floor(index / 3) !== Math.floor(current.index / 3)) break;
        target = actionable.find((tile) => tile.index === index);
        if (target) break;
      }
    }
    if (target) nodes.get(target.id ?? "")?.control.focus();
  });
  reduced?.addEventListener("change", settleMotion);
  window.addEventListener("resize", settleMotion);
  document.addEventListener("visibilitychange", () => {
    if (!session?.active) return;
    settleMotion();
    if (document.hidden) {
      session.paused = true;
      void closeNearby(sessionId);
    } else {
      session.paused = false;
      void session.move(session.window.centerId);
    }
    render();
  });
  document.addEventListener("persisted-view-refreshed", () => {
    if (session?.active && !document.hidden) void session.move(session.window.centerId);
  });
}
