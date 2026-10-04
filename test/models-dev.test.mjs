import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  entryFromModelsDev,
  fetchFreeModels,
  freeModelsFromApi,
  freeModelsFromTomls,
  isFreeCost,
  parseToml,
} from "../lib/models-dev.mjs";

/**
 * Contract tests for the models.dev reader.
 *
 * The fixtures are real files copied from
 * github.com/anomalyco/models-dev → providers/opencode/models, i.e. the
 * catalogue opencode itself ships. No network here.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOML_DIR = path.join(HERE, "fixtures", "models-dev-toml");
const API_FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "models-dev-api.json"), "utf8"));

const read = (name) => fs.readFileSync(path.join(TOML_DIR, name), "utf8");
const tomlFiles = () =>
  fs
    .readdirSync(TOML_DIR)
    .filter((f) => f.endsWith(".toml"))
    .map((name) => ({ name, content: read(name) }));

describe("TOML reader", () => {
  test("parses every fixture without throwing", () => {
    const files = tomlFiles();
    assert.ok(files.length >= 5, "fixture files are present");
    for (const file of files) {
      assert.doesNotThrow(() => parseToml(file.content), `${file.name} parses`);
    }
  });

  test("scalars, tables and underscore numbers (big-pickle)", () => {
    const parsed = parseToml(read("big-pickle.toml"));
    assert.equal(parsed.name, "Big Pickle");
    assert.equal(parsed.family, "big-pickle");
    assert.equal(parsed.reasoning, true);
    assert.equal(parsed.tool_call, true);
    assert.equal(parsed.attachment, false);
    assert.equal(parsed.structured_output, true);
    assert.equal(parsed.open_weights, false);
    assert.equal(parsed.interleaved.field, "reasoning_content");
    assert.deepEqual(parsed.cost, { input: 0, output: 0, cache_read: 0, cache_write: 0 });
    assert.deepEqual(parsed.limit, { context: 200000, input: 160000, output: 32000 });
    assert.deepEqual(parsed.modalities, { input: ["text"], output: ["text"] });
    assert.deepEqual(parsed.reasoning_options, []);
  });

  test("comments, deprecated status and string arrays (glm-4.7-free)", () => {
    const parsed = parseToml(read("glm-4.7-free.toml"));
    assert.equal(parsed.status, "deprecated");
    assert.equal(parsed.knowledge, "2025-04");
    assert.equal(parsed.limit.context, 204800);
    assert.equal(parsed.limit.output, 131072);
    assert.deepEqual(parsed.modalities.input, ["text"]);
    // A comment on its own line and a trailing comment must not leak in.
    assert.equal(parsed.description, "Legacy model retained for compatibility with older integrations");
    assert.deepEqual(parsed.reasoning_options, [{ type: "toggle" }]);
  });

  test("arrays of tables and inline tables (gpt-5.6-sol, paid)", () => {
    const parsed = parseToml(read("gpt-5.6-sol.toml"));
    assert.equal(parsed.cost.input, 4);
    assert.equal(parsed.cost.output, 20);
    assert.equal(parsed.cost.cache_write, 5);
    assert.equal(Array.isArray(parsed.cost.tiers), true);
    assert.equal(parsed.cost.tiers.length, 1);
    assert.deepEqual(parsed.cost.tiers[0].tier, { type: "context", size: 272000 });
    assert.equal(parsed.cost.tiers[0].input, 8);
    assert.equal(parsed.provider.npm, "@ai-sdk/openai");
    assert.deepEqual(parsed.reasoning_options[0].values, ["none", "low", "medium", "high", "xhigh", "max"]);
  });

  test("multi-line arrays (muse-spark / space-bunny)", () => {
    const muse = parseToml(read("muse-spark-1.3-contributor-free.toml"));
    assert.equal(muse.attachment, true);
    assert.deepEqual(muse.modalities.input, ["text", "image", "video", "pdf", "audio"]);
    assert.equal(muse.limit.context, 1048576);
    assert.deepEqual(muse.reasoning_options, [
      { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] },
    ]);

    const bunny = parseToml(read("space-bunny-free.toml"));
    assert.equal(bunny.reasoning_options.length, 1, "trailing comma does not create an empty entry");
    assert.deepEqual(bunny.reasoning_options[0].values, ["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("free-model selection", () => {
  test("free means every price is zero", () => {
    assert.equal(isFreeCost({ input: 0, output: 0, cache_read: 0 }), true);
    assert.equal(isFreeCost({ input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 }), true);
    assert.equal(isFreeCost({ input: 0, output: 0.5 }), false);
    assert.equal(isFreeCost({ input: 4, output: 20 }), false);
    assert.equal(isFreeCost({ input: 0, output: 0, tiers: [{ input: 8, output: 30 }] }), false, "tiers count too");
    assert.equal(isFreeCost(undefined), false, "no price table is not free");
    assert.equal(isFreeCost({}), false);
  });

  test("a paid model never becomes an entry", () => {
    const paid = API_FIXTURE.opencode.models["gpt-5.6-sol"];
    assert.equal(entryFromModelsDev("gpt-5.6-sol", paid), null);
  });

  test("api.json and the TOML files agree on the free list", () => {
    const fromApi = freeModelsFromApi(API_FIXTURE, "opencode").map((m) => m.id);
    const fromToml = freeModelsFromTomls(tomlFiles()).map((m) => m.id);
    assert.deepEqual(fromApi, fromToml);
    assert.deepEqual(fromApi, [
      "big-pickle",
      "glm-4.7-free",
      "ling-3.1-flash-free",
      "muse-spark-1.3-contributor-free",
      "space-bunny-free",
    ]);
    assert.ok(!fromApi.includes("gpt-5.6-sol"), "paid models are excluded");
  });

  test("entries carry the capability metadata opencode publishes", () => {
    const [pickle] = freeModelsFromApi(API_FIXTURE, "opencode").filter((m) => m.id === "big-pickle");
    assert.equal(pickle.name, "Big Pickle");
    assert.equal(pickle.endpoint, "chat");
    assert.equal(pickle.source, "models.dev");
    assert.equal(pickle.context, 200000);
    assert.equal(pickle.input, 160000);
    assert.equal(pickle.output, 32000);
    assert.equal(pickle.reasoning, true);
    assert.equal(pickle.tool_call, true);
    assert.equal(pickle.attachment, false);
    assert.equal(pickle.structured_output, true);

    const [muse] = freeModelsFromApi(API_FIXTURE, "opencode").filter(
      (m) => m.id === "muse-spark-1.3-contributor-free",
    );
    assert.equal(muse.attachment, true);
    assert.deepEqual(muse.modalities.input, ["text", "image", "video", "pdf", "audio"]);
  });

  test("models.dev 'deprecated' is exposed, never used to hide by itself", () => {
    const byId = Object.fromEntries(freeModelsFromApi(API_FIXTURE, "opencode").map((m) => [m.id, m]));
    assert.equal(byId["glm-4.7-free"].deprecated, true);
    assert.equal(byId["big-pickle"].deprecated, undefined);
  });

  test("a model with only a price table still gets an entry", () => {
    const [ling] = freeModelsFromTomls(tomlFiles()).filter((m) => m.id === "ling-3.1-flash-free");
    assert.equal(ling.id, "ling-3.1-flash-free");
    assert.equal(ling.name, "Ling 3.1 Flash Free");
    assert.equal(ling.context, undefined, "unknown context stays unknown instead of being invented");
  });
});

describe("fetchFreeModels", () => {
  const apiFetch = async () => ({ ok: true, json: async () => API_FIXTURE });

  test("reads models.dev/api.json when it is reachable", async () => {
    const result = await fetchFreeModels({ fetchImpl: apiFetch });
    assert.equal(result.source, "models.dev/api.json");
    assert.equal(result.provider, "opencode");
    assert.equal(result.total, 6);
    assert.equal(result.models.length, 5);
  });

  test("falls back to the GitHub repo when models.dev is unreachable", async () => {
    const files = tomlFiles();
    const fetchImpl = async (url) => {
      if (url.startsWith("https://models.dev")) throw new Error("ENOTFOUND models.dev");
      if (url.includes("/contents/providers/opencode/models?")) {
        return {
          ok: true,
          json: async () => files.map((f) => ({ type: "file", name: f.name, path: `providers/opencode/models/${f.name}` })),
        };
      }
      const name = url.split("/").pop();
      const file = files.find((f) => f.name === name);
      if (!file) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ content: Buffer.from(file.content, "utf8").toString("base64") }) };
    };
    const result = await fetchFreeModels({ fetchImpl, githubFallback: true });
    assert.equal(result.source, "github/anomalyco/models.dev");
    assert.deepEqual(
      result.models.map((m) => m.id),
      ["big-pickle", "glm-4.7-free", "ling-3.1-flash-free", "muse-spark-1.3-contributor-free", "space-bunny-free"],
    );
  });

  test("without the fallback the failure is reported, not hidden", async () => {
    await assert.rejects(
      fetchFreeModels({ fetchImpl: async () => { throw new Error("boom"); }, githubFallback: false }),
      /boom/,
    );
  });

  test("a provider with no free models is an error, not an empty list", async () => {
    await assert.rejects(
      fetchFreeModels({
        fetchImpl: async () => ({ ok: true, json: async () => ({ openai: { models: { "gpt-5.6-sol": { cost: { input: 4 } } } } }) }),
        provider: "openai",
        githubFallback: false,
      }),
      /openai/,
    );
  });
});
