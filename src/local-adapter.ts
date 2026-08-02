import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { splitImageForInventory } from "./image-tiler.js";

const SERVER_INFO = { name: "huide-vision-local", version: "0.1.0" };
const DEFAULT_REMOTE_URL = "https://vision.huidecode.com/mcp";
const DEFAULT_CLIENT_CONFIG_PATH = join(homedir(), ".config", "huide-vision-mcp", "client.env");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RESULT_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_RESULT_CACHE_ENTRIES = 32;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export type AdapterConfig = { remoteUrl: string; accessToken: string };
type CachedVisionResult = { expiresAt: number; result: Promise<string> };

const visionResultCache = new Map<string, CachedVisionResult>();

function isInside(path: string, root: string): boolean {
  const difference = relative(root, path);
  return difference === "" || (!difference.startsWith("..") && !difference.includes("../"));
}

function parseDevVars(content: string): Record<string, string> {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .filter(line => line.includes("=") && !line.trimStart().startsWith("#"))
      .map(line => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

async function loadConfig(): Promise<AdapterConfig> {
  const configPath = process.env.HUIDE_VISION_CONFIG ?? DEFAULT_CLIENT_CONFIG_PATH;
  let vars: Record<string, string> = {};
  try {
    vars = parseDevVars(await readFile(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !process.env.HUIDE_MCP_ACCESS_TOKEN) throw error;
  }
  const accessToken = process.env.HUIDE_MCP_ACCESS_TOKEN ?? vars.MCP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(`MCP_ACCESS_TOKEN is missing. Create ${DEFAULT_CLIENT_CONFIG_PATH} from client.env.example, or set HUIDE_MCP_ACCESS_TOKEN.`);
  }
  return {
    remoteUrl: process.env.HUIDE_VISION_MCP_URL ?? DEFAULT_REMOTE_URL,
    accessToken,
  };
}

export async function imageFileToDataUrl(imagePath: string): Promise<string> {
  const { bytes, mimeType } = await readAndValidateImage(imagePath);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function readAndValidateImage(imagePath: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const extension = extname(imagePath).toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension];
  if (!mimeType) throw new Error("Only PNG, JPEG, WebP, and GIF image files are supported.");

  const actualPath = await realpath(imagePath);
  const imageCache = await realpath(resolve(homedir(), ".claude", "image-cache"));
  if (!isInside(actualPath, imageCache)) {
    throw new Error("For safety, image_path must be a Claude attachment under ~/.claude/image-cache.");
  }

  const bytes = await readFile(actualPath);
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`Image is too large. Limit is ${MAX_IMAGE_BYTES} bytes.`);
  return { bytes, mimeType };
}

function shouldUseCompleteInventory(question: string, mode: string): boolean {
  if (mode === "complete_inventory") return true;
  if (mode !== "auto") return false;
  return /全部|完整|逐一|逐个|列表|清单|所有|从上到下|从左到右|list all|enumerate|inventory/i.test(question);
}

async function imageFileToInventoryDataUrls(imagePath: string): Promise<string[]> {
  const { bytes } = await readAndValidateImage(imagePath);
  return (await splitImageForInventory(bytes)).map(tile => tile.dataUrl);
}

export async function callRemoteVision(
  config: AdapterConfig,
  imageData: string | string[],
  question: string,
  analysisMode: string,
): Promise<string> {
  const response = await fetch(config.remoteUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "analyze_development_image",
        arguments: { image_data: imageData, question, analysis_mode: analysisMode },
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.text();
  if (!response.ok) throw new Error(`Huide Vision service failed (${response.status}): ${payload}`);

  const dataLine = payload
    .split(/\r?\n/)
    .find(line => line.startsWith("data: "));
  const message = JSON.parse(dataLine ? dataLine.slice(6) : payload) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (message.error) throw new Error(message.error.message);
  const text = message.result?.content?.find(item => item.type === "text")?.text;
  if (!text) throw new Error("Huide Vision service returned no analysis.");
  if (message.result?.isError) throw new Error(text);
  return text;
}

function visionRequestCacheKey(imageData: string | string[], question: string, analysisMode: string): string {
  const imageParts = Array.isArray(imageData) ? imageData : [imageData];
  const hash = createHash("sha256");
  hash.update(question);
  hash.update("\0");
  hash.update(analysisMode);
  for (const image of imageParts) hash.update(image);
  return hash.digest("hex");
}

function pruneVisionResultCache(now: number): void {
  for (const [key, entry] of visionResultCache) {
    if (entry.expiresAt <= now) visionResultCache.delete(key);
  }
  while (visionResultCache.size >= MAX_RESULT_CACHE_ENTRIES) {
    const oldestKey = visionResultCache.keys().next().value;
    if (!oldestKey) break;
    visionResultCache.delete(oldestKey);
  }
}

async function callRemoteVisionOnce(
  config: AdapterConfig,
  imageData: string | string[],
  question: string,
  analysisMode: string,
): Promise<string> {
  const now = Date.now();
  const key = visionRequestCacheKey(imageData, question, analysisMode);
  pruneVisionResultCache(now);
  const cached = visionResultCache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  const result = callRemoteVision(config, imageData, question, analysisMode);
  visionResultCache.set(key, { expiresAt: now + RESULT_CACHE_TTL_MS, result });
  try {
    return await result;
  } catch (error) {
    // Do not cache failed calls: a later request may succeed after a transient
    // provider failure, while concurrent duplicate calls still share this one.
    visionResultCache.delete(key);
    throw error;
  }
}

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  server.registerTool(
    "analyze_development_image",
    {
      title: "Analyze an attached development image",
      description:
        "Use once for the current user-attached webpage, error, IDE, or annotated screenshot. The result is evidence for this attachment only: do not compare it with earlier images, infer unseen facts, or retry the same image and question. Treat its answer and evidence as authoritative when replying. For an explicit complete inventory only, use analysis_mode complete_inventory; the adapter may split one long original image into ordered slices. Pass the original local attachment path (normally under ~/.claude/image-cache).",
      inputSchema: {
        image_path: z.string().min(1).describe("Original local path of the user-attached PNG, JPEG, WebP, or GIF."),
        question: z.string().min(1).max(4_000),
        analysis_mode: z.enum(["auto", "web_debug", "error_debug", "annotation_analysis", "complete_inventory"]).default("auto"),
      },
    },
    async ({ image_path, question, analysis_mode }) => {
      try {
        const completeInventory = shouldUseCompleteInventory(question, analysis_mode);
        const [config, imageData] = await Promise.all([
          loadConfig(),
          completeInventory ? imageFileToInventoryDataUrls(image_path) : imageFileToDataUrl(image_path),
        ]);
        const text = await callRemoteVisionOnce(config, imageData, question, completeInventory ? "complete_inventory" : analysis_mode);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Image analysis failed.";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  void serveStdio(buildServer, { onerror: error => console.error("Huide Vision adapter error:", error) });
  console.error("Huide Vision local adapter is running on stdio.");
}
