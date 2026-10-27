#!/usr/bin/env node
/**
 * capture:fixture — record what the official OpenCode CLI actually sends.
 *
 *   npm run capture:fixture -- --bin /path/to/opencode
 *   OPENCODE_BIN=$(command -v opencode) npm run capture:fixture
 *
 * A local server stands in for the model provider. We give the official CLI a
 * throwaway config, capture its model requests, and stop it after its first
 * real tool-bearing request. The contract test uses this fixture so changes in
 * the upstream client cannot silently drift away from this proxy.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(HERE, "test", "fixtures");
const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const bin = getArg("bin") || process.env.OPENCODE_BIN || "opencode";
const prompt = getArg("prompt") || "say hi";
const model = getArg("model") || "opencode/big-pickle";
const requests = [];
let cli;
let stopTimer;

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

function semver(value) {
  return String(value).match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] || String(value).trim();
}

function packageName(file) {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 8; i += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (manifest.name) return manifest.name;
    } catch {
      // Keep looking up from the binary directory.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "local-opencode-binary";
}

function sendChatStream(res, body) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(
    sse({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: "HI" }, finish_reason: null }],
    }),
  );
  res.write(
    sse({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
  );
  res.write(
    sse({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
  res.end("data: [DONE]\n\n");
}

function sendResponsesStream(res, body) {
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: body.model,
    status: "completed",
    output: [{ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "HI", annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(sse({ type: "response.created", response: { ...response, status: "in_progress", output: [] } }));
  res.write(sse({ type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "HI" }));
  res.write(sse({ type: "response.completed", response }));
  res.end("data: [DONE]\n\n");
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // The capture loop will report that no supported request was made.
    }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (req.method === "GET" && req.url?.endsWith("/models")) {
      const text = JSON.stringify({ object: "list", data: [{ id: "big-pickle", object: "model" }] });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
      return;
    }
    if (body.stream === true && req.url?.endsWith("/responses")) sendResponsesStream(res, body);
    else if (body.stream === true) sendChatStream(res, body);
    else {
      const text = JSON.stringify({
        id: "chatcmpl-fixture",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "HI" }, finish_reason: "stop" }],
      });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    }

    const hasTools = (body.tools || []).length > 0;
    if ((hasTools || requests.length >= 3) && cli && !stopTimer) {
      stopTimer = setTimeout(() => cli.kill("SIGTERM"), 500);
    }
  });
});

const keepHeader = (name) =>
  [
    "authorization",
    "content-type",
    "user-agent",
    "accept",
    "accept-encoding",
    "x-session-affinity",
    "x-session-id",
    "x-parent-session-id",
  ].includes(name) || name.startsWith("x-opencode-");

async function main() {
  let rawVersion;
  try {
    rawVersion = execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (err) {
    console.error(`Cannot run ${bin}: ${err.message}`);
    console.error("Install the CLI or pass --bin /path/to/opencode.");
    process.exit(1);
  }

  const version = semver(rawVersion);
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-capture-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-capture-ws-"));
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({
      provider: { opencode: { options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "public" } } },
    }),
  );

  let cliOutput = "";
  const result = await new Promise((resolve) => {
    cli = spawn(bin, ["run", prompt, "-m", model, "--standalone"], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [cli.stdout, cli.stderr]) {
      stream.on("data", (chunk) => {
        cliOutput = `${cliOutput}${chunk}`.slice(-6000);
      });
    }
    const hardStop = setTimeout(() => cli.kill("SIGKILL"), 45000);
    cli.once("exit", (code, signal) => {
      clearTimeout(hardStop);
      clearTimeout(stopTimer);
      resolve({ code, signal });
    });
    cli.once("error", (error) => {
      clearTimeout(hardStop);
      clearTimeout(stopTimer);
      resolve({ error });
    });
  });
  await new Promise((resolve) => server.close(resolve));

  const recorded = [];
  for (const entry of requests) {
    if (!entry.url.endsWith("/chat/completions") && !entry.url.endsWith("/responses")) continue;
    const body = entry.body;
    const tools = body.tools || [];
    recorded.push({
      endpoint: entry.url.endsWith("/chat/completions") ? "chat/completions" : "responses",
      headers: Object.fromEntries(
        Object.entries(entry.headers)
          .filter(([name]) => keepHeader(name.toLowerCase()))
          .map(([name, value]) => [name.toLowerCase(), value]),
      ),
      body: {
        model: body.model,
        stream: body.stream,
        streamOptions: body.stream_options || null,
        maxTokensField:
          body.max_completion_tokens !== undefined
            ? "max_completion_tokens"
            : body.max_tokens !== undefined
              ? "max_tokens"
              : null,
        keys: Object.keys(body).sort(),
        toolNames: tools.map((tool) => tool.name || tool.function?.name).filter(Boolean),
      },
    });
  }

  if (!recorded.length) {
    console.error("The CLI never called the fake model endpoint.");
    console.error(JSON.stringify(result));
    console.error("Request trace:", JSON.stringify(requests.map((request) => ({ method: request.method, url: request.url }))));
    if (cliOutput) console.error(cliOutput);
    process.exit(1);
  }

  const chat = recorded.find((entry) => entry.endpoint === "chat/completions") || recorded[0];
  const userAgent = chat.headers["user-agent"] || "";
  const channel = userAgent.match(/^opencode\/([^/]+)\//)?.[1] || "unknown";
  const runtime = userAgent.match(/runtime\/(\S+)/)?.[1];
  const providerUtils = userAgent.match(/ai-sdk\/provider-utils\/(\S+)/)?.[1];
  const cliInfo = {
    package: packageName(bin),
    version,
    rawVersion,
    channel,
    userAgent,
  };
  if (runtime) cliInfo.runtime = runtime;
  if (providerUtils) cliInfo.providerUtils = providerUtils;

  fs.mkdirSync(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, `opencode-cli-${version}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        $comment:
          "Captured from the real OpenCode CLI by pointing it at a local server (scripts/capture-cli-fixture.mjs). Contract test: what this proxy sends must stay equivalent to what the official client sends.",
        capturedAt: new Date().toISOString().slice(0, 10),
        cli: cliInfo,
        requests: recorded,
      },
      null,
      2,
    )}\n`,
  );

  const requestWithTools = recorded.find((entry) => entry.body.toolNames.length > 0) || chat;
  console.log(`Wrote ${file}`);
  console.log(`  user-agent : ${userAgent}`);
  console.log(`  tools      : ${requestWithTools.body.toolNames.join(", ") || "none"}`);
  console.log(`  endpoint   : ${requestWithTools.endpoint}`);
  console.log(`  stream     : ${requestWithTools.body.stream}`);
  if (result.error) console.log(`  CLI stopped after capture: ${result.error.message}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
