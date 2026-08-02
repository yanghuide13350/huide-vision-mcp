import { describe, expect, it, vi } from "vitest";
import { analyzeWithSenseNova, validateImageData } from "../src/vision";
import { userPrompt } from "../src/prompt";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0SgAAAABJRU5ErkJggg==";

describe("validateImageData", () => {
  it("accepts supported image data URLs", () => {
    expect(() => validateImageData(ONE_PIXEL_PNG, 1024)).not.toThrow();
  });

  it("rejects remote URLs and unsupported media", () => {
    expect(() => validateImageData("https://example.com/image.png", 1024)).toThrow("base64 data URL");
    expect(() => validateImageData("data:image/svg+xml;base64,PHN2Zy8+", 1024)).toThrow("base64 data URL");
  });
});

it("sends ordered multi-image content for complete inventories", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content: '{"coverage":"complete","items":[]}' } }] }), { status: 200 }),
  );
  await analyzeWithSenseNova(
    { imageData: [ONE_PIXEL_PNG, ONE_PIXEL_PNG], question: "List all visible items", mode: "complete_inventory" },
    { apiKey: "test-key", baseUrl: "https://token.sensenova.cn/v1", model: "sensenova-6.7-flash-lite" },
    fetchMock,
  );
  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(body.max_completion_tokens).toBe(4096);
  expect(body.messages[1].content.filter((item: { type: string }) => item.type === "image_url")).toHaveLength(2);
});

describe("analyzeWithSenseNova", () => {
  it("sends an OpenAI-compatible image chat completion and parses JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"ok"}' } }] }), { status: 200 }),
    );

    await expect(
      analyzeWithSenseNova(
        { imageData: ONE_PIXEL_PNG, question: "What is wrong?", mode: "web_debug" },
        { apiKey: "test-key", baseUrl: "https://token.sensenova.cn/v1", model: "sensenova-6.7-flash-lite" },
        fetchMock,
      ),
    ).resolves.toEqual({ summary: "ok" });

    const [, init] = fetchMock.mock.calls[0];
    expect(fetchMock.mock.calls[0][0]).toBe("https://token.sensenova.cn/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(String(init?.body));
    expect(body.messages[1].content[1].image_url.url).toBe(ONE_PIXEL_PNG);
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body).not.toHaveProperty("response_format");
  });

  it("recovers JSON wrapped in a markdown code fence", async () => {
    const fenced = "```json\n{\"summary\":\"fenced\"}\n```";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: fenced }, finish_reason: "stop" }] }), { status: 200 }),
    );
    await expect(
      analyzeWithSenseNova(
        { imageData: ONE_PIXEL_PNG, question: "?", mode: "auto" },
        { apiKey: "k", baseUrl: "https://token.sensenova.cn/v1", model: "m" },
        fetchMock,
      ),
    ).resolves.toEqual({ summary: "fenced" });
  });

  it("parses the stable plain-text protocol for ordinary screenshot analysis", async () => {
    const protocol = "ANSWER: 红框内是导入反馈结果按钮。\nEVIDENCE:\n- 红框包含按钮文字「导入反馈结果」\nUNKNOWNS:\n- 无法确认点击后的业务效果";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: protocol }, finish_reason: "stop" }] }), { status: 200 }),
    );
    await expect(
      analyzeWithSenseNova(
        { imageData: ONE_PIXEL_PNG, question: "红框是什么？", mode: "annotation_analysis" },
        { apiKey: "k", baseUrl: "https://token.sensenova.cn/v1", model: "m" },
        fetchMock,
      ),
    ).resolves.toEqual({
      answer: "红框内是导入反馈结果按钮。",
      evidence: ["红框包含按钮文字「导入反馈结果」"],
      unknowns: ["无法确认点击后的业务效果"],
    });
  });

  it("recovers analysis when the model leaves double quotes unescaped in values", async () => {
    // Reproduces the annotation_analysis failure: the model wrote UI labels with
    // raw ASCII quotes, producing invalid JSON that previously fell to raw_analysis.
    const loose =
      '{"answer":"红框标注的是"导入反馈结果"按钮，表达导入反馈的诉求。","evidence":["红框内按钮文字为"导入反馈结果""],"unknowns":[]}';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: loose }, finish_reason: "stop" }] }), { status: 200 }),
    );
    const result = (await analyzeWithSenseNova(
      { imageData: ONE_PIXEL_PNG, question: "红框表达什么？", mode: "annotation_analysis" },
      { apiKey: "k", baseUrl: "https://token.sensenova.cn/v1", model: "m" },
      fetchMock,
    )) as { answer: string; evidence: string[]; _format_error?: boolean };
    expect(result._format_error).toBeUndefined();
    expect(result.answer).toContain("红框标注的是");
    expect(result.answer).toContain("导入反馈结果");
    expect(result.evidence[0]).toContain("导入反馈结果");
  });

  it("throws a clear error when the response is cut off by the token limit", async () => {
    const cutOff = '{"summary":"partial","observations":[{"detail":"cut';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: cutOff }, finish_reason: "length" }] }), { status: 200 }),
    );
    await expect(
      analyzeWithSenseNova(
        { imageData: ONE_PIXEL_PNG, question: "?", mode: "auto" },
        { apiKey: "k", baseUrl: "https://token.sensenova.cn/v1", model: "m" },
        fetchMock,
      ),
    ).rejects.toThrow("cut off");
  });

  it("returns a stable structured format instead of raw_analysis for unrecoverable output", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "not JSON at all" }, finish_reason: "stop" }] }), { status: 200 }),
    );
    await expect(
      analyzeWithSenseNova(
        { imageData: ONE_PIXEL_PNG, question: "?", mode: "auto" },
        { apiKey: "k", baseUrl: "https://token.sensenova.cn/v1", model: "m" },
        fetchMock,
      ),
    ).resolves.toEqual({
      answer: "视觉模型返回的结构化内容无法读取。",
      evidence: [],
      unknowns: ["模型返回内容无法解析为要求的结构。"],
      _format_error: true,
    });
  });
});

it("makes annotation focus and concise direct answers explicit in the prompt", () => {
  const prompt = userPrompt("红框里的两条记录是什么意思？", "auto");
  expect(prompt).toContain("ANSWER/EVIDENCE/UNKNOWNS protocol");
  expect(prompt).toContain("Question: 红框里的两条记录是什么意思？");
});

it("keeps a complete answer when only the trailing JSON fields are cut off", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"红框标出两条合并记录","evidence":[' }, finish_reason: "length" }] }), { status: 200 }),
  );
  await expect(
    analyzeWithSenseNova(
      { imageData: ONE_PIXEL_PNG, question: "这是什么意思？", mode: "auto" },
      { apiKey: "k", baseUrl: "https://token.sensenova.cn/v1", model: "m" },
      fetchMock,
    ),
  ).resolves.toMatchObject({ answer: "红框标出两条合并记录", _truncated: true });
});
