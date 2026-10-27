import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyProbe, HIDDEN_STATUSES } from "../lib/probe.mjs";

describe("live probe classification", () => {
  test("a streamed Chat Completions text delta proves the model answered", () => {
    const result = classifyProbe(
      200,
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
    );
    assert.equal(result.status, "ok");
    assert.match(result.detail, /completion content/);
  });

  test("a Responses API completed message proves the model answered", () => {
    const result = classifyProbe(
      200,
      'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}}\n\n',
    );
    assert.equal(result.status, "ok");
  });

  test("HTTP 200 with no generated content is not marked usable", () => {
    assert.deepEqual(classifyProbe(200, "data: [DONE]\n\n"), {
      status: "error",
      detail: "HTTP 200 but no completion content",
    });
    assert.equal(classifyProbe(200, '{"choices":[]}').status, "error");
  });

  test("free quota errors remain rate-limited, not unavailable", () => {
    const result = classifyProbe(
      200,
      'data: {"error":{"type":"FreeUsageLimitError","message":"Usage limit reached"}}\n\n',
    );
    assert.equal(result.status, "rate_limited");
    assert.equal(HIDDEN_STATUSES.has(result.status), false);
  });

  test("hard model refusals stay hidden and transient errors stay visible", () => {
    const refused = classifyProbe(400, '{"error":{"message":"Model is unavailable"}}');
    assert.equal(refused.status, "unavailable");
    assert.equal(HIDDEN_STATUSES.has(refused.status), true);

    const transient = classifyProbe(503, "upstream unavailable");
    assert.equal(transient.status, "error");
    assert.equal(HIDDEN_STATUSES.has(transient.status), false);
  });
});
