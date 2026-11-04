import assert from "node:assert/strict";
import test from "node:test";
import { MAP_SYSTEM } from "../src/server/digest/digest.js";

test("map stage keeps source labels, conditions/counter-signals and existing link hypotheses for the final writer", () => {
  // Existing guarantees stay.
  assert.match(MAP_SYSTEM, /한 건도 빠짐없이/);
  assert.match(MAP_SYSTEM, /\[N\]을 그대로/);
  assert.match(MAP_SYSTEM, /제목·URL은 쓰지 않는다/);
  // New: the evidence-packet parts the final report needs.
  assert.match(MAP_SYSTEM, /\[출처 성격\]/);
  assert.match(MAP_SYSTEM, /미확인 정보를 확정처럼 바꾸지 않는다/);
  assert.match(MAP_SYSTEM, /조건\/반론/);
  assert.match(MAP_SYSTEM, /\[연결 가설\]/);
  assert.match(MAP_SYSTEM, /새 가설을 만들지 말고/);
  assert.match(MAP_SYSTEM, /같은 \[번호\]로 줄을 나눠/);
});
