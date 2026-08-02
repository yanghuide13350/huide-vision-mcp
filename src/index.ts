import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { analyzeWithSenseNova, validateImageInputs } from "./vision";

const SERVER_INFO = { name: "huide-vision", version: "0.1.0" };
const MAX_QUESTION_LENGTH = 4_000;
type SecretEnv = {
  SENSENOVA_API_KEY: string;
  MCP_ACCESS_TOKEN: string;
};

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="Huide Vision MCP"' },
  });
}

function hasValidAccessToken(request: Request, expectedToken: string): boolean {
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(supplied && supplied === expectedToken);
}

function buildServer(env: Env & SecretEnv): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });

  server.registerTool(
    "analyze_development_image",
    {
      title: "Analyze a development screenshot",
      description:
        "Use this whenever the user provides a webpage, browser console, terminal, IDE, or annotated development screenshot that needs visual understanding. It returns balanced evidence-first analysis: visible observations, verbatim critical text, qualified inferences with confidence, unknowns, and concrete debugging checks. It must not guess hidden implementation details or specific identities without visible evidence. Input must be the original image encoded as a data URL; do not invent an image description instead.",
      inputSchema: {
        image_data: z.union([
          z.string().min(32),
          z.array(z.string().min(32)).min(1).max(6),
        ]).describe("One original image or up to six ordered image slices as data:image/...;base64,..."),
        question: z.string().min(1).max(MAX_QUESTION_LENGTH).describe("The developer's question about this image."),
        analysis_mode: z
          .enum(["auto", "web_debug", "error_debug", "annotation_analysis", "complete_inventory"])
          .default("auto")
          .describe("Use auto unless the image is clearly an error screenshot or a marked-up screenshot."),
      },
    },
    async ({ image_data, question, analysis_mode }) => {
      try {
        const maxBytes = Number(env.MAX_IMAGE_BYTES) || 10 * 1024 * 1024;
        validateImageInputs(image_data, maxBytes);
        const analysis = await analyzeWithSenseNova({ imageData: image_data, question, mode: analysis_mode }, {
          apiKey: env.SENSENOVA_API_KEY,
          baseUrl: env.SENSENOVA_BASE_URL,
          model: env.SENSENOVA_MODEL,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Image analysis failed.";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: SERVER_INFO.name, version: SERVER_INFO.version });
    }
    if (url.pathname !== "/mcp") {
      return new Response("Huide Vision MCP. Connect using /mcp.", { status: 404 });
    }
    const secretEnv = env as Env & SecretEnv;
    if (!hasValidAccessToken(request, secretEnv.MCP_ACCESS_TOKEN)) {
      return unauthorized();
    }
    return createMcpHandler(() => buildServer(secretEnv)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
