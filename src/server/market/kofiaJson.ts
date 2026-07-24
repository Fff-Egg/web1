/**
 * KOFIA FreeSIS getMetaDataList.do 응답 파싱 — 게이트웨이가 가끔 깨진 JSON을 돌려주면
 * `res.json()`이 원본을 안 남기고 throw해 디버깅이 안 된다("Expected ',' or '}' at position N").
 * 여기서는 (1) 파싱 실패 시 **원본을 실패 위치 주변까지 로그**로 남기고,
 * (2) 흔한 malformation(문자열 안 raw 제어문자·값 뒤 후행 쉼표)을 손봐 한 번 더 시도한다.
 * 그래도 실패하면 원본 위치를 담아 throw(→ 소스별 catch가 직전 저장값 유지).
 */
export function parseKofiaJson(raw: string, label: string): { ds1?: unknown[] } {
  try {
    return JSON.parse(raw) as { ds1?: unknown[] };
  } catch (e) {
    const pos = errPos(e);
    const snip = pos !== null ? raw.slice(Math.max(0, pos - 40), pos + 40) : raw.slice(0, 160);
    console.error(
      `[kofia:${label}] JSON 파싱 실패 @${pos ?? "?"} (len ${raw.length}) 실패위치 주변: ${JSON.stringify(snip)}`,
    );
    console.error(`[kofia:${label}] 원본 앞 200자: ${JSON.stringify(raw.slice(0, 200))}`);
    const cleaned = sanitize(raw);
    if (cleaned !== raw) {
      try {
        const j = JSON.parse(cleaned) as { ds1?: unknown[] };
        console.warn(`[kofia:${label}] 정규화 후 복구 성공(${raw.length - cleaned.length}자 변경)`);
        return j;
      } catch {
        /* 복구 실패 → 아래 throw */
      }
    }
    throw new Error(
      `KOFIA(${label}) JSON 파싱 실패 @${pos ?? "?"}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * 흔한 KOFIA malformation 정규화:
 *  - 문자열 리터럴 안에 흘러든 raw 제어문자(0x00–0x1F, \t\n\r 제외) 제거
 *  - 값/원소 뒤 후행 쉼표(`,}` / `,]`) 제거
 * 둘 다 JSON 문법 위반이라 표준 파서가 죽지만 의미는 명확해 안전하게 손볼 수 있다.
 */
function sanitize(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    // 탭(9)·개행(10)·복귀(13)만 남기고 나머지 제어문자 제거.
    if (c <= 0x1f && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    out += raw[i];
  }
  // 후행 쉼표: `, }` / `, ]` (사이 공백 허용) → `}` / `]`.
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out;
}

function errPos(e: unknown): number | null {
  const m = e instanceof Error ? /position (\d+)/.exec(e.message) : null;
  return m ? Number(m[1]) : null;
}
