// 本地冒烟测试：node tests/smoke.mjs
// 用桩函数替换 fetch，验证代理在“上游返回各种格式 / 各种错误”时不会崩溃。
import worker from "../src/api_proxy/worker.mjs";

let pass = 0;
const failures = [];
const check = (name, cond, extra = "") => {
  if (cond) {
    pass += 1;
    console.log("PASS", name);
  } else {
    failures.push(name);
    console.error("FAIL", name, extra);
  }
};

const stub = (handler) => { globalThis.fetch = handler; };
const call = (path, init = {}) =>
  worker.fetch(new Request(`https://proxy.example${path}`, init));
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

// 1. xAI / OpenAI 标准结构：{ object, data: [{ id }] }
stub(async () => json({
  object: "list",
  data: [{ id: "grok-4", created: 1, owned_by: "xai" }, { id: "grok-3" }],
}));
{
  const res = await call("/v1/models", { headers: { Authorization: "Bearer k" } });
  const body = await res.json();
  check("models 标准结构 status 200", res.status === 200, res.status);
  check("models 标准结构 id 正确", body.data.map((m) => m.id).join() === "grok-4,grok-3", JSON.stringify(body));
  check("models 标准结构 object=list", body.object === "list");
  check("models 返回 json content-type", /application\/json/.test(res.headers.get("content-type") || ""));
}

// 2. 原始报错场景：上游 200 但没有 data/models 字段（旧代码在这里 .map 崩溃）
stub(async () => json({ object: "list" }));
{
  const res = await call("/v1/models");
  const body = await res.json();
  check("models 缺少 data 字段不崩溃", res.status === 200, res.status);
  check("models 缺少 data 字段时走兜底列表", body.data.length > 0);
}

// 3. Gemini 风格 { models: [{ name: "models/xxx" }] }
stub(async () => json({ models: [{ name: "models/grok-beta" }] }));
{
  const res = await call("/models");
  const body = await res.json();
  check("models 兼容 models/name 结构", body.data[0]?.id === "grok-beta", JSON.stringify(body));
}

// 4. 上游 401 原样透传，不再是 500
stub(async () => new Response("invalid key", { status: 401, headers: { "content-type": "text/plain" } }));
{
  const res = await call("/v1/models");
  check("models 上游 401 透传", res.status === 401, res.status);
  check("models 上游 401 body 透传", (await res.text()) === "invalid key");
}

// 5. 路径末尾带斜杠也能命中
stub(async () => json({ data: [{ id: "grok-4" }] }));
{
  const res = await call("/v1/models/");
  check("models 末尾斜杠兼容", res.status === 200, res.status);
}

// 6. chat 非流式：上游错误只读一次 body（旧代码第二次 text() 会抛 Body already consumed → 500）
stub(async () => new Response(JSON.stringify({ error: "model not found" }), {
  status: 400,
  headers: { "content-type": "application/json", "content-length": "28" },
}));
{
  const res = await call("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ model: "grok-4", messages: [{ role: "user", content: "hi" }] }),
  });
  check("chat 上游 400 透传状态码", res.status === 400, res.status);
  check("chat 上游 400 透传内容", (await res.text()).includes("model not found"));
}

// 7. chat 非流式：模型名透传 + 已重新序列化时不受错误 content-length 影响
{
  let seenBody;
  stub(async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return json({
      id: "upstream-id",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }, 200, { "content-length": "9999" });
  });
  const res = await call("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ model: "grok-4-fast", messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await res.json();
  check("chat 非流式 status 200", res.status === 200, res.status);
  check("chat 非流式模型名透传不改写", seenBody?.model === "grok-4-fast", seenBody?.model);
  check("chat 非流式 choices 保留", body.choices?.[0]?.message?.content === "hello", JSON.stringify(body));
  check("chat 非流式 usage 保留", body.usage?.total_tokens === 3);
  check("chat 非流式不返回错误 content-length", res.headers.get("content-length") === null);
}

// 8. chat 流式：最后一个数据帧与 [DONE] 落在同一个 chunk 时不能丢帧
{
  const chunks = [
    'data: {"id":"s1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
    'data: {"id":"s1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ];
  stub(async () => new Response(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) { controller.enqueue(enc.encode(c)); }
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } }));

  const res = await call("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ model: "grok-4", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await res.text();
  check("chat 流式 status 200", res.status === 200, res.status);
  check("chat 流式保留最后一帧", text.includes('"content":"lo"'), text);
  check("chat 流式 [DONE] 只出现一次", (text.match(/\[DONE\]/g) || []).length === 1, text);
}

// 9. 未知路径仍然 404
stub(async () => json({}));
{
  const res = await call("/v1/unknown");
  check("未知路径 404", res.status === 404, res.status);
}

console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error("failed:", failures.join(", ")); }
process.exit(failures.length === 0 ? 0 : 1);
