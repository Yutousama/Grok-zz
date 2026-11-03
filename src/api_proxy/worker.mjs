import { Buffer } from "node:buffer";

export default {
  async fetch (request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = (err) => {
      console.error(err);
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };
    try {
      const auth = request.headers.get("Authorization");
      const apiKey = auth?.split(" ")[1];
      const assert = (success) => {
        if (!success) {
          throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
        }
      };
      const { pathname: rawPathname } = new URL(request.url);
      // 去掉末尾斜杠，保证 /models、/v1/models、/v1/models/ 都能命中
      const pathname = rawPathname.replace(/\/+$/, "") || "/";
      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          return handleCompletions(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          return handleEmbeddings(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          return handleModels(apiKey)
            .catch(errHandler);
        default:
          throw new HttpError("404 Not Found", 404);
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
};

// 我们把上游响应体重新组装过（JSON 重新序列化 / 解压后的流），
// 上游的 content-length、content-encoding 已经不再匹配，
// 继续透传会让客户端按错误长度读取（截断或报错），因此统一裁掉。
const upstreamHeaders = (response) => {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return { headers, status: response.status, statusText: response.statusText };
};

const jsonResponse = (payload, response) => {
  const result = upstreamHeaders(response);
  result.headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(payload, fixCors(result));
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

// 允许通过环境变量覆盖上游地址（Deno Deploy 控制台 → Settings → Environment Variables）
// 未授予 --allow-env 或运行在 Cloudflare Workers 等无 Deno 的环境时，自动回退到默认值
const readEnv = (key, fallback) => {
  try {
    if (typeof Deno !== "undefined" && Deno.env?.get) {
      return Deno.env.get(key) ?? fallback;
    }
  } catch (_) { /* 忽略权限错误，使用默认值 */ }
  return fallback;
};

const BASE_URL = readEnv("XAI_BASE_URL", "https://api.x.ai").replace(/\/+$/, "");
const API_VERSION = readEnv("XAI_API_VERSION", "v1").replace(/^\/+|\/+$/g, "");

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "grok-proxy/0.1.0"; // 修改为我们自己的标识
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "Authorization": `Bearer ${apiKey}` }),
  ...more
});

// 上游 200 但返回的列表为空/无法识别时的兜底，避免 new-api 侧模型列表彻底为空
// （注意：这只是展示用，实际能用的模型以上游为准）
const FALLBACK_MODELS = [
  "grok-4",
  "grok-4-fast",
  "grok-3",
  "grok-3-mini",
  "grok-2-1212",
  "grok-beta",
];

// 兼容不同上游的字段名：OpenAI/xAI 用 id，Gemini 风格用 name（形如 models/grok-4）
const pickModelId = (item) => {
  if (typeof item === "string") { return item; }
  const raw = item?.id ?? item?.name ?? item?.model ?? "";
  return String(raw);
};

async function handleModels (apiKey) {
  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });

  // 只读一次 body：Response 的 body 是一次性流，重复调用 text() 会抛 "Body already consumed"
  const text = await response.text();

  if (!response.ok) {
    // 上游报错（401/403/429…）时原样回传，让 new-api 日志里能看到真实原因
    console.error("Upstream /models error:", response.status, text.slice(0, 500));
    return new Response(text, fixCors(upstreamHeaders(response)));
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    console.error("Failed to parse upstream /models response:", text.slice(0, 500));
    return new Response(text, fixCors(upstreamHeaders(response)));
  }

  // 兼容三种上游结构：
  //   1. OpenAI / xAI 标准：{ object: "list", data: [ { id, created, owned_by } ] }
  //   2. 旧版/Gemini 风格：  { models: [ { name: "models/xxx" } ] }
  //   3. 直接返回数组：      [ "grok-4" ] 或 [ { id: "grok-4" } ]
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const seen = new Set();
  const data = [];
  for (const item of list) {
    const id = pickModelId(item).trim().replace(/^models\//, "");
    if (!id || seen.has(id)) { continue; }
    seen.add(id);
    data.push({
      id,
      object: "model",
      created: Number.isFinite(item?.created) ? item.created : 0,
      owned_by: item?.owned_by ?? "xai",
    });
  }

  if (data.length === 0) {
    console.warn("Upstream /models returned no usable entries, falling back to FALLBACK_MODELS");
    for (const id of FALLBACK_MODELS) {
      data.push({ id, object: "model", created: 0, owned_by: "xai" });
    }
  }

  return jsonResponse(JSON.stringify({ object: "list", data }), response);
}

