import { SYSTEM_PROMPT, userPrompt } from "./prompt";

export type AnalysisMode =
  | "auto"
  | "web_debug"
  | "error_debug"
  | "annotation_analysis"
  | "complete_inventory";

export interface VisionRequest {
  imageData: string | string[];
  question: string;
  mode: AnalysisMode;
}

export interface VisionConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;
// This leaves enough room for detailed screenshots while completing within the
// local MCP client's request timeout. The compact prompt keeps ordinary
// answers short; this is a ceiling, not a requested response length.
const MAX_COMPLETION_TOKENS = 4_096;

export function validateImageData(imageData: string, maxBytes: number): void {
  const match = DATA_URL.exec(imageData);
  if (!match) {
    throw new Error("image_data must be a base64 data URL using PNG, JPEG, WebP, or GIF.");
  }

  const base64Length = match[2].replace(/\s/g, "").length;
  const estimatedBytes = Math.floor((base64Length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    throw new Error(`Image is too large. Limit is ${maxBytes} bytes.`);
  }
}

export function validateImageInputs(imageData: string | string[], maxBytes: number): void {
  const images = Array.isArray(imageData) ? imageData : [imageData];
  if (!images.length || images.length > 6) throw new Error("Provide between 1 and 6 images.");
  images.forEach(image => validateImageData(image, maxBytes));
}

export async function analyzeWithSenseNova(
  request: VisionRequest,
  config: VisionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const images = Array.isArray(request.imageData) ? request.imageData : [request.imageData];
  const maxCompletionTokens = MAX_COMPLETION_TOKENS;
  const imageContent = images.flatMap((image, index) => [
    ...(images.length > 1 ? [{ type: "text", text: `Attached slice ${index + 1}/${images.length}.` }] : []),
    { type: "image_url", image_url: { url: image } },
  ]);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_completion_tokens: maxCompletionTokens,
      // SenseNova calls its automatic reasoning mode "adaptive". It uses
      // deeper visual reasoning only when the image actually needs it.
      thinking: { type: "adaptive" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt(request.question, request.mode) },
            ...imageContent,
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(110_000),
  });

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(`SenseNova request failed (${response.status}): ${body.error?.message ?? "unknown error"}`);
  }

  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    throw new Error("SenseNova returned no analysis content.");
  }

  const truncated = choice?.finish_reason === "length";
  // A length-limited response is genuinely incomplete. Never repair it by
  // inventing closing quotes/brackets: that can turn a half answer into a
  // convincing but unsafe result.
  const parsed = parseModelResponse(content, request.mode, !truncated);
  if (parsed) {
    return truncated ? { ...parsed, _truncated: true } : parsed;
  }
  // The compact prompt places answer first. If only the tail was cut off,
  // preserve that complete answer instead of making the host retry the same
  // image repeatedly. Never manufacture an answer from an incomplete field.
  if (truncated) {
    const answer = extractCompleteAnswer(content) ?? extractLabeledAnswer(content);
    if (answer) {
      return {
        answer,
        unknowns: ["The model response was cut off after this answer; unreturned details are unknown."],
        _truncated: true,
      };
    }
    throw new Error(
      "Analysis was cut off before completing (token limit). Retry with a narrower question or complete_inventory mode.",
    );
  }
  const answer = extractCompleteAnswer(content) ?? extractLabeledAnswer(content);
  return {
    answer: answer ?? "视觉模型返回的结构化内容无法读取。",
    evidence: [],
    unknowns: ["模型返回内容无法解析为要求的结构。"],
    _format_error: true,
  };
}

function parseModelResponse(content: string, mode: AnalysisMode, allowRepair: boolean): Record<string, unknown> | null {
  if (mode !== "complete_inventory") {
    const labeled = parseLabeledAnalysis(content);
    if (labeled) return labeled;
  }
  // Keep JSON parsing only as a backwards-compatible fallback for ordinary
  // requests and as the primary format for complete inventories.
  return parseModelJson(content, allowRepair);
}

function parseLabeledAnalysis(content: string): Record<string, unknown> | null {
  const normalized = content.replace(/```[a-z]*\s*/gi, "").replace(/```/g, "").trim();
  const sectionPattern = /^(ANSWER|EVIDENCE|UNKNOWNS)\s*[:：]\s*/gim;
  const matches = [...normalized.matchAll(sectionPattern)];
  if (!matches.length) return null;

  const sections = new Map<string, string>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    sections.set(match[1].toUpperCase(), normalized.slice(start, end).trim());
  }

  const answer = sections.get("ANSWER")?.replace(/\s+/g, " ").trim();
  if (!answer) return null;
  return {
    answer,
    evidence: parseProtocolList(sections.get("EVIDENCE")),
    unknowns: parseProtocolList(sections.get("UNKNOWNS")),
  };
}

function parseProtocolList(section: string | undefined): string[] {
  if (!section) return [];
  return section
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(line => line.length > 0 && !/^(none|无|未知项?无)$/i.test(line))
    .slice(0, 2);
}

/**
 * SenseNova returns plain text for this compatible endpoint and can wrap JSON
 * in a ```json code fence or add prose around it. Strip fences and extract the
 * outermost {...} so valid analysis is never dropped to a format error. When the
 * model leaves double quotes unescaped inside a value (common with Chinese UI
 * labels like "导入反馈结果"), a repair pass re-escapes them so the analysis is
 * still recovered instead of returned as a raw string.
 */
function parseModelJson(content: string, allowRepair = true): Record<string, unknown> | null {
  const bases: string[] = [];
  const trimmed = content.trim();
  bases.push(trimmed);

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) bases.push(fence[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) bases.push(trimmed.slice(first, last + 1));

  const candidates: string[] = [];
  for (const base of bases) {
    candidates.push(base);
    const repaired = allowRepair ? repairLooseJson(base) : base;
    if (repaired !== base) candidates.push(repaired);
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Best-effort repair for JSON where the model used raw double quotes inside
 * string values. Walks the text tracking string state: a quote is treated as a
 * structural close only when the next non-space character continues the JSON
 * grammar (, } ] : or end); otherwise it is escaped as content. It never adds
 * closing quotes or brackets: those are evidence of a truncated response, not
 * a recoverable formatting issue. Valid JSON passes through unchanged because
 * its structural quotes always sit before a grammar character.
 */
function repairLooseJson(input: string): string {
  let out = "";
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (ch === "\\") {
        out += ch;
        if (i + 1 < input.length) {
          out += input[i + 1];
          i++;
        }
        continue;
      }
      if (ch === '"') {
        const next = nextNonSpace(input, i + 1);
        if (next === "" || next === "," || next === "}" || next === "]" || next === ":") {
          out += ch;
          inString = false;
        } else {
          out += '\\"';
        }
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
    }
    out += ch;
  }

  return inString ? input : out;
}

function nextNonSpace(text: string, from: number): string {
  for (let i = from; i < text.length; i++) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return "";
}

function extractCompleteAnswer(content: string): string | null {
  const match = content.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return null;
  try {
    const answer = JSON.parse(`"${match[1]}"`);
    return typeof answer === "string" && answer.trim() ? answer : null;
  } catch {
    return null;
  }
}

function extractLabeledAnswer(content: string): string | null {
  const match = content.match(/^ANSWER\s*[:：]\s*(.+)$/im);
  return match?.[1].trim() || null;
}
