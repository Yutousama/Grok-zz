// 图像接口冒烟测试：node tests/images.mjs
// 用桩函数替换 fetch，验证 /v1/images/generations 与 /v1/images/edits 的转发行为
// （特别是 multipart/form-data → xAI JSON 的转换，xAI 的 edits 端点只收 JSON）。
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

const jsonBody = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const call = (path, init) =>
  worker.fetch(new Request(`https://proxy.example${path}`, init));
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// 1. generations：JSON 透传 + 上游地址正确
{
  let seenUrl;
  let seenInit;
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return jsonBody({ created: 1, data: [{ url: "https://imgen.x.ai/img.png" }] });
  };
  const res = await call("/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ model: "grok-2-image-1212", prompt: "a cat", n: 1 }),
  });
  const body = await res.json();
  check("generations 转发到 api.x.ai/v1/images/generations", seenUrl === "https://api.x.ai/v1/images/generations", seenUrl);
  check("generations 状态码 200", res.status === 200, res.status);
  check("generations 响应 data 保留", body.data?.[0]?.url === "https://imgen.x.ai/img.png", JSON.stringify(body));
  const sent = JSON.parse(seenInit.body);
  check("generations model/prompt 透传", sent.model === "grok-2-image-1212" && sent.prompt === "a cat", seenInit.body);
}

// 2. generations：模型名去掉 models/ 前缀
{
  let seenBody;
  globalThis.fetch = async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return jsonBody({ data: [] });
  };
  await call("/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ model: "models/grok-imagine-image", prompt: "x" }),
  });
  check("generations 去掉 models/ 前缀", seenBody.model === "grok-imagine-image", seenBody.model);
}

// 3. edits：multipart 表单转换成 xAI JSON
{
  let seenUrl;
  let seenInit;
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return jsonBody({ created: 2, data: [{ url: "https://imgen.x.ai/edited.png" }] });
  };
  const form = new FormData();
  form.append("model", "grok-imagine-image");
  form.append("prompt", "make the background blue");
  form.append("n", "2");
  form.append("size", "1024x1024");   // OpenAI 专用，xAI 不支持，应被丢弃
  form.append("image", new File([PNG_BYTES], "source.png", { type: "image/png" }));

  const res = await call("/v1/images/edits", {
    method: "POST",
    headers: { Authorization: "Bearer k" },
    body: form,
  });
  const body = await res.json();
  const sent = JSON.parse(seenInit.body);

  check("edits 转发到 api.x.ai/v1/images/edits", seenUrl === "https://api.x.ai/v1/images/edits", seenUrl);
  check("edits 上游请求为 application/json", (seenInit.headers["Content-Type"] || seenInit.headers["content-type"]) === "application/json", JSON.stringify(seenInit.headers));
  check("edits 单图转成 image.url data URI", /^data:image\/png;base64,/.test(sent.image?.url || ""), sent.image?.url?.slice(0, 40));
  check("edits image.type=image_url", sent.image?.type === "image_url", sent.image?.type);
  check("edits prompt/model 保留", sent.prompt === "make the background blue" && sent.model === "grok-imagine-image", JSON.stringify(sent));
  check("edits n 转为数字", sent.n === 2, sent.n);
  check("edits 丢弃 size", !("size" in sent), JSON.stringify(sent));
  check("edits 响应透传", res.status === 200 && body.data?.[0]?.url === "https://imgen.x.ai/edited.png", JSON.stringify(body));
}

// 4. edits：多图 → images 数组（最多 3 张）
{
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return jsonBody({ data: [] });
  };
  const form = new FormData();
  form.append("model", "grok-imagine-image");
  form.append("prompt", "combine <IMAGE_0> and <IMAGE_1>");
  form.append("image", new File([PNG_BYTES], "a.png", { type: "image/png" }));
  form.append("image", new File([PNG_BYTES], "b.png", { type: "image/png" }));
  await call("/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer k" }, body: form });
  check("edits 多图转成 images 数组", Array.isArray(sent.images) && sent.images.length === 2, JSON.stringify(sent).slice(0, 120));
  check("edits 多图不产生 image 字段", !("image" in sent), JSON.stringify(sent).slice(0, 120));
}

// 5. edits：mask 转成 { url }
{
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return jsonBody({ data: [] });
  };
  const form = new FormData();
  form.append("model", "grok-imagine-image");
  form.append("prompt", "replace the mask area");
  form.append("image", new File([PNG_BYTES], "a.png", { type: "image/png" }));
  form.append("mask", new File([PNG_BYTES], "m.png", { type: "image/png" }));
  await call("/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer k" }, body: form });
  check("edits mask 转成 { url }", /^data:image\/png;base64,/.test(sent.mask?.url || ""), JSON.stringify(sent.mask).slice(0, 80));
}

// 6. edits：缺少图片时返回 400，而不是把空请求发给上游
{
  let upstreamCalled = false;
  globalThis.fetch = async () => {
    upstreamCalled = true;
    return jsonBody({ data: [] });
  };
  const form = new FormData();
  form.append("model", "grok-imagine-image");
  form.append("prompt", "no image here");
  const res = await call("/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer k" }, body: form });
  check("edits 缺少图片返回 400", res.status === 400, res.status);
  check("edits 缺少图片不请求上游", upstreamCalled === false);
}

// 7. edits：已是 xAI/OpenAI JSON 时原样透传
{
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return jsonBody({ data: [] });
  };
  const payload = {
    model: "grok-imagine-image",
    prompt: "edit this",
    image: { url: "https://example.com/a.png", type: "image_url" },
  };
  const res = await call("/v1/images/edits", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify(payload),
  });
  check("edits JSON 透传 status 200", res.status === 200, res.status);
  check("edits JSON image 原样保留", sent.image?.url === "https://example.com/a.png", JSON.stringify(sent));
}

// 8. 上游报错（415/400/404）原样透传
{
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "Expected request with Content-Type: application/json" }),
    { status: 415, headers: { "content-type": "application/json" } },
  );
  const res = await call("/v1/images/edits", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ model: "grok-imagine-image", image: { url: "x" }, prompt: "y" }),
  });
  check("edits 上游 415 透传", res.status === 415, res.status);
  check("edits 上游 415 body 透传", (await res.text()).includes("Content-Type"), "body");
}

// 9. generations：上游返回非 JSON（二进制）时按流转发
{
  globalThis.fetch = async () => new Response(PNG_BYTES, {
    status: 200,
    headers: { "content-type": "image/png", "content-length": "8" },
  });
  const res = await call("/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer k" },
    body: JSON.stringify({ model: "grok-2-image", prompt: "x" }),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  check("generations 二进制响应保留 content-type", res.headers.get("content-type") === "image/png", res.headers.get("content-type"));
  check("generations 二进制响应未被破坏", bytes.length === 8 && bytes[0] === 137, bytes.length);
  check("generations 二进制响应去掉 content-length", res.headers.get("content-length") === null);
}

console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error("failed:", failures.join(", ")); }
process.exit(failures.length === 0 ? 0 : 1);
