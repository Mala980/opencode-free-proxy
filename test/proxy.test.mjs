import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../server.mjs";

/**
 * End-to-end tests for the proxy against a mock Zen upstream.
 * Run with: npm test
 */

const KEYS = { tester: "oc-test-key-0000000000000000000000000" };

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function startMockUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url, "http://mock");
      requests.push({ path: url.pathname, headers: req.headers, body });

      const model = body.model;

      if (url.pathname === "/v1/models") {
        return json(res, 200, {
          object: "list",
          data: [
            "big-pickle",
            "space-bunny-free",
            "longcat-2.5-preview-free",
            "mimo-v2.6-flash-free",
            "mimo-v2.5-free",
            "fledge-alpha-free",
            "nemotron-3-ultra-free",
            "nemotron-3.5-lightning-free",
            "ling-3.1-flash-free",
            "ling-3.0-flash-fin-free",
            "deepseek-v4-flash-free",
            "muse-spark-1.3-contributor-free",
            "brand-new-model-free",
            "ratelimited-free",
            "midstream-free",
            "timeout-free",
            "thinking-free",
            "injectcall-free",
            "gone-free",
            "deprecated-free",
            "region-free",
            "flake-free",
            "gpt-6-astra",
          ].map((id) => ({ id, object: "model", owned_by: "opencode" })),
        });
      }

      if (url.pathname === "/v1/responses") {
        const response = {
          id: "resp_1",
          object: "response",
          model,
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "responses ok" }] }],
        };
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}\n\n`);
          res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
          return res.end();
        }
        return json(res, 200, response);
      }

      if (url.pathname === "/v1/chat/completions") {
        if (model === "gone-free") {
          return json(res, 404, { error: { message: "Model not found", type: "not_found_error" } });
        }
        if (model === "deprecated-free") {
          return json(res, 400, { error: { message: "Model is unavailable (deprecated)", type: "invalid_request_error" } });
        }
        if (model === "region-free") {
          return json(res, 403, { error: { message: "Region not supported", type: "RegionError" } });
        }
        if (model === "flake-free") {
          return json(res, 500, { error: { message: "upstream exploded" } });
        }
        if (model === "ratelimited-free") {
          return json(res, 429, {
            error: { message: "You have exceeded your free usage limit", type: "FreeUsageLimitError" },
          });
        }
        if (model === "timeout-free") return; // never respond

        const toolCallRequested = JSON.stringify(body).includes("get_weather");

        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (model === "midstream-free") {
            res.write(sse({ choices: [{ index: 0, delta: { content: "partial" } }] }));
            res.write(
              sse({ error: { message: "You have exceeded your free usage limit", type: "FreeUsageLimitError" } }),
            );
            return res.end();
          }
          if (model === "thinking-free") {
            res.write(sse({ choices: [{ index: 0, delta: { reasoning_content: "Step 1" } }] }));
            res.write(sse({ choices: [{ index: 0, delta: { reasoning_content: ": think" } }] }));
          }
          res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }));
          res.write(sse({ choices: [{ index: 0, delta: { content: "Hello" } }] }));
          res.write(sse({ choices: [{ index: 0, delta: { content: " world" } }] }));
          if (toolCallRequested) {
            res.write(
              sse({
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } },
                      ],
                    },
                  },
                ],
              }),
            );
            res.write(
              sse({
                choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }],
              }),
            );
            res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
          } else {
            res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
          }
          if (model === "injectcall-free") {
            res.write(
              sse({
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "read", arguments: '{"file' } }] },
                  },
                ],
              }),
            );
            res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'Path":"/tmp/a"}' } }] } }] }));
            res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
          }
          res.write(
            sse({ id: "chatcmpl-1", model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }),
          );
          res.write("data: [DONE]\n\n");
          return res.end();
        }

        const message = { role: "assistant", content: "Hello world" };
        if (toolCallRequested) {
          message.content = null;
          message.tool_calls = [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ];
        }
        return json(res, 200, {
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1791095878,
          model,
          choices: [{ index: 0, message, finish_reason: toolCallRequested ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        });
      }

      json(res, 404, { error: { message: "not found" } });
    });
    req.on("error", () => {});
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  function json(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  return {
    requests,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

let upstream;
let app;
let base;
let keyFile;

const sockets = new Set();

before(async () => {
  upstream = startMockUpstream();
  const upstreamPort = await upstream.listen();
  keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ocp-")), "api-keys.json");
  fs.writeFileSync(keyFile, JSON.stringify(KEYS));
  app = createServer({
    port: 0,
    host: "127.0.0.1",
    zenBase: `http://127.0.0.1:${upstreamPort}/v1`,
    keysFile: keyFile,
    logRequests: false,
    verify: false,
  });
  const addr = await app.listen();
  await app.ready(); // first refresh + verification round
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app?.close();
  await upstream?.close();
});

