import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { splitImageForInventory } from "../src/image-tiler";

describe("splitImageForInventory", () => {
  it("splits a long small-width image into four ordered slices without upscaling it", async () => {
    const input = await sharp({ create: { width: 120, height: 1_920, channels: 3, background: "#f90" } }).png().toBuffer();
    const tiles = await splitImageForInventory(input);
    expect(tiles).toHaveLength(4);
    expect(tiles.map(tile => tile.index)).toEqual([1, 2, 3, 4]);
    expect(tiles.every(tile => tile.dataUrl.startsWith("data:image/png;base64,"))).toBe(true);
  });

  it.each([
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
    ["gif", "image/gif"],
  ] as const)("keeps the original %s MIME type when no slicing is needed", async (format, expectedMimeType) => {
    const input = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#f90" } })
      .toFormat(format)
      .toBuffer();

    const [tile] = await splitImageForInventory(input);

    expect(tile.dataUrl.startsWith(`data:${expectedMimeType};base64,`)).toBe(true);
  });
});
