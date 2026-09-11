import assert from "node:assert/strict";
import test from "node:test";
import { parseKofiaJson, __test } from "../src/server/market/kofiaJson.js";

/**
 * KOFIA 자릿수 마스킹(`#`) 복원 — 2026-07 실측 응답 형태 기준.
 * 실제 응답 예: {"unit":"","ds1":[{"TMPV1":"20260723","TMPV2":409365#######,...}]}
 */

test("실측 형태의 마스킹 응답을 복원해 파싱한다", () => {
  const raw =
    '{"unit":"","ds1":[{"TMPV1":"20260723","TMPV2":409365#######,"TMPV3":322982#######,' +
    '"TMPV4":863823######,"TMPV5":3241104916,"TMPV6":2919996105,"TMPV7":321108811,' +
    '"TMPV8":0,"TMPV9":310478#######}],"dsmHeader":""}';
  const j = parseKofiaJson(raw, "test") as { ds1?: Array<Record<string, unknown>> };
  const r = j.ds1?.[0] as Record<string, number | string>;
  assert.equal(r.TMPV1, "20260723", "날짜 문자열은 손대지 않는다");
  assert.equal(r.TMPV2, 4093650000000);
  assert.equal(r.TMPV3, 3229820000000);
  assert.equal(r.TMPV4, 863823000000);
  assert.equal(r.TMPV5, 3241104916, "마스킹 없는 값은 그대로");
  assert.equal(r.TMPV7, 321108811);
  assert.equal(r.TMPV8, 0);
});

test("복원값은 상위 6자리를 보존한다 (조원 환산 오차 무시 가능)", () => {
  // 신용융자 유가 2026-07-07 실측: 앵커 29.074973조, 허용오차 0.05
  const raw = '{"ds1":[{"TMPV1":"20260707","TMPV3":363437#######}]}';
  const j = parseKofiaJson(raw, "test") as { ds1?: Array<Record<string, number>> };
  const jo = Number(j.ds1?.[0].TMPV3) / (1e12 / 8);
  assert.ok(Math.abs(jo - 29.074973) < 0.05, `복원값 ${jo}조가 앵커 허용오차를 벗어남`);
});

test("마스킹이 없는 정상 응답은 그대로 통과한다", () => {
  const raw = '{"unit":"","ds1":[{"TMPV1":"20260707","TMPV6":900946300,"TMPV7":0.7}]}';
  const j = parseKofiaJson(raw, "test") as { ds1?: Array<Record<string, number | string>> };
  assert.equal(j.ds1?.[0].TMPV6, 900946300);
  assert.equal(j.ds1?.[0].TMPV7, 0.7);
});

test("문자열 안의 # 은 건드리지 않는다", () => {
  const raw = '{"note":"a#b###c","ds1":[{"TMPV1":"20260707","TMPV3":123456###}]}';
  const j = parseKofiaJson(raw, "test") as { note: string; ds1: Array<Record<string, number>> };
  assert.equal(j.note, "a#b###c");
  assert.equal(j.ds1[0].TMPV3, 123456000);
});

test("배열 원소 위치의 마스킹도 복원한다", () => {
  const raw = '{"ds1":[{"v":[123456#####,7]}]}';
  const j = parseKofiaJson(raw, "test") as { ds1: Array<{ v: number[] }> };
  assert.deepEqual(j.ds1[0].v, [12345600000, 7]);
});

test("음수 마스킹도 복원한다", () => {
  const raw = '{"ds1":[{"TMPV3":-123456####}]}';
  const j = parseKofiaJson(raw, "test") as { ds1: Array<Record<string, number>> };
  assert.equal(j.ds1[0].TMPV3, -1234560000);
});

test("제어문자·후행 쉼표가 섞여도 복구한다", () => {
  const raw = '{"ds1":[{"TMPV1":"20260707","TMPV3":123456###,},]}';
  const j = parseKofiaJson(raw, "test") as { ds1: Array<Record<string, number | string>> };
  assert.equal(j.ds1[0].TMPV3, 123456000);
});

test("HTML 에러 페이지는 원인이 드러나는 메시지로 throw한다", () => {
  assert.throws(() => parseKofiaJson("<!DOCTYPE html><html><title>오류</title></html>", "test"), /JSON이 아닙니다/);
});

test("복구 불가능한 깨진 JSON은 위치를 담아 throw한다", () => {
  assert.throws(() => parseKofiaJson('{"ds1":[{"a":1 "b":2}]}', "test"), /파싱 실패/);
});

test("restoreMaskedDigits는 복원 개수를 센다", () => {
  const { text, count } = __test.restoreMaskedDigits('{"a":12##,"b":3,"c":45###}');
  assert.equal(count, 2);
  assert.equal(text, '{"a":1200,"b":3,"c":45000}');
});