function call(pathname, { method = "GET", body, key = KEYS.tester } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${pathname}`,
      {
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
            json: () => JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function postJson(baseUrl, pathname, body, key = KEYS.tester) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}${pathname}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${key}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function withProxy(overrides, fn) {
  const tmpKeys = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ocpx-")), "keys.json");
  fs.writeFileSync(tmpKeys, JSON.stringify(KEYS));
  const instance = createServer({
    port: 0,
    host: "127.0.0.1",
    zenBase: app.cfg.zenBase,
    keysFile: tmpKeys,
    logRequests: false,
    verify: false,
    ...overrides,
  });
  const addr = await instance.listen();
  await instance.ready();
  try {
    return await fn(`http://127.0.0.1:${addr.port}`, instance);
  } finally {
    await instance.close();
  }
}

describe("health & discovery", () => {
  test("GET /health is public and reports upstream state", async () => {
    const res = await call("/health", { key: null });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.status, "ok");
    assert.equal(data.upstream.live, true);
    assert.ok(data.models.includes("big-pickle"));
    assert.ok(data.models.includes("brand-new-model-free"), "new free models on Zen are picked up");
    assert.ok(!data.models.includes("gpt-6-astra"), "paid models are never exposed");
  });

  test("GET /v1/models requires a key and lists free models with metadata", async () => {
    const noAuth = await call("/v1/models", { key: null });
    assert.equal(noAuth.status, 401);

    const res = await call("/v1/models");
    assert.equal(res.status, 200);
    const ids = res.json().data.map((m) => m.id);
    assert.ok(ids.includes("big-pickle"));
    assert.ok(ids.includes("space-bunny-free"));
    assert.ok(!ids.includes("jev-1.13-free"), "systemone models are not proxied");
    const pickle = res.json().data.find((m) => m.id === "big-pickle");
    assert.equal(pickle.context_window, 200000);
    assert.equal(pickle.supports_tools, true);
  });

  test("x-api-key works too", async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/v1/models`, { headers: { "x-api-key": KEYS.tester } }, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(res.status, 200);
  });
});

describe("OpenAI format", () => {
  test("non-streaming chat completion", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.model, "big-pickle");
    assert.equal(data.choices[0].message.content, "Hello world");
  });

  test("streaming chat completion", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/event-stream/);
    assert.match(res.text, /"content":"Hello"/);
    assert.match(res.text, /data: \[DONE\]/);
  });

  test("temperature and max_tokens are forwarded", async () => {
    await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }], temperature: 0.2, max_tokens: 64 },
    });
    const last = upstream.requests[upstream.requests.length - 1];
    assert.equal(last.body.temperature, 0.2);
    assert.equal(last.body.max_tokens, 64);
  });

  test("Zen auth headers are attached", async () => {
    await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
    });
    const last = upstream.requests[upstream.requests.length - 1];
    assert.equal(last.headers.authorization, "Bearer public");
    assert.equal(last.headers["x-opencode-client"], "cli");
    assert.equal(last.headers["x-opencode-project"], "global");
    assert.match(last.headers["x-opencode-session"], /^ses_/);
    assert.match(last.headers["x-opencode-request"], /^msg_/);
    assert.match(last.headers["user-agent"], /^opencode\/1\.18\.34 /);
  });
});

describe("Anthropic format", () => {
  test("non-streaming /v1/messages", async () => {
    const res = await call("/v1/messages", {
      method: "POST",
      body: {
        model: "big-pickle",
        system: "You are helpful.",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.type, "message");
    assert.equal(data.role, "assistant");
    assert.equal(data.content[0].type, "text");
    assert.equal(data.content[0].text, "Hello world");
    assert.equal(data.stop_reason, "end_turn");
    assert.equal(data.usage.input_tokens, 11);

    const last = upstream.requests[upstream.requests.length - 1];
    assert.equal(last.body.messages[0].role, "system");
    assert.equal(last.body.messages[0].content, "You are helpful.");
    assert.equal(last.body.messages[1].content, "hi");
  });

  test("streaming /v1/messages emits Anthropic SSE", async () => {
    const res = await call("/v1/messages", {
      method: "POST",
      body: { model: "big-pickle", max_tokens: 128, messages: [{ role: "user", content: "hi" }], stream: true },
    });
    assert.equal(res.status, 200);
    assert.match(res.text, /event: message_start/);
    assert.match(res.text, /"type":"text_delta","text":"Hello"/);
    assert.match(res.text, /event: content_block_stop/);
    assert.match(res.text, /event: message_delta/);
    assert.match(res.text, /event: message_stop/);
  });

  test("reasoning_content becomes a single thinking block", async () => {
    const res = await call("/v1/messages", {
      method: "POST",
      body: { model: "thinking-free", max_tokens: 128, stream: true, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.status, 200);
    const thinkingStarts = res.text.match(/"content_block":\{"type":"thinking"/g) || [];
    assert.equal(thinkingStarts.length, 1, "thinking block is opened once");
    assert.match(res.text, /"thinking":"Step 1"/);
    assert.match(res.text, /"thinking":": think"/);
    assert.match(res.text, /"type":"text_delta","text":"Hello"/);
    assert.ok((res.text.match(/"type":"content_block_stop"/g) || []).length >= 2, "both blocks are closed");
  });

  test("tool calls round-trip as tool_use blocks", async () => {
    const res = await call("/v1/messages", {
      method: "POST",
      body: {
        model: "big-pickle",
        max_tokens: 128,
        tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "weather in Paris?" }],
      },
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.stop_reason, "tool_use");
    const toolUse = data.content.find((b) => b.type === "tool_use");
    assert.equal(toolUse.name, "get_weather");
    assert.deepEqual(toolUse.input, { city: "Paris" });
  });

  test("streaming tool calls produce input_json_delta", async () => {
    const res = await call("/v1/messages", {
      method: "POST",
      body: {
        model: "big-pickle",
        max_tokens: 128,
        stream: true,
        tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "weather in Paris?" }],
      },
    });
    assert.equal(res.status, 200);
    assert.match(res.text, /"type":"tool_use"/);
    assert.match(res.text, /"input_json_delta"/);
    assert.match(res.text, /"stop_reason":"tool_use"/);
  });
});

describe("Responses API", () => {
  test("/v1/responses proxies responses-endpoint models", async () => {
    const res = await call("/v1/responses", {
      method: "POST",
      body: { model: "muse-spark-1.3-contributor-free", input: "hi" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json().output[0].content[0].text, "responses ok");
    const last = upstream.requests[upstream.requests.length - 1];
    assert.equal(last.path, "/v1/responses");
  });

  test("chat models are rejected on /v1/responses", async () => {
    const res = await call("/v1/responses", { method: "POST", body: { model: "big-pickle", input: "hi" } });
    assert.equal(res.status, 400);
    assert.match(res.json().error.message, /chat model/);
  });
});

describe("runtime verification", () => {
  test("only models that actually answer are advertised", async () => {
    await withProxy({ verify: true, verifyTimeoutMs: 700 }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${KEYS.tester}` } });
      const ids = (await res.json()).data.map((m) => m.id);
      assert.ok(ids.includes("big-pickle"), "a healthy model stays visible");
      assert.ok(ids.includes("ratelimited-free"), "quota exhaustion is not the model's fault");
      assert.ok(ids.includes("flake-free"), "a transient 5xx does not hide a model");
      assert.ok(ids.includes("timeout-free"), "a slow model is not hidden either");
      assert.ok(!ids.includes("gone-free"), "404 models are hidden");
      assert.ok(!ids.includes("deprecated-free"), '"Model is unavailable" models are hidden');
      assert.ok(!ids.includes("region-free"), "RegionError models are hidden");
    });
  });

  test("hidden models explain themselves", async () => {
    await withProxy({ verify: true, verifyTimeoutMs: 700 }, async (baseUrl) => {
      const res = await postJson(baseUrl, "/v1/chat/completions", {
        model: "gone-free",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 404);
      assert.match(res.json().error.message, /not currently available/);
    });
  });

  test("/health and ?all=1 expose the verification results", async () => {
    await withProxy({ verify: true, verifyTimeoutMs: 700 }, async (baseUrl) => {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(health.verification.enabled, true);
      assert.ok(health.verification.hidden.includes("region-free"));
      assert.equal(health.verification.results["big-pickle"], "ok");
      assert.equal(health.verification.results["ratelimited-free"], "rate_limited");

      const all = await (
        await fetch(`${baseUrl}/v1/models?all=1`, { headers: { Authorization: `Bearer ${KEYS.tester}` } })
      ).json();
      const byId = Object.fromEntries(all.data.map((m) => [m.id, m.verified]));
      assert.equal(byId["deprecated-free"], "unavailable");
      assert.equal(byId["big-pickle"], "ok");
    });
  });

  test("a total verification blackout does not empty the list", async () => {
    const instance = createServer({
      port: 0,
      host: "127.0.0.1",
      zenBase: "http://127.0.0.1:1/v1",
      keysFile: (() => {
        const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ocpd-")), "keys.json");
        fs.writeFileSync(f, JSON.stringify(KEYS));
        return f;
      })(),
      logRequests: false,
      refreshModels: false,
      verify: true,
      verifyTimeoutMs: 300,
    });
    const addr = await instance.listen();
    await instance.ready();
    try {
      const res = await fetch(`${`http://127.0.0.1:${addr.port}`}/v1/models`, {
        headers: { Authorization: `Bearer ${KEYS.tester}` },
      });
      const ids = (await res.json()).data.map((m) => m.id);
      assert.ok(ids.length > 0, "unreachable Zen keeps the catalog visible");
      assert.ok(ids.includes("big-pickle"));
    } finally {
      await instance.close();
    }
  });

  test("a slow Zen does not delay startup", async () => {
    // 23 candidates, one of which never answers: the round outlives the
    // startup budget, so the port has to open on its own.
    const startedAt = Date.now();
    await withProxy({ verify: true, verifyTimeoutMs: 1200, verifyStartupTimeoutMs: 150 }, async (baseUrl) => {
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 1000, `startup took ${elapsed}ms — the port must open before the probes finish`);
      const health = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(health.verification.running, true, "verification is still in flight");
      assert.equal(health.verification.enabled, true);
    });
  });
});

