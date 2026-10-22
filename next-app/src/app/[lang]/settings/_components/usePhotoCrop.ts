"use client";

import { useCallback, useState } from "react";
import { downscaleImage } from "@/components/profile/imageDownscale";

export interface PhotoCrop {
  open: boolean;
  /** The picked image, downscaled, for the crop modal. */
  src: string | null;
  /** Read a picked file and open the crop step on it. Non-images are ignored. */
  start: (file: File | undefined) => void;
  confirm: (cropped: string) => void;
  cancel: () => void;
}

/** Picked file → downscaled data URL → PhotoCropModal → `onCropped`. */
export function usePhotoCrop(onCropped: (dataUrl: string) => void): PhotoCrop {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  const start = useCallback((file: File | undefined) => {
    if (!file || !/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => {
      void downscaleImage(String(reader.result)).then((url) => {
        setSrc(url);
        setOpen(true);
      });
    };
    reader.readAsDataURL(file);
  }, []);

  const confirm = useCallback(
    (cropped: string) => {
      setOpen(false);
      onCropped(cropped);
    },
    [onCropped],
  );

  const cancel = useCallback(() => setOpen(false), []);

  return { open, src, start, confirm, cancel };
}
