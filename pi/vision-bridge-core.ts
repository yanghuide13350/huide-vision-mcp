import { callRemoteVision, type AdapterConfig } from "../src/local-adapter.js";

type Base64ImageSource = {
  type?: string;
  data?: string;
  mediaType?: string;
};

/** Pi has used both shapes below for image attachments across its APIs. */
export type PiAttachedImage = {
  type?: string;
  data?: string;
  mimeType?: string;
  source?: Base64ImageSource;
};

function toDataUrl(base64: string, mimeType: string): string {
  if (!/^image\/(png|jpeg|webp|gif)$/i.test(mimeType)) {
    throw new Error(`Unsupported Pi attachment type: ${mimeType || "unknown"}.`);
  }
  return base64.startsWith("data:") ? base64 : `data:${mimeType};base64,${base64}`;
}

/** Convert Pi's in-memory attachment into the Worker input contract. */
export function piImageToDataUrl(image: PiAttachedImage): string {
  if (image.source?.type === "base64" && image.source.data) {
    return toDataUrl(image.source.data, image.source.mediaType ?? "");
  }
  if (image.data) return toDataUrl(image.data, image.mimeType ?? "");
  throw new Error("Pi did not provide a readable base64 image attachment.");
}

export async function analyzePiAttachments(
  config: AdapterConfig,
  images: PiAttachedImage[],
  question: string,
): Promise<string> {
  if (images.length === 0) throw new Error("No Pi image attachment was provided.");
  if (images.length > 6) throw new Error("Pi supports up to six images per Huide Vision request.");
  const imageData = images.map(piImageToDataUrl);
  return callRemoteVision(config, imageData.length === 1 ? imageData[0] : imageData, question, "auto");
}