describe("error handling", () => {
  test("free-tier limit becomes 429 (OpenAI shape)", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "ratelimited-free", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.status, 429);
    assert.equal(res.json().error.type, "rate_limit_error");
  });

  test("free-tier limit becomes 429 (Anthropic shape)", async () => {
    const res = await call("/v1/messages", {
      method: "POST",
      body: { model: "ratelimited-free", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.status, 429);
    assert.equal(res.json().type, "error");
    assert.equal(res.json().error.type, "rate_limit_error");
  });

  test("errors mid-stream are surfaced, not silently truncated", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "midstream-free", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    assert.equal(res.status, 200);
    assert.match(res.text, /"type":"rate_limit_error"/);
    assert.match(res.text, /data: \[DONE\]/);
  });

  test("unknown model → 404 with the available list", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.status, 404);
    assert.match(res.json().error.message, /Unknown model/);
  });

  test("retired model gets a migration hint", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "minimax-m2.5-free", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.status, 404);
    assert.match(res.json().error.message, /no longer available/);
  });

  test("FALLBACK=1 retries the next free model after a 429", async () => {
    await withProxy({ fallback: true }, async (baseUrl) => {
      const res = await postJson(baseUrl, "/v1/chat/completions", {
        model: "ratelimited-free",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json().model, "big-pickle");
    });
  });

  test("without FALLBACK the 429 is returned as-is", async () => {
    await withProxy({}, async (baseUrl) => {
      const res = await postJson(baseUrl, "/v1/chat/completions", {
        model: "ratelimited-free",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 429);
    });
  });

  test("Zen requests are always streamed, even for non-streaming callers", async () => {
    await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
    });
    const last = upstream.requests[upstream.requests.length - 1];
    assert.equal(last.body.stream, true, "the free tier 403s on stream:false");
    const res2 = await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    assert.equal(res2.status, 200);
    assert.match(res2.text, /data: \[DONE\]/);
  });

  test("the OpenCode builtin tool names are injected", async () => {
    await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
    });
    const names = (upstream.requests[upstream.requests.length - 1].body.tools || []).map((t) => t.function?.name);
    for (const required of ["bash", "edit", "glob", "grep", "read"]) {
      assert.ok(names.includes(required), `missing injected tool ${required}`);
    }
  });

  test("caller tools survive and are not duplicated", async () => {
    await call("/v1/chat/completions", {
      method: "POST",
      body: {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      },
    });
    const tools = upstream.requests[upstream.requests.length - 1].body.tools;
    const names = tools.map((t) => t.function?.name);
    assert.ok(names.includes("get_weather"));
    assert.equal(new Set(names).size, names.length, "no duplicate tool names");
  });

  test("x-opencode-session matches the canonical Zen shape", async () => {
    await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
    });
    const last = upstream.requests[upstream.requests.length - 1];
    assert.match(last.headers["x-opencode-session"], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.match(last.headers["x-opencode-request"], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.equal(last.headers["x-opencode-session"], last.headers["x-opencode-session-id"]);
  });

  test("responses format gets the flat tool shape and is re-assembled", async () => {
    const res = await call("/v1/responses", {
      method: "POST",
      body: { model: "muse-spark-1.3-contributor-free", input: "hi" },
    });
    assert.equal(res.status, 200);
    const names = (upstream.requests[upstream.requests.length - 1].body.tools || []).map((t) => t.name);
    for (const required of ["bash", "edit", "glob", "grep", "read"]) assert.ok(names.includes(required));
    assert.equal(res.json().output[0].content[0].text, "responses ok");
  });

  test("calls to injected tools are hidden from clients that declared none", async () => {
    const res = await call("/v1/chat/completions", {
      method: "POST",
      body: { model: "injectcall-free", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.choices[0].message.tool_calls, undefined);
    assert.equal(data.choices[0].finish_reason, "stop");
  });

  test("upstream timeout → 504", async () => {
    const tmpKeys = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ocp2-")), "keys.json");
    fs.writeFileSync(tmpKeys, JSON.stringify(KEYS));
    const slow = createServer({
      port: 0,
      host: "127.0.0.1",
      zenBase: app.cfg.zenBase,
      keysFile: tmpKeys,
      timeoutMs: 300,
      logRequests: false,
      verify: false,
    });
    const addr = await slow.listen();
    const res = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: "timeout-free", messages: [{ role: "user", content: "hi" }] });
      const req = http.request(
        `http://127.0.0.1:${addr.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${KEYS.tester}` },
        },
        (r) => {
          const chunks = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString() }));
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    await slow.close();
    assert.equal(res.status, 504);
    assert.match(JSON.parse(res.text).error.message, /did not respond/i);
  });
});