// 把模型名归一化为上游可直接使用的形式：去掉 Gemini 风格的 "models/" 前缀，
// 其余名字一律透传（不再静默替换成默认模型），交给上游判断是否有效。
const normalizeModel = (raw, fallback) => {
  if (typeof raw !== "string" || raw.trim() === "") { return fallback; }
  return raw.trim().replace(/^models\//, "");
};

const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-002";
async function handleEmbeddings (req, apiKey) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  if (!Array.isArray(req.input)) {
    req.input = [ req.input ];
  }
  // 注意：xAI 目前没有公开 /v1/embeddings 端点，这里保留转发逻辑仅为兼容原有代码
  const model = normalizeModel(req.model, DEFAULT_EMBEDDINGS_MODEL);

  const response = await fetch(`${BASE_URL}/${API_VERSION}/embeddings`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "model": model,
      "input": req.input,
      "dimensions": req.dimensions
    })
  });

  return new Response(await response.text(), fixCors(upstreamHeaders(response)));
}

const DEFAULT_MODEL = "grok-beta";
async function handleCompletions (req, apiKey) {
  const model = normalizeModel(req.model, DEFAULT_MODEL);

  // Grok API 使用标准的 chat/completions 端点
  let url = `${BASE_URL}/${API_VERSION}/chat/completions`;

  // 确保流式参数被正确传递
  const requestBody = { ...req, model };

  console.log("Request Body:", JSON.stringify(requestBody));

  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    // 只读一次 body：重复调用 text() 会抛 "Body already consumed"，把上游错误变成 500
    const errorText = await response.text();
    console.error("API Response Error:", response.status, errorText);
    return new Response(errorText, fixCors(upstreamHeaders(response)));
  }

  let body = response.body;
  const id = generateChatcmplId();

  if (req.stream) {
    if (!response.body) {
      throw new HttpError("Upstream returned an empty streaming body", 502);
    }
    // 处理流式响应
    console.log("处理流式响应");
    body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TransformStream({
        transform: parseStream,
        flush: parseStreamFlush,
        buffer: "",
      }))
      .pipeThrough(new TransformStream({
        transform: toOpenAiStream,
        flush: toOpenAiStreamFlush,
        streamIncludeUsage: req.stream_options?.include_usage,
        model, id, last: [],
      }))
      .pipeThrough(new TextEncoderStream());
  } else {
    // 处理非流式响应
    console.log("处理非流式响应");
    const responseText = await response.text();
    console.log("API响应内容:", responseText.substring(0, 500) + (responseText.length > 500 ? "..." : ""));
    try {
      const responseData = JSON.parse(responseText);
      body = processCompletionsResponse(responseData, model, id);
      return jsonResponse(body, response);
    } catch (err) {
      console.error("Error parsing response:", err);
      return new Response(responseText, fixCors(upstreamHeaders(response)));
    }
  }

  return new Response(body, fixCors(upstreamHeaders(response)));
}

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  stop: "stopSequences",
  n: "candidateCount", // not for streaming
  max_tokens: "maxOutputTokens",
  max_completion_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK", // non-standard
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
};
const transformConfig = (req) => {
  let cfg = {};
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch(req.response_format.type) {
      case "json_schema":
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
        // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new Error("Invalid image data: " + url);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformMsg = async ({ role, content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({ text: content });
    return { role, parts };
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new TypeError(`Unknown "content" item type: "${item.type}"`);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return { role, parts };
};

const transformMessages = async (messages) => {
  if (!messages) { return; }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    if (item.role === "system") {
      delete item.role;
      system_instruction = await transformMsg(item);
    } else {
      item.role = item.role === "assistant" ? "model" : "user";
      contents.push(await transformMsg(item));
    }
  }
  if (system_instruction && contents.length === 0) {
    contents.push({ role: "model", parts: { text: " " } });
  }
  //console.info(JSON.stringify(contents, 2));
  return { system_instruction, contents };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
});

const generateChatcmplId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return "chatcmpl-" + Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
  // :"function_call",
};
const SEP = "\n\n|>";
const transformCandidates = (key, cand) => {
  // 适配Grok API的响应格式
  if (cand.message) {
    // 如果已经是OpenAI格式，直接返回
    return {
      index: cand.index || 0,
      [key]: cand.message,
      logprobs: null,
      finish_reason: cand.finish_reason || "stop"
    };
  }
  
  // 兼容原Gemini格式
  return {
    index: cand.index || 0,
    [key]: {
      role: "assistant",
      content: cand.content?.parts?.map(p => p.text).join(SEP) || cand.content
    },
    logprobs: null,
    finish_reason: reasonsMap[cand.finishReason] || cand.finishReason || "stop",
  };
};
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data) => {
  if (!data) return null;
  // 如果已经是OpenAI格式
  if (data.prompt_tokens) {
    return data;
  }
  
  // 兼容原Gemini格式
  return {
    completion_tokens: data.candidatesTokenCount || data.completion_tokens || 0,
    prompt_tokens: data.promptTokenCount || data.prompt_tokens || 0,
    total_tokens: data.totalTokenCount || data.total_tokens || 0
  };
};

