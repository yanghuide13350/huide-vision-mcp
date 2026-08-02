import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { analyzePiAttachments, piImageToDataUrl } from "../pi/vision-bridge-core";

const BASE64_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0SgAAAABJRU5ErkJggg==";
const REMOTE_URL = "http://127.0.0.1:8787/mcp";
const ACCESS_TOKEN = "pi-integration-token";
const PROVIDER_URL = "https://token.sensenova.cn/v1/chat/completions";

function createFetchThroughWorker() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === REMOTE_URL) {
      return worker.fetch(new Request(url, init), {
        MCP_ACCESS_TOKEN: ACCESS_TOKEN,
        SENSENOVA_API_KEY: "provider-test-key",
        SENSENOVA_BASE_URL: "https://token.sensenova.cn/v1",
        SENSENOVA_MODEL: "sensenova-6.7-flash-lite",
        MAX_IMAGE_BYTES: "10485760",
      } as Env);
    }
    if (url === PROVIDER_URL) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ANSWER: Pi 截图已分析。\nEVIDENCE:\n- 测试图像已转发\nUNKNOWNS:\n- 无" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch request: ${url}`);
  });
}

describe("Pi vision bridge", () => {
  it("converts Pi base64 attachments into the Worker data-URL contract", () => {
    expect(piImageToDataUrl({ source: { type: "base64", mediaType: "image/png", data: BASE64_PNG } })).toBe(`data:image/png;base64,${BASE64_PNG}`);
    expect(piImageToDataUrl({ data: BASE64_PNG, mimeType: "image/png" })).toBe(`data:image/png;base64,${BASE64_PNG}`);
  });

  it("forwards Pi attachments through the authenticated Worker without calling a real provider", async () => {
    vi.stubGlobal("fetch", createFetchThroughWorker());

    await expect(
      analyzePiAttachments(
        { remoteUrl: REMOTE_URL, accessToken: ACCESS_TOKEN },
        [{ source: { type: "base64", mediaType: "image/png", data: BASE64_PNG } }],
        "这个截图有什么问题？",
      ),
    ).resolves.toContain("Pi 截图已分析。");
  });

  it("preserves the Worker 401 as a hard failure", async () => {
    vi.stubGlobal("fetch", createFetchThroughWorker());

    await expect(
      analyzePiAttachments(
        { remoteUrl: REMOTE_URL, accessToken: "wrong-token" },
        [{ source: { type: "base64", mediaType: "image/png", data: BASE64_PNG } }],
        "这个截图有什么问题？",
      ),
    ).rejects.toThrow("Huide Vision service failed (401): Unauthorized");
  });
});