describe("models.dev as the free-model source", () => {
  const API_FIXTURE = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "models-dev-api.json"), "utf8"),
  );

  function startModelsDevMock(json) {
    const server = http.createServer((req, res) => {
      const text = JSON.stringify(json);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    });
    return {
      listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  function withModelsDev(json, overrides, fn) {
    const mock = startModelsDevMock(json);
    const tmpKeys = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ocpm-")), "keys.json");
    fs.writeFileSync(tmpKeys, JSON.stringify(KEYS));
    return mock.listen().then(async (port) => {
      const instance = createServer({
        port: 0,
        host: "127.0.0.1",
        zenBase: app.cfg.zenBase,
        keysFile: tmpKeys,
        logRequests: false,
        verify: false,
        modelsDevUrl: `http://127.0.0.1:${port}/api.json`,
        ...overrides,
      });
      const addr = await instance.listen();
      await instance.ready();
      try {
        return await fn(`http://127.0.0.1:${addr.port}`, instance);
      } finally {
        await instance.close();
        await mock.close();
      }
    });
  }

  const listModels = async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${KEYS.tester}` } });
    return (await res.json()).data;
  };

  test("the free list comes from models.dev's price tables", async () => {
    // Split the bundled catalog in two: models.dev prices the first ten at
    // zero and the rest above zero. Only the free half may be advertised.
    const ids = app.catalog.models.filter((m) => m.supported !== false).map((m) => m.id);
    const zero = ids.slice(0, 10);
    const priced = ids.slice(10);
    const models = {};
    for (const id of zero) models[id] = { name: id, cost: { input: 0, output: 0 } };
    for (const id of priced) models[id] = { name: id, cost: { input: 1, output: 2 } };
    models["glm-4.7-free"] = API_FIXTURE.opencode.models["glm-4.7-free"];

    await withModelsDev({ opencode: { models } }, { refreshSource: "models-dev" }, async (baseUrl) => {
      const served = (await listModels(baseUrl)).map((m) => m.id).sort();
      assert.deepEqual(served, [...zero].sort());
      for (const id of priced) {
        assert.ok(!served.includes(id), `${id} costs money according to models.dev`);
      }
      // Zen was not consulted, so an upstream-deprecated id is not added.
      assert.ok(!served.includes("glm-4.7-free"));
    });
  });

  test("a free id models.dev knows and Zen serves arrives with its metadata", async () => {
    const incoming = {
      name: "Trinity Mini Free",
      cost: { input: 0, output: 0 },
      limit: { context: 262144, output: 65536 },
      attachment: true,
      tool_call: true,
      reasoning: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    };
    const models = { ...API_FIXTURE.opencode.models, "trinity-mini-free": incoming };

    await withModelsDev({ opencode: { models } }, { refreshSource: "models-dev" }, async (baseUrl) => {
      const byId = Object.fromEntries((await listModels(baseUrl)).map((m) => [m.id, m]));
      assert.equal(byId["trinity-mini-free"].display_name, "Trinity Mini Free");
      assert.equal(byId["trinity-mini-free"].context_window, 262144);
      assert.equal(byId["trinity-mini-free"].max_output_tokens, 65536);
      assert.equal(byId["trinity-mini-free"].supports_attachments, true);
      assert.equal(byId["trinity-mini-free"].deprecation, null);
      // Curated deprecation flags keep working through the merge.
      assert.equal(byId["mimo-v2.5-free"].deprecation, "deprecated");
    });
  });

  test("a model models.dev prices above zero is dropped, even when Zen lists it", async () => {
    const priced = {
      opencode: {
        models: {
          "big-pickle": API_FIXTURE.opencode.models["big-pickle"],
          "space-bunny-free": { name: "Space Bunny Free", cost: { input: 1, output: 2 }, limit: { context: 1048576 } },
        },
      },
    };
    await withModelsDev(priced, { refreshSource: "both" }, async (baseUrl) => {
      const ids = (await listModels(baseUrl)).map((m) => m.id);
      assert.ok(ids.includes("big-pickle"), "still free upstream");
      assert.ok(!ids.includes("space-bunny-free"), "models.dev says it costs money now");
    });
  });

  test("models we switched off stay hidden even if models.dev calls them free", async () => {
    const withDisabled = {
      opencode: {
        models: {
          ...API_FIXTURE.opencode.models,
          "jev-1.13-free": { name: "Jev 1.13 Free", cost: { input: 0, output: 0 } },
          "qwen3.6-plus-free": { name: "Qwen3.6 Plus Free", cost: { input: 0, output: 0 } },
        },
      },
    };
    await withModelsDev(withDisabled, { refreshSource: "models-dev" }, async (baseUrl) => {
      const ids = (await listModels(baseUrl)).map((m) => m.id);
      assert.ok(!ids.includes("jev-1.13-free"), "supported:false is respected");
      assert.ok(!ids.includes("qwen3.6-plus-free"), "retired ids stay retired");
    });
  });

  test("/health reports where the free list came from", async () => {
    await withModelsDev(API_FIXTURE, { refreshSource: "models-dev" }, async (baseUrl) => {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(health.modelsDev.enabled, true);
      assert.equal(health.modelsDev.provider, "opencode");
      assert.equal(health.modelsDev.live, true);
      assert.equal(health.modelsDev.free, 5);
      assert.equal(health.modelsDev.error, null);
    });
  });

  test("an unreachable models.dev leaves the bundled catalog alone", async () => {
    await withModelsDev(API_FIXTURE, { refreshSource: "models-dev", modelsDevUrl: "http://127.0.0.1:1/api.json", modelsDevTimeoutMs: 300 }, async (baseUrl) => {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(health.modelsDev.live, false);
      assert.ok(health.modelsDev.error);
      const ids = (await listModels(baseUrl)).map((m) => m.id);
      assert.ok(ids.includes("big-pickle") && ids.includes("space-bunny-free"), "catalog survives");
    });
  });
});
