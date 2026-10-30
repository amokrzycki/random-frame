export async function assertNavigationSucceeded(targetIndex, { state, elements, getViewState, expectedUrl }) {
  const { image, imageZoom } = elements;
  await image.decode();
  if (
    state.loading ||
    state.index !== targetIndex ||
    getViewState() !== "image" ||
    imageZoom.hidden ||
    !expectedUrl?.startsWith("blob:") ||
    image.src !== expectedUrl ||
    !image.complete ||
    image.naturalWidth !== 1920 ||
    image.naturalHeight !== 1080
  )
    throw Error(`Native navigation failed for target ${targetIndex}`);
}
