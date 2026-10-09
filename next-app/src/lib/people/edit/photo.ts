// An uploaded photo, made ready in the browser before it is sent.
//
// go-api takes uploads the way it takes avatars: a JPEG or PNG data URL
// inside a JSON body, under the API's 1 MiB body cap. A phone photo is often
// several MB, so it is scaled here to at most MAX_PHOTO_SIDE on its long side
// and re-encoded as a JPEG -- the browser decodes whatever it can open
// (WebP and HEIC included), which also takes care of formats go-api does not
// read. go-api still checks and re-encodes what arrives.
//
// A data URL rather than an object URL for the preview too: the site's CSP
// allows `data:` images and not `blob:` ones.

/** The long side a photo is scaled to; go-api keeps the same at most. */
export const MAX_PHOTO_SIDE = 1200;

/** Comfortably under the API's 1 MiB body cap, with room for the rest of the edit. */
export const MAX_DATA_URL_LENGTH = 900_000;

/** The size an image of w×h is drawn at: proportional, no side over max, never enlarged. */
export function fitSize(w: number, h: number, max: number = MAX_PHOTO_SIDE): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export interface PreparedPhoto {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Decode `file`, scale it down and encode it as a JPEG data URL; null when
 * the browser cannot read it or it will not fit under the cap.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto | null> {
  if (!file.type.startsWith("image/")) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    for (const side of [MAX_PHOTO_SIDE, 900, 600]) {
      const { width, height } = fitSize(bitmap.width, bitmap.height, side);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // JPEG has no transparency: a transparent PNG is laid on the page's black.
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.9, 0.82]) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.length <= MAX_DATA_URL_LENGTH) return { dataUrl, width, height };
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}
