import assert from "node:assert/strict";
import test from "node:test";
import { validateBasicAuth } from "../src/server/auth/basicAuth.js";

const header = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

test("Basic Auth accepts the configured credentials", () => {
  assert.equal(validateBasicAuth(header("admin", "correct horse"), "admin", "correct horse"), true);
});

test("Basic Auth rejects missing, malformed, and incorrect credentials", () => {
  assert.equal(validateBasicAuth(undefined, "admin", "secret"), false);
  assert.equal(validateBasicAuth("Bearer token", "admin", "secret"), false);
  assert.equal(validateBasicAuth(header("admin", "wrong"), "admin", "secret"), false);
  assert.equal(validateBasicAuth(header("other", "secret"), "admin", "secret"), false);
});

test("Basic Auth supports colons in the password", () => {
  assert.equal(validateBasicAuth(header("admin", "part:part"), "admin", "part:part"), true);
});
