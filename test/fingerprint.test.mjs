/**
 * Contract tests against the real OpenCode client.
 *
 * The fixture in fixtures/opencode-cli-<version>.json was recorded from the
 * official CLI (scripts/capture-cli-fixture.mjs). Everything Zen uses to
 * decide "is this really OpenCode?" is compared here, so a change that would
 * break the free tier fails the test suite instead of production.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../server.mjs";
import {
  OPENCODE_FINGERPRINT_TOOLS,
  OPENCODE_SESSION_RE,
  generateRequestId,
  generateSessionId,
  withFingerprintTools,
  zenHeaders,
} from "../lib/zen.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(HERE, "fixtures", "opencode-cli-1.18.34.json"), "utf8"));
const chat = fixture.requests.find((r) => r.endpoint === "chat/completions");
const cliHeaders = chat.headers;

describe("parity with the official opencode CLI", () => {
  test("the fixture really comes from the CLI", () => {
    assert.equal(chat.body.stream, true);
    assert.ok(chat.body.toolNames.length >= 5, "the CLI declares its builtin tools");
    assert.equal(cliHeaders.authorization, "Bearer public");
  });

  test("User-Agent is byte-identical to the CLI's", () => {
    assert.equal(loadConfig().userAgent, cliHeaders["user-agent"]);
  });

  test("catalog and client versions agree", () => {
    const catalog = JSON.parse(readFileSync(path.join(HERE, "..", "models.json"), "utf8"));
    assert.equal(catalog.opencodeVersion, fixture.cli.version);
    assert.equal(loadConfig().ocVersion, fixture.cli.version);
  });

  test("every x-opencode header the CLI sends is sent too", () => {
    const mine = Object.fromEntries(
      Object.entries(
        zenHeaders(
          { userAgent: "opencode/1.18.34", zenKey: "public", client: "cli", project: "global" },
          generateSessionId(),
        ),
      ).map(([name, value]) => [name.toLowerCase(), value]),
    );
    for (const [name, value] of Object.entries(cliHeaders)) {
      if (!name.startsWith("x-opencode-")) continue;
      assert.ok(mine[name], `proxy does not send ${name} (CLI sends ${value})`);
    }
  });

  test("session and request ids match the CLI's id shape", () => {
    // Sanity: the regex we target must also accept what the real client sends.
    assert.match(cliHeaders["x-opencode-session"], OPENCODE_SESSION_RE);
    assert.match(generateSessionId(), OPENCODE_SESSION_RE);
    assert.match(generateRequestId(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  test("injected tools are real OpenCode builtin names", () => {
    assert.ok(OPENCODE_FINGERPRINT_TOOLS.length >= 4);
    for (const name of OPENCODE_FINGERPRINT_TOOLS) {
      assert.ok(chat.body.toolNames.includes(name), `${name} is not a tool the real CLI declares`);
    }
  });

  test("injecting keeps caller tools and never duplicates a name", () => {
    const payload = {
      tools: [
        { type: "function", function: { name: "bash", description: "mine" } },
        { type: "function", function: { name: "get_weather", parameters: {} } },
      ],
    };
    withFingerprintTools(payload);
    const names = payload.tools.map((t) => t.function.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes("get_weather"));
    assert.equal(payload.tools.find((t) => t.function.name === "bash").function.description, "mine");
  });

  test("the documented ZEN_TOOL_SET override only accepts CLI names", async () => {
    process.env.ZEN_TOOL_SET = "bash,edit,glob,grep,read,write,webfetch";
    const mod = await import(`../lib/zen.mjs?bust=${Date.now()}`);
    for (const name of mod.OPENCODE_FINGERPRINT_TOOLS) {
      assert.ok(chat.body.toolNames.includes(name), `${name} is not a real opencode tool`);
    }
    delete process.env.ZEN_TOOL_SET;
  });
});
