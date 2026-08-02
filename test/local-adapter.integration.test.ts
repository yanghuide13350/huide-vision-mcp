import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { callRemoteVision } from "../src/local-adapter";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0SgAAAABJRU5ErkJggg==";
const REMOTE_URL = "http://127.0.0.1:8787/mcp";
const ACCESS_TOKEN = "integration-test-token";
const providerUrl = "https://token.sensenova.cn/v1/chat/completions";

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
    if (url === providerUrl) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ANSWER: 页面正常。\nEVIDENCE:\n- 可见测试图像\nUNKNOWNS:\n- 无" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected fetch request: ${url}`);
  });
}

describe("local adapter and Worker integration", () => {
  it("forwards the bearer token through the Worker and returns the MCP analysis", async () => {
    const fetchMock = createFetchThroughWorker();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callRemoteVision(
        { remoteUrl: REMOTE_URL, accessToken: ACCESS_TOKEN },
        ONE_PIXEL_PNG,
        "这个页面正常吗？",
        "web_debug",
      ),
    ).resolves.toContain("页面正常。");

    const workerRequest = fetchMock.mock.calls.find(([input]) => String(input) === REMOTE_URL);
    expect(workerRequest?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    const providerRequest = fetchMock.mock.calls.find(([input]) => String(input) === providerUrl);
    expect(providerRequest?.[1]?.headers).toMatchObject({ Authorization: "Bearer provider-test-key" });
  });

  it("surfaces a 401 from the Worker as a hard adapter error", async () => {
    const fetchMock = createFetchThroughWorker();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callRemoteVision(
        { remoteUrl: REMOTE_URL, accessToken: "wrong-token" },
        ONE_PIXEL_PNG,
        "这个页面正常吗？",
        "web_debug",
      ),
    ).rejects.toThrow("Huide Vision service failed (401): Unauthorized");

    expect(fetchMock.mock.calls.filter(([input]) => String(input) === providerUrl)).toHaveLength(0);
  });
});