const processCompletionsResponse = (data, model, id) => {
  // 如果响应已经是OpenAI格式
  if (data.choices) {
    return JSON.stringify({
      ...data,
      id: id || data.id,
      model: model || data.model,
      object: data.object || "chat.completion"
    });
  }
  
  // 处理Gemini格式
  return JSON.stringify({
    id,
    choices: (data.candidates || []).map(transformCandidatesMessage),
    created: Math.floor(Date.now()/1000),
    model,
    object: "chat.completion",
    usage: transformUsage(data.usageMetadata || data.usage),
  });
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
async function parseStream (chunk, controller) {
  chunk = await chunk;
  if (!chunk) { return; }

  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    // 先按行切分再判断结束标记：不能因为整块里含 "[DONE]" 就丢掉同一块中的最后一个数据帧
    const line = match[1].trim();
    this.buffer = this.buffer.substring(match[0].length);
    if (!line) { continue; }
    if (line === "[DONE]") {
      controller.enqueue("data: [DONE]");
      this.buffer = "";
      return;
    }
    controller.enqueue(line);
  } while (true); // eslint-disable-line no-constant-condition
}

async function parseStreamFlush (controller) {
  // 处理流末尾没有空行结尾的残余数据，去掉可能残留的 "data: " 前缀
  const rest = (this.buffer || "").replace(/^data:\s?/, "").trim();
  this.buffer = "";
  if (!rest) { return; }
  if (rest === "[DONE]") {
    controller.enqueue("data: [DONE]");
    return;
  }
  console.error("Invalid trailing data:", rest.slice(0, 200));
  controller.enqueue(rest);
}

function transformResponseStream (data, stop, first) {
  // 如果数据已经是OpenAI流式格式
  if (data.choices && data.choices[0]?.delta) {
    const output = {
      ...data,
      id: this.id || data.id,
      model: this.model || data.model,
      object: data.object || "chat.completion.chunk",
    };
    return "data: " + JSON.stringify(output) + delimiter;
  }

  // 处理原Gemini格式
  const item = transformCandidatesDelta(data.candidates ? data.candidates[0] : data);
  if (stop) { item.delta = {}; } else { item.finish_reason = null; }
  if (first) { item.delta.content = ""; } else { delete item.delta.role; }
  
  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now()/1000),
    model: this.model,
    object: "chat.completion.chunk",
  };
  
  if (data.usageMetadata && this.streamIncludeUsage) {
    output.usage = stop ? transformUsage(data.usageMetadata) : null;
  }
  
  return "data: " + JSON.stringify(output) + delimiter;
}

const delimiter = "\n\n";

async function toOpenAiStream (chunk, controller) {
  const transform = transformResponseStream.bind(this);
  const line = await chunk;
  
  if (!line) { return; }
  
  // 特殊处理[DONE]消息（只发一次，避免和 flush 重复）
  if (line === 'data: [DONE]') {
    if (!this.done) {
      this.done = true;
      controller.enqueue("data: [DONE]" + delimiter);
    }
    return;
  }
  
  let data;
  try {
    data = JSON.parse(line);
    
    // 判断是否已经是OpenAI格式
    if (data.choices && Array.isArray(data.choices)) {
      controller.enqueue("data: " + line + delimiter);
      return;
    }
    
  } catch (err) {
    console.error("Error parsing stream data:", line);
    console.error(err);
    
    // 尝试直接传递数据
    controller.enqueue("data: " + line + delimiter);
    return;
  }
  
  try {
    // 处理Gemini格式
    const cand = data.candidates?.[0] || data;
    const index = cand.index || 0;
    
    if (!this.last[index]) {
      controller.enqueue(transform(data, false, "first"));
    }
    
    this.last[index] = data;
    
    if (cand.content) {
      controller.enqueue(transform(data));
    }
  } catch (err) {
    console.error("Error handling stream data:", err);
    // 尝试直接传递数据
    controller.enqueue("data: " + line + delimiter);
  }
}

async function toOpenAiStreamFlush (controller) {
  const transform = transformResponseStream.bind(this);
  if (this.last && this.last.length > 0) {
    for (const data of this.last) {
      if (data) {
        controller.enqueue(transform(data, "stop"));
      }
    }
  }
  // 确保发送结束标记（上游已经发过 [DONE] 时不再重复）
  if (!this.done) {
    this.done = true;
    controller.enqueue("data: [DONE]" + delimiter);
  }
}