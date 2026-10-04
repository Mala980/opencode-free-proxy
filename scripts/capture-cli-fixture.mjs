#!/usr/bin/env node
/**
 * capture:fixture — records what the *official* opencode CLI actually sends
 * to Zen, and writes it to test/fixtures/opencode-cli-<version>.json.
 *
 *   npm run capture:fixture -- --bin /path/to/opencode
 *   OPENCODE_BIN=$(command -v opencode) npm run capture:fixture
 *
 * How it works: a local server pretends to be Zen, we point the CLI at it
 * with a throwaway config, and we save the request. The committed fixture is
 * what test/fingerprint.test.mjs compares this proxy against, so the proxy
 * can never silently drift away from the real client.
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

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const captured = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    captured.push({ url: req.url, headers: req.headers, body: raw });
    if (raw.includes('"stream":true') || raw.includes('"stream": true')) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "HI" } }] }));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      res.end("data: [DONE]\n\n");
      return;
    }
    const text = JSON.stringify({
      id: "c1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "HI" }, finish_reason: "stop" }],
    });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  });
});

const keepHeader = (name) =>
  ["authorization", "content-type", "user-agent", "accept"].includes(name) || name.startsWith("x-opencode-");

async function main() {
  let version = "unknown";
  try {
    version = execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (err) {
    console.error(`Cannot run ${bin}: ${err.message}`);
    console.error("Install the CLI (npm i -g opencode-ai) or pass --bin /path/to/opencode.");
    process.exit(1);
  }

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

  await new Promise((resolve) => {
    const child = spawn(bin, ["run", prompt, "-m", model], {
      cwd: workspace,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") },
      stdio: "ignore",
    });
    child.on("exit", resolve);
    child.on("error", resolve);
    setTimeout(() => child.kill("SIGKILL"), 90000);
  });
  server.close();

  const requests = [];
  for (const entry of captured) {
    if (!entry.url.endsWith("/chat/completions") && !entry.url.endsWith("/responses")) continue;
    let body = {};
    try {
      body = JSON.parse(entry.body);
    } catch {
      continue;
    }
    const tools = body.tools || [];
    requests.push({
      endpoint: entry.url.endsWith("/chat/completions") ? "chat/completions" : "responses",
      headers: Object.fromEntries(
        Object.entries(entry.headers)
          .filter(([name]) => keepHeader(name.toLowerCase()))
          .map(([name, value]) => [name.toLowerCase(), value]),
      ),
      body: {
        model: body.model,
        stream: body.stream,
        keys: Object.keys(body).sort(),
        toolNames: tools.map((t) => t.name || t.function?.name).filter(Boolean),
      },
    });
  }

  if (!requests.length) {
    console.error("The CLI never called the fake Zen endpoint. Check that it ran (it may need a newer model id).");
    process.exit(1);
  }

  fs.mkdirSync(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, `opencode-cli-${version.replace(/^v/, "")}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        $comment:
          "Captured from the real OpenCode CLI by pointing it at a local server (scripts/capture-cli-fixture.mjs). Contract test: what this proxy sends must stay equivalent to what the official client sends.",
        capturedAt: new Date().toISOString().slice(0, 10),
        cli: { package: "opencode-linux-x64", version: version.replace(/^v/, ""), runtime: "bun/1.3.14" },
        requests,
      },
      null,
      2,
    )}\n`,
  );

  const chat = requests.find((r) => r.endpoint === "chat/completions");
  console.log(`Wrote ${file}`);
  console.log(`  user-agent : ${chat?.headers["user-agent"]}`);
  console.log(`  tools      : ${chat?.body.toolNames.join(", ")}`);
  console.log(`  stream     : ${chat?.body.stream}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
