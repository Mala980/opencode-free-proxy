/** Contract tests against the official OpenCode v2 CLI capture. */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../server.mjs";
import {
  OPENCODE_FINGERPRINT_TOOLS,
  OPENCODE_SESSION_RE,
  applyV2ChatRequest,
  generateSessionId,
  withFingerprintTools,
  zenHeaders,
} from "../lib/zen.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(HERE, "fixtures");
const captures = readdirSync(fixturesDir)
  .filter((file) => /^opencode-cli-\d+\.\d+\.\d+\.json$/.test(file))
  .map((file) => JSON.parse(readFileSync(path.join(fixturesDir, file), "utf8")));
const cfg = loadConfig();
const fixture = captures.find((capture) => capture.cli.version === cfg.ocVersion);
assert.ok(fixture, `no captured CLI fixture for OpenCode ${cfg.ocVersion}`);
const chat = fixture.requests.find((request) => request.endpoint === "chat/completions" && request.body.toolNames.length) ||
  fixture.requests.find((request) => request.endpoint === "chat/completions");
assert.ok(chat, `capture ${fixture.cli.version} has no chat-completions request`);
const cliHeaders = chat.headers;

describe("parity with the official OpenCode v2 CLI", () => {
  test("active fixture is a real v2.2.0 CLI capture", () => {
    assert.equal(fixture.cli.version, "2.2.0");
    assert.equal(fixture.cli.channel, "latest");
    assert.equal(fixture.cli.package, "@opencode/cli-linux-x64");
    assert.equal(chat.body.stream, true);
    assert.equal(chat.body.streamOptions.include_usage, true);
    assert.equal(chat.body.maxTokensField, "max_completion_tokens");
    assert.equal(cliHeaders.authorization, "Bearer public");
    assert.ok(captures.some((capture) => capture.cli.version === "1.19.4"), "keep the prior capture for a version diff");
  });

  test("the User-Agent exactly matches OpenCode v2.2.0", () => {
    assert.equal(cliHeaders["user-agent"], "opencode/latest/2.2.0/cli");
    assert.equal(cfg.userAgent, cliHeaders["user-agent"]);
  });

  test("catalog, server config and CLI fixture use the same version/channel", () => {
    const catalog = JSON.parse(readFileSync(path.join(HERE, "..", "models.json"), "utf8"));
    assert.equal(catalog.opencodeVersion, fixture.cli.version);
    assert.equal(catalog.opencodeLatest, fixture.cli.version);
    assert.equal(cfg.ocVersion, fixture.cli.version);
    assert.equal(cfg.ocChannel, fixture.cli.channel);
  });

  test("keeps the global Zen path until the two live routes are compared", () => {
    assert.equal(cfg.zenBase, "https://opencode.ai/zen/v1");
    assert.equal(cfg.useModelBaseUrls, false);
    assert.equal(loadConfig({ useModelBaseUrls: true }).useModelBaseUrls, true, "metadata URLs remain opt-in");
  });

  test("v2 cache-affinity headers are present; the v1 request id is absent", () => {
    const sessionId = generateSessionId();
    const mine = Object.fromEntries(
      Object.entries(
        zenHeaders(
          { userAgent: cfg.userAgent, zenKey: "public", client: "cli", project: "global" },
          sessionId,
        ),
      ).map(([name, value]) => [name.toLowerCase(), value]),
    );
    for (const name of [
      "content-type",
      "accept",
      "authorization",
      "user-agent",
      "x-opencode-client",
      "x-opencode-project",
      "x-opencode-session",
      "x-opencode-session-id",
      "x-session-affinity",
      "x-session-id",
    ]) {
      assert.ok(mine[name], `proxy does not send v2 header ${name}`);
      assert.ok(cliHeaders[name], `v2 CLI capture is missing ${name}`);
    }
    assert.equal(mine.accept, "*/*");
    assert.equal(mine["x-opencode-request"], undefined);
    assert.equal(cliHeaders["x-opencode-request"], undefined);
    assert.match(cliHeaders["x-opencode-session"], OPENCODE_SESSION_RE);
    assert.match(mine["x-opencode-session"], OPENCODE_SESSION_RE);
    assert.equal(mine["x-opencode-session"], mine["x-opencode-session-id"]);
    assert.equal(mine["x-session-affinity"], mine["x-session-id"]);
  });

  test("the complete v2.2.0 builtin tool set matches the real CLI", () => {
    assert.deepEqual(OPENCODE_FINGERPRINT_TOOLS, chat.body.toolNames);
  });

  test("v2 stream and token defaults match the captured OpenAI request", () => {
    const payload = applyV2ChatRequest({ model: "big-pickle", max_tokens: 123 });
    assert.equal(payload.stream, true);
    assert.deepEqual(payload.stream_options, { include_usage: true });
    assert.equal(payload.max_completion_tokens, 123);
    assert.equal(payload.max_tokens, undefined);

    const existing = applyV2ChatRequest({ stream: true, stream_options: { include_usage: false } });
    assert.deepEqual(existing.stream_options, { include_usage: false }, "keep an explicit client usage preference");
  });

  test("injection preserves caller tools and never duplicates an OpenCode builtin", () => {
    const payload = {
      tools: [
        { type: "function", function: { name: "shell", description: "mine" } },
        { type: "function", function: { name: "get_weather", parameters: {} } },
      ],
    };
    const injected = withFingerprintTools(payload);
    const names = payload.tools.map((tool) => tool.function.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes("get_weather"));
    assert.equal(payload.tools.find((tool) => tool.function.name === "shell").function.description, "mine");
    assert.ok(!injected.includes("shell"));
  });

  test("ZEN_TOOL_SET overrides are constrained to names in the current v2 capture", async () => {
    process.env.ZEN_TOOL_SET = "edit,glob,grep,read,shell";
    try {
      const mod = await import(`../lib/zen.mjs?bust=${Date.now()}`);
      for (const name of mod.OPENCODE_FINGERPRINT_TOOLS) {
        assert.ok(chat.body.toolNames.includes(name), `${name} is not in the v2 CLI capture`);
      }
    } finally {
      delete process.env.ZEN_TOOL_SET;
    }
  });
});
