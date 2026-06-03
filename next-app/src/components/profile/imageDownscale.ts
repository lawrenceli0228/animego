// imageDownscale — shrink an image data URL to a max edge → small JPEG data
// URL, so an uploaded photo stays small in localStorage and decodes fast.

export function downscaleImage(src: string, maxEdge = 1280): Promise<string> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, maxEdge / Math.max(im.width, im.height));
      const w = Math.max(1, Math.round(im.width * k));
      const h = Math.max(1, Math.round(im.height * k));
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      cv.getContext("2d")?.drawImage(im, 0, 0, w, h);
      try {
        resolve(cv.toDataURL("image/jpeg", 0.88));
      } catch {
        resolve(src);
      }
    };
    im.onerror = () => resolve(src);
    im.src = src;
  });
}
