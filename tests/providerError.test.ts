import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseProviderError, LlmProviderError } from "../src/server/analysis/providerError.js";
import { PROVIDER_ERROR_CATEGORIES, type ProviderErrorCategory } from "../src/shared/providerError.js";

function diagnose(message: string, param: unknown = null, code?: string, status = 400) {
  return diagnoseProviderError(JSON.stringify({ error: { message, param, code } }), status);
}

test("provider errors identify actionable finite causes without retaining the message or code", () => {
  const cases: Array<[ProviderErrorCategory, string, unknown?, string?]> = [
    ["context_limit", "This model's maximum context length is 131072 tokens; requested 145000 tokens"],
    ["context_limit", "PRIVATE_PROMPT", null, "context_length_exceeded"],
    ["max_tokens", "max_tokens must be between 1 and 393216", "max_tokens"],
    ["model", "The model does not exist", "model"],
    ["unsupported_parameter", "Unknown parameter: reasoning_effort", "reasoning_effort"],
    ["unsupported_parameter", "JSON mode is not supported", "response_format"],
    ["stream_options", "stream_options may only be used if stream is true", "stream_options.include_usage"],
    ["json_requirement", "'messages' must contain the word 'json' to use response_format of type json_object", "messages"],
    ["invalid_unicode", "Failed to deserialize JSON body: unexpected end of hex escape at line 1 column 2", "messages[1].content"],
    ["invalid_unicode", "invalid control character at line 1", "messages.0.content"],
    ["invalid_unicode", "Unsupported special token in message", "messages"],
    ["invalid_json", "Failed to deserialize JSON body into target type: messages[1].content: invalid type", "messages[1].content"],
    ["invalid_json", "invalid JSON at line 1 column 80"],
    ["content_policy", "PRIVATE_PROMPT", null, "content_exists_risk"],
    ["authentication", "API key is invalid: PRIVATE_KEY"],
    ["balance", "PRIVATE_MESSAGE", null, "insufficient_balance"],
    ["rate_limit", "PRIVATE_MESSAGE", null, "rate_limit_exceeded"],
    ["unknown", "PRIVATE_PROMPT PRIVATE_KEY", "PRIVATE_PARAM", "PRIVATE_CODE"],
  ];
  for (const [category, message, param, code] of cases) {
    const diagnosis = diagnose(message, param, code);
    assert.equal(diagnosis.category, category, message);
    assert.doesNotMatch(JSON.stringify(diagnosis), /PRIVATE_|131072|145000|393216/);
    assert.ok(PROVIDER_ERROR_CATEGORIES.includes(diagnosis.category));
  }
});

test("status fallbacks survive malformed or empty bodies and policy errors are distinct from credentials", () => {
  for (const [status, category] of [[401, "authentication"], [402, "balance"], [403, "authentication"], [429, "rate_limit"]] as const) {
    assert.deepEqual(diagnoseProviderError("<html>PRIVATE_KEY</html>", status), { category, param: null });
  }
  assert.equal(diagnose("Content policy violation", null, undefined, 403).category, "content_policy");
  for (const raw of ["", "<html>server error PRIVATE_KEY</html>", "{broken", "null", "[]", "123"]) {
    assert.deepEqual(diagnoseProviderError(raw, 400), { category: "unknown", param: null });
  }
});

test("only known parameter paths survive, with array indexes removed", () => {
  assert.equal(diagnose("rejected", "messages[37].content").param, "messages.content");
  assert.equal(diagnose("rejected", "messages.0.reasoning_content").param, "messages.reasoning_content");
  assert.equal(diagnose("rejected", " thinking.type ").param, "thinking.type");
  for (const param of ["messages[1].content.PRIVATE_KEY", "messages[10000].content", "PRIVATE_PARAM", "api_key", "model\nPRIVATE_KEY", "x".repeat(1000), { key: "PRIVATE_KEY" }, ["model"], null]) {
    assert.equal(diagnose("rejected", param).param, null);
  }
  const error = new LlmProviderError(400, diagnose("PRIVATE_MESSAGE invalid control character PRIVATE_PROMPT", "messages[1].content", "PRIVATE_KEY"));
  assert.equal(error.status, 400);
  assert.equal(error.category, "invalid_unicode");
  assert.equal(error.param, "messages.content");
  assert.match(error.message, /LLM API 400: provider request failed \(invalid_unicode; param=messages.content\)/);
  assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /PRIVATE_/);
});
