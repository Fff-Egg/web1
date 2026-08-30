/**
 * KOFIA FreeSIS `getMetaDataList.do` 응답 파싱.
 *
 * ⚠️ **자릿수 마스킹(`#`) 복원** — 2026-07 실측으로 확인된 게이트웨이 동작 변경.
 * 큰 잔고 값의 하위 자릿수를 `#`로 덮어서 돌려준다(엑셀 열이 좁을 때 `####` 뜨는 것과 같은
 * 고정폭 표시 아티팩트). JSON 문법 위반이라 `res.json()`이 통째로 throw했고, 그래서
 * 신용잔고·반대매매 두 소스가 "Expected ',' or '}' at position 52/53"으로 죽어 있었다.
 *
 *   {"TMPV2":409365#######,"TMPV3":322982#######,"TMPV5":3241104916,...}
 *                    ^^^^^^^ 하위 7자리가 마스킹됨(상위 6자리는 살아있음)
 *
 * **파라미터로는 못 피한다**(실측): `tmpV40`은 필수인데(빼면 전 컬럼 null) `02`~`12` × `tmpV41`
 * `1`~`4` 조합을 전수로 훑어도 전부 동일하게 마스킹되거나 에러 페이지가 온다. 서버 쪽 변경이라
 * 클라에서 복원하는 수밖에 없다.
 *
 * **복원 = `#` → `0`**. 상위 6자리(유효숫자 6)가 보존되므로 조원 단위 표시·분위수 계산에는
 * 영향이 없다. 실측 검증(2026-07): HARD 앵커 3개가 전부 허용오차 안에 재현됐다 —
 *   신용융자 유가 07-07  29.074960조 (기대 29.074973, 차이 1.3e-5, 허용 0.05) ✅
 *   신용융자 코스닥 07-07  7.990416조 (기대  7.990423, 차이 7.0e-6, 허용 0.05) ✅
 *   신용융자 전체 06-24  38.632800조 (기대 38.632824, 차이 2.4e-5, 허용 0.10) ✅
 * 마스킹 토큰 72개 전부 "숫자 + 뒤에 `#`만" 형태였다(패턴 위반 0건).
 */

/** 마스킹된 숫자를 복원한다: JSON 값 위치(`:` `,` `[` 뒤)의 `숫자#####` → `숫자00000`.
 *  문자열 값은 `"`로 시작하므로 매치되지 않는다(날짜 `"20260723"` 등이 안전). */
function restoreMaskedDigits(raw: string): { text: string; count: number } {
  let count = 0;
  const text = raw.replace(/([:,[]\s*-?\d+)(#+)/g, (_m, head: string, hashes: string) => {
    count++;
    return head + "0".repeat(hashes.length);
  });
  return { text, count };
}

/** JSON에서 못 쓰는 제어문자(0x00~0x1F, `\t\n\r` 제외) 제거 + 후행 쉼표 정리. */
function stripJunk(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x1f && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    out += raw[i];
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseKofiaJson(raw: string, label: string): { ds1?: unknown[] } {
  // 게이트웨이가 세션 만료 등에 HTML 에러 페이지를 200으로 돌려주기도 한다 — 먼저 걸러
  // "JSON 파싱 실패"가 아니라 원인이 드러나는 메시지를 남긴다.
  if (!raw.trimStart().startsWith("{")) {
    console.error(`[kofia:${label}] JSON이 아닌 응답(앞 200자): ${JSON.stringify(raw.slice(0, 200))}`);
    throw new Error(`KOFIA(${label}) 응답이 JSON이 아닙니다 (HTML 에러 페이지일 수 있음, ${raw.length}바이트)`);
  }

  // 정상 경로: 마스킹이 없으면 그대로 파싱된다.
  try {
    return JSON.parse(raw) as { ds1?: unknown[] };
  } catch (firstErr) {
    const { text, count } = restoreMaskedDigits(raw);
    if (count > 0) {
      try {
        const j = JSON.parse(text) as { ds1?: unknown[] };
        // 상시 로그 — 마스킹은 정상이 아니라 '복원해서 쓰는 중'이라는 사실이 보여야 한다.
        console.warn(`[kofia:${label}] 자릿수 마스킹(#) ${count}개 복원 후 파싱 성공 — 상위 6자리 유효, 하위는 0으로 채움`);
        return j;
      } catch {
        /* 마스킹 외 다른 문제도 섞여 있음 → 아래 2차 복구 */
      }
    }
    // 2차: 제어문자·후행 쉼표까지 정리해 재시도.
    const cleaned = stripJunk(text);
    if (cleaned !== raw) {
      try {
        const j = JSON.parse(cleaned) as { ds1?: unknown[] };
        console.warn(`[kofia:${label}] 정규화(마스킹 ${count}개 + 제어문자/후행쉼표) 후 파싱 성공`);
        return j;
      } catch {
        /* 복구 실패 → 아래 throw */
      }
    }
    const pos = errPos(firstErr);
    const snip = pos !== null ? raw.slice(Math.max(0, pos - 40), pos + 40) : raw.slice(0, 160);
    console.error(`[kofia:${label}] JSON 파싱 실패 @${pos ?? "?"} (len ${raw.length}, 마스킹 ${count}개) 주변: ${JSON.stringify(snip)}`);
    console.error(`[kofia:${label}] 원본 앞 200자: ${JSON.stringify(raw.slice(0, 200))}`);
    throw new Error(
      `KOFIA(${label}) JSON 파싱 실패 @${pos ?? "?"}: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}`,
    );
  }
}

function errPos(e: unknown): number | null {
  const m = e instanceof Error ? /position (\d+)/.exec(e.message) : null;
  return m ? Number(m[1]) : null;
}

export const __test = { restoreMaskedDigits, stripJunk };
