// 路由冒烟测试：node tests/routing.mjs
// 用最小的 Deno 桩加载 deno_index.ts（Node 24 默认支持类型擦除），
// 验证 /v1/models、/models、带末尾斜杠、/v1/chat/completions 都能正确进入 API 代理。
let serveHandler;
globalThis.Deno = { serve: (handler) => { serveHandler = handler; } };

await import("../src/deno_index.ts");

if (typeof serveHandler !== "function") {
  console.error("FAIL deno_index.ts 没有调用 Deno.serve");
  process.exit(1);
}

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push(String(url));
  if (String(url).endsWith("/models")) {
    return new Response(JSON.stringify({ object: "list", data: [{ id: "grok-4" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ choices: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

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

const getModels = (path) =>
  serveHandler(new Request(`https://proxy.example${path}`, {
    headers: { Authorization: "Bearer k" },
  }));

for (const path of ["/v1/models", "/models", "/v1/models/", "/models/"]) {
  const res = await getModels(path);
  const body = await res.json();
  check(`${path} 路由到代理`, res.status === 200 && body.data?.[0]?.id === "grok-4", `${res.status} ${JSON.stringify(body)}`);
}

{
  const res = await serveHandler(new Request("https://proxy.example/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ model: "grok-4", messages: [{ role: "user", content: "hi" }] }),
  }));
  check("/v1/chat/completions 路由到代理", res.status === 200, res.status);
}

{
  const res = await serveHandler(new Request("https://proxy.example/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ model: "grok-2-image-1212", prompt: "a cat" }),
  }));
  check("/v1/images/generations 路由到代理", res.status === 200, res.status);
}

{
  const form = new FormData();
  form.append("model", "grok-imagine-image");
  form.append("prompt", "make it blue");
  form.append("image", new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" }));
  const res = await serveHandler(new Request("https://proxy.example/v1/images/edits", {
    method: "POST",
    headers: { Authorization: "Bearer k" },
    body: form,
  }));
  check("/v1/images/edits 路由到代理", res.status === 200, res.status);
}

{
  const res = await serveHandler(new Request("https://proxy.example/health"));
  check("非 API 路径返回 ok", (await res.text()) === "ok", res.status);
}

check("上游地址为 api.x.ai/v1/models", calls.some((u) => u === "https://api.x.ai/v1/models"), calls.join());
check("上游地址为 api.x.ai/v1/images/generations", calls.some((u) => u === "https://api.x.ai/v1/images/generations"), calls.join());
check("上游地址为 api.x.ai/v1/images/edits", calls.some((u) => u === "https://api.x.ai/v1/images/edits"), calls.join());

console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
