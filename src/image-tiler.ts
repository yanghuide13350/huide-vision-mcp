import sharp from "sharp";

const MIME_BY_FORMAT: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const TARGET_TILE_LENGTH = 560;
const TILE_OVERLAP = 72;
const MAX_TILES = 6;

export interface ImageTile {
  index: number;
  total: number;
  dataUrl: string;
  coordinateHint: string;
}

export async function splitImageForInventory(input: Buffer): Promise<ImageTile[]> {
  const source = sharp(input, { animated: false }).rotate();
  const metadata = await source.metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height || !metadata.format) throw new Error("Unable to read image dimensions.");
  const mimeType = MIME_BY_FORMAT[metadata.format];
  if (!mimeType) throw new Error("Only PNG, JPEG, WebP, and GIF image files are supported.");

  // Keep the original bytes unless a long image genuinely needs slicing.
  // Upscaling small screenshots is slow, invents no detail, and can turn a
  // four-slice image into six slices before it reaches the vision model.
  const vertical = height > width * 1.5;
  const horizontal = width > height * 1.5;
  if (!vertical && !horizontal) {
    return [{ index: 1, total: 1, dataUrl: toDataUrl(input, mimeType), coordinateHint: "the entire original image" }];
  }

  const longLength = vertical ? height : width;
  const tileCount = Math.min(MAX_TILES, Math.max(2, Math.ceil(longLength / TARGET_TILE_LENGTH)));
  const tileLength = Math.ceil((longLength + TILE_OVERLAP * (tileCount - 1)) / tileCount);
  const step = tileLength - TILE_OVERLAP;
  const tiles: ImageTile[] = [];
  const processedSource = sharp(input, { animated: false });

  for (let index = 0; index < tileCount; index += 1) {
    const start = Math.min(index * step, longLength - tileLength);
    const left = vertical ? 0 : start;
    const top = vertical ? start : 0;
    const tileWidth = vertical ? width : Math.min(tileLength, width - left);
    const tileHeight = vertical ? Math.min(tileLength, height - top) : height;
    const cropped = await processedSource
      .clone()
      .extract({ left, top, width: tileWidth, height: tileHeight })
      .png()
      .toBuffer();
    tiles.push({
      index: index + 1,
      total: tileCount,
      dataUrl: toDataUrl(cropped, "image/png"),
      coordinateHint: vertical
        ? `vertical slice ${index + 1}/${tileCount}, covering original y=${top}..${top + tileHeight}`
        : `horizontal slice ${index + 1}/${tileCount}, covering original x=${left}..${left + tileWidth}`,
    });
  }
  return tiles;
}

function toDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}
