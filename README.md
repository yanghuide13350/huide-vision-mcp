# Huide Vision MCP

一个部署在 Cloudflare Workers 上的远程 MCP：让纯文本开发 Agent 通过 **SenseNova 6.7 Flash-Lite** 理解网页截图、报错截图和带标记截图。

它只暴露一个工具：`analyze_development_image`。

## 能做什么

- 网页截图：识别布局、遮挡、溢出、对齐与响应式异常，并给出可验证的 CSS / DOM 排查方向。
- 报错截图：提取可见错误、堆栈、路径、行号、状态码，再给出诊断。
- 标记截图：理解红框、箭头、圆圈与编号对应的目标和问题。
- 完整盘点：当问题包含“全部、逐一、清单、从上到下/从左到右”等要求时，本地适配器会将长图或密集图分成最多 6 张有重叠的切片，作为一次多图视觉请求按原始顺序盘点，避免遗漏和重复猜测。

工具只接受原图的 base64 Data URL（例如 `data:image/png;base64,...`）。不接受远程 URL，避免服务端替用户请求任意地址。

## 本地启动

```bash
npm install
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中填入真实的两个 secret
npm run cf-typegen
npm run dev
```

本地端点：`http://localhost:8787/mcp`。所有 MCP 请求需带：

```http
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

## 部署到 Cloudflare

首次部署前，在项目目录交互式写入密钥；不要把密钥放进 `wrangler.jsonc`：

```bash
npx wrangler secret put SENSENOVA_API_KEY
npx wrangler secret put MCP_ACCESS_TOKEN
npm run deploy
```

随后在 Cloudflare Dashboard 为 Worker 配置自定义域名 `vision.huidecode.com`，MCP 地址为：

```text
https://vision.huidecode.com/mcp
```

健康检查：`https://vision.huidecode.com/health`。

## 客户端注意事项

这是标准远程 Streamable HTTP MCP。客户端必须既支持远程 MCP，又支持把图片附件作为工具参数传入。若某个客户端在模型调用前就拒绝图片附件，MCP 无法拦截该附件；这是客户端能力边界。

客户端在调用工具时应传入原图，而不是文本描述：

```json
{
  "image_data": "data:image/png;base64,...",
  "question": "红框中的按钮为什么会溢出容器？",
  "analysis_mode": "annotation_analysis"
}
```

## 验证

```bash
npm run check
npm test
```
