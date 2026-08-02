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

## 给其他人使用（生产客户端配置）

不要复制开发者电脑的绝对路径，也不要把服务端的 `.dev.vars` 或 `SENSENOVA_API_KEY` 发给客户端。每位使用者都应在**自己的电脑**创建独立的私有文件：

```bash
mkdir -p ~/.config/huide-vision-mcp
cp client.env.example ~/.config/huide-vision-mcp/client.env
# 编辑 client.env，只填服务管理员发放的 MCP_ACCESS_TOKEN
```

客户端默认读取 `~/.config/huide-vision-mcp/client.env`，默认连接生产地址 `https://vision.huidecode.com/mcp`。也可用环境变量 `HUIDE_MCP_ACCESS_TOKEN` 提供令牌，不必建立文件。

Pi 的 `~/.pi/agent/huide-vision.json` 可保持最简：

```json
{
  "remoteUrl": "https://vision.huidecode.com/mcp"
}
```

Claude Code 的本地适配器配置示例（把路径换成使用者自己的项目路径）：

```json
{
  "mcpServers": {
    "huide-vision": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/使用者用户名/huide-vision-mcp/dist/local-adapter.js"],
      "env": {
        "HUIDE_VISION_MCP_URL": "https://vision.huidecode.com/mcp"
      }
    }
  }
}
```

**当前授权限制：** Worker 现在只校验一个 `MCP_ACCESS_TOKEN`。因此它适合你本人或受信任的小范围测试；如果要给不受控的外部用户长期使用，下一步应实现“每人一个、可单独撤销”的令牌机制或 Cloudflare Access，不能把你自己的共享令牌公开出去。

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

## Pi（文本模型）自动截图分析

Pi 的图片附件是内存中的 base64 数据，而本项目原有的 `local-adapter` 只允许读取 Claude Code 的附件路径。为避免 Pi 的文本模型因看不到图片而拒绝调用或猜测图片内容，本项目提供了 Pi 专用桥接扩展：它会在 Pi 收到图片时直接调用同一个 Worker，再把分析结果作为文本交给 Pi 模型。Worker 返回 401 或任何错误时，Pi 会中止该轮，而不是让文本模型继续猜图。

安装本项目的 Pi 扩展：

```bash
pi install "/absolute/path/to/Huide Vision MCP"
```

随后在 `~/.pi/agent/huide-vision.json` 可选择覆盖默认配置路径和生产地址（不要复制 Token）：

```json
{
  "configPath": "/Users/使用者用户名/.config/huide-vision-mcp/client.env",
  "remoteUrl": "https://vision.huidecode.com/mcp"
}
```

若要测试本地 Worker，可把 `remoteUrl` 临时改为本机地址。生产环境中，在 Pi 粘贴或拖入开发截图即可；Pi 终端会输出 `[Huide Vision] analyzing ...`、成功或失败日志。

## 验证

```bash
npm run check
npm test
```
