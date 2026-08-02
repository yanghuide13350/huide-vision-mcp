import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzePiAttachments, type PiAttachedImage } from "./vision-bridge-core.js";

const DEFAULT_REMOTE_URL = "http://127.0.0.1:8787/mcp";
const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "huide-vision.json");

type BridgeSettings = { configPath?: string; remoteUrl?: string };

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

async function loadBridgeSettings(): Promise<BridgeSettings> {
  try {
    return JSON.parse(await readFile(process.env.HUIDE_VISION_PI_CONFIG ?? DEFAULT_CONFIG_PATH, "utf8")) as BridgeSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function loadConfig() {
  const settings = await loadBridgeSettings();
  const configPath = process.env.HUIDE_VISION_CONFIG ?? settings.configPath;
  if (!configPath) {
    throw new Error("Huide Vision Pi bridge is not configured. Set configPath in ~/.pi/agent/huide-vision.json.");
  }
  const vars = parseDevVars(await readFile(configPath, "utf8"));
  const accessToken = process.env.HUIDE_MCP_ACCESS_TOKEN ?? vars.MCP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("MCP_ACCESS_TOKEN is missing from the Huide Vision configuration.");
  return {
    remoteUrl: process.env.HUIDE_VISION_MCP_URL ?? settings.remoteUrl ?? DEFAULT_REMOTE_URL,
    accessToken,
  };
}

/**
 * Pi passes image attachments to extensions as base64. Convert them before the
 * text-only model runs, then replace the attachment with verified vision text.
 */
export default function registerHuideVisionBridge(pi: any) {
  pi.on("input", async (event: { text: string; images?: PiAttachedImage[]; source?: string }, ctx: any) => {
    if (event.source === "extension" || !event.images?.length) return { action: "continue" };

    try {
      console.error(`[Huide Vision] analyzing ${event.images.length} Pi attachment(s).`);
      const analysis = await analyzePiAttachments(await loadConfig(), event.images, event.text || "Analyze this development image.");
      console.error("[Huide Vision] analysis completed.");
      return {
        action: "transform",
        text: `${event.text}\n\n[Huide Vision analysis — authoritative for the attached image]\n${analysis}`,
        // Do not pass an unsupported image to the text-only provider after it
        // has been analyzed by the Worker.
        images: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Huide Vision image analysis failed.";
      console.error(`[Huide Vision] ${message}`);
      ctx.ui?.notify?.(`Huide Vision failed: ${message}`, "error");
      // Stop the turn. Letting a text-only model continue here would invite it
      // to invent an image analysis after a failed visual request.
      return { action: "handled" };
    }
  });
}
