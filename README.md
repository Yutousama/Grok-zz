# Grok API 代理

使用 Deno 免费代理 xAI Grok，国内直连，不限地区/网络环境，开箱即用。

免费使用 Grok 强大的大语言模型，支持长上下文对话。

兼容的 OpenAI 格式，可对接 AI 编程，接入ChatBox、Cherry Studio、Cursor、Cline 等 AI 客户端。

## Deno 部署
视频教程：[Deno部署视频教程](https://b23.tv/gR7GjP8)

1. 免费创建一个 Grok API Key [https://api.x.ai](https://api.x.ai)
1. 点击 [Fork](https://github.com/Lihu-PR/Grok-zz/fork) 本项目
2. 登录/注册 Deno https://dash.deno.com/
3. 点击创建项目 https://dash.deno.com/new_project
4. 选择此项目，填写项目名字（分配域名）
5. 部署 Entrypoint 填写 `src/deno_index.ts` 其他字段留空 
6. 点击 **Deploy Project**
7. 部署成功后获得域名，可以作为Chat API的代理使用。

## 实现原理

项目通过建立反向代理服务，将请求转发至 xAI Grok API 实现。主要原理如下：

1. **请求拦截与转发**：使用 Deno 创建高效的代理服务器，拦截客户端的请求并转发到 Grok API。
2. **API格式转换**：将 OpenAI 格式的请求自动转换为 Grok API 兼容格式，确保无缝对接。
3. **WebSocket 支持**：实现了 WebSocket 协议转发，支持流式响应，保证实时交互体验。
4. **错误处理机制**：优化的错误处理流程，确保请求失败时能够返回清晰的错误信息。

## 接入 new-api / OpenAI 兼容客户端

- Base URL 填代理域名即可，带不带 `/v1` 都能用：
  - `https://your-project.deno.net`
  - `https://your-project.deno.net/v1`
  - 支持 `/v1/models`、`/v1/chat/completions`、`/v1/images/generations`、`/v1/images/edits`，以及带末尾斜杠的写法
- API Key 填你在 [api.x.ai](https://api.x.ai) 生成的 `xai-...` Key（代理不做任何存储）。
- 模型名会原样透传给上游（只去掉 `models/` 前缀），不再静默替换成默认模型；名字写错时直接看到上游的 400 报错，便于排查。
- `/v1/models` 兼容上游的多种返回结构（`data` / `models` / 直接数组，`id` / `name` 字段都行）；上游返回空列表时兜底返回一组内置模型名，避免 new-api 里模型列表为空。

## 图像生成 / 图像编辑

代理转发 xAI 的两个图像端点，路径与 OpenAI 一致：

| 端点 | 说明 | xAI 上游要求 |
| --- | --- | --- |
| `POST /v1/images/generations` | 文本生图 | `application/json` |
| `POST /v1/images/edits` | 图生图 / 图片编辑 | **只接受 `application/json`**（multipart 会返回 415） |

- 常用模型：`grok-imagine-image` / `grok-imagine-image-2.0`（Imagine 系列，生图与编辑都走它，支持 `resolution: "1k"|"2k"`）。注意部分账户的模型列表里已经没有 `grok-2-image-1212`，具体以 `/v1/models` 与 xAI 控制台为准。
- **edits 的格式差异已由代理处理**：OpenAI SDK / new-api 默认发 `multipart/form-data`，代理会转成 xAI 的 JSON（单图 `image: { url, type: "image_url" }`，多图 `images: [...]`（最多 3 张），`mask: { url }`，图片本体转成 `data:image/...;base64,...`）。直接发 JSON 时原样透传。
- xAI 不支持 OpenAI 的 `size` / `quality` / `style`，这些字段会被丢弃（日志里会提示）；尺寸用 `aspect_ratio`，清晰度用 `resolution: "1k" | "2k"`。
- 响应统一是 `{ created, data: [{ url | b64_json }] }`，与 OpenAI 一致；需要 base64 时传 `response_format: "b64_json"`（实测一张约 15 万字符的 base64，正常返回）。
- 响应里还有 xAI 特有的 `usage.cost_in_usd_ticks` 与 `data[].mime_type`，代理原样保留，方便算成本。

## 实测记录（走 Deno 代理）

用真实 Key 通过 Deno 代理验证过（2026-11）：

| 请求 | 结果 |
| --- | --- |
| `GET /v1/models` | 200，返回 xAI 当前模型列表（`grok-4.7` / `grok-4.6` / `grok-4.5` / `grok-4.20-*` / `grok-build-0.1` / `grok-imagine-image*` / `grok-imagine-video*`） |
| `POST /v1/chat/completions`（`grok-4.7`，非流式） | 200，`choices[0].message.content` 正常 |
| `POST /v1/chat/completions`（`stream: true`） | 200，SSE 正常，`[DONE]` 只出现一次 |
| `POST /v1/images/generations`（`grok-imagine-image-2.0`，`url` / `b64_json`） | 200，返回 `data[0].url` / `data[0].b64_json` + `usage.cost_in_usd_ticks` |
| `POST /v1/images/edits`（multipart 单图 + prompt，代理转 JSON） | 200，返回编辑后的图片 |

### 可选环境变量

在 Deno Deploy 控制台 → 项目 → Settings → Environment Variables 中配置，不配置则使用默认值：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `XAI_BASE_URL` | `https://api.x.ai` | 上游地址，可换成其它 xAI 兼容网关 |
| `XAI_API_VERSION` | `v1` | 上游 API 版本段 |

> 本地用 `deno run` 运行时需要加 `--allow-env` 才能读到这两个变量，读不到会自动使用默认值。

## 本地自测

```bash
node tests/smoke.mjs     # 桩掉 fetch，验证上游各种返回格式/错误都不会让代理崩溃
node tests/routing.mjs   # 用 Deno 桩加载 deno_index.ts，验证各路径路由
node tests/images.mjs    # 图像接口：generations 透传、multipart → xAI JSON、415 透传
# 或：npm test
```

用桩函数模拟上游各种返回（标准结构、缺失 `data`、Gemini 结构、401/400、流式帧），验证代理不会因上游格式变化而崩溃。

## 项目优点

1. **全球无障碍访问**：突破地域限制，在任何网络环境下都能稳定访问 Grok API。
2. **OpenAI API 兼容**：完全兼容 OpenAI 格式的 API 调用，可以无缝替换或集成到现有基于 OpenAI 的应用中。
3. **零配置部署**：通过 Deno Deploy 一键部署，无需复杂的服务器配置和维护。
4. **免费使用**：基于 Deno 的免费托管服务，无需支付额外的服务器费用。
5. **高性能**：采用轻量级设计，响应速度快，资源占用少。
6. **安全性**：请求直接转发，不存储用户敏感信息，保护用户隐私。

## 鸣谢（该项目在trueai-org的gemini项目基础上修改，支持了流式输出和Grok的API代理）

- https://github.com/tech-shrimp/gemini-playground
- https://github.com/PublicAffairs/openai-gemini
- https://github.com/trueai-org/gemini
