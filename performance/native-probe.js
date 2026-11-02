// Runs before the real app module, in the disposable benchmark build only.
localStorage.setItem("random-frame-risk-accepted", "accepted");
globalThis.__rf = { spans: [], ipc: [], urls: new Map(), frames: [], phase: "startup", milestones: {} };
globalThis.__rfSpan = (name, start) => {
  if (__rf.spans.length < 150000)
    __rf.spans.push({ name, start, duration: performance.now() - start, phase: __rf.phase });
};
const create = URL.createObjectURL;
URL.createObjectURL = function (blob) {
  const url = create.call(this, blob);
  __rf.urls.set(url, blob.size);
  return url;
};
const revoke = URL.revokeObjectURL;
URL.revokeObjectURL = function (url) {
  __rf.urls.delete(url);
  return revoke.call(this, url);
};
let last;
function frame(now) {
  if (last !== undefined) __rf.frames.push({ at: now, gap: now - last, phase: __rf.phase });
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
new MutationObserver(() => {
  if (!__rf.milestones.controls && document.querySelector("#draw-button")?.getAttribute("aria-disabled") === "false")
    __rf.milestones.controls = performance.now();
  const image = document.querySelector("#image");
  if (
    !__rf.milestones.restored &&
    image?.src.startsWith("blob:") &&
    image.naturalWidth &&
    !document.querySelector("#image-zoom").hidden
  )
    __rf.milestones.restored = performance.now();
}).observe(document.documentElement, { subtree: true, attributes: true, childList: true });
document.addEventListener(
  "load",
  (event) => {
    if (!__rf.milestones.restored && event.target.id === "image" && event.target.src.startsWith("blob:"))
      __rf.milestones.restored = performance.now();
  },
  true,
);
