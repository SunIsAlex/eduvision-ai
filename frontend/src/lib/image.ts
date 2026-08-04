/**
 * Compress an image client-side so uploads stay small and fast.
 * Draws the source onto a canvas at MAX_EDGE and exports JPEG. Small homework
 * screenshots are intentionally enlarged: vision APIs otherwise tend to lose
 * tiny mathematical subscripts during their low-resolution preprocessing.
 */
const NODE_FUNCTION_TARGET_BYTES = 3 * 1024 * 1024;

export async function compressImage(file: File, maxEdge = 2000): Promise<File> {
  const dataUrl = await readAsDataURL(file);
  const img = await loadImage(dataUrl);
  const scale = maxEdge / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, w, h);

  let quality = 0.82;
  let blob: Blob | null = null;
  do {
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    quality -= 0.1;
  } while (blob && blob.size > NODE_FUNCTION_TARGET_BYTES && quality >= 0.42);
  if (!blob) return file;
  const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg" });
}

/** Enlarge legacy/session data URLs before sending them to a vision model. */
export async function prepareImageForVision(dataUrl: string, minEdge = 1800): Promise<string> {
  const img = await loadImage(dataUrl);
  const longestEdge = Math.max(img.width, img.height);
  if (longestEdge >= minEdge) return dataUrl;

  const scale = minEdge / longestEdge;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}
