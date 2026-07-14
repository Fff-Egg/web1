# K-공포지수 — 권장 비중(사이징) 검증 명세 (v3)

> 화면의 **"권장 비중 N%"**가 어떻게 나오는지 코드와 1:1 대조. **우선순위 ①→②→③**:
> 코스닥 단독=0% → STRONG=100%(depth 무시) → 그 외 depth×계수. 계산 함수 =
> `src/client/pages/kfear.ts`의 `computeSizing()`. 검증 = §3 진리표(유닛테스트 T1~T12).

---

## 1. 공식 (코드 그대로 · v3)

```ts
// kfear.ts
export const GRADE_COEF = { STRONG: 1.0, BUY: 0.75, ARMED: 0.65, WATCH: 0.45, IDLE: 0 };
export const KOSDAQ_SOLO_CAP = 0;   // 코스닥 단독 = 0% (v2의 30% 상한을 개정)

function depthBasePct(creditDd):            // 신용 낙폭(DD) → 기준 비중 %
  dd ≤ −0.25 → 100 · dd ≤ −0.15 → 70 · dd ≤ −0.08 → 40 · else → 20

computeSizing(grade, creditDd, isSolo):     // isSolo = 코스닥 & 코스피 미동반
  base = depthBasePct(creditDd)
  coef = GRADE_COEF[grade]
  if isSolo:            return { pct: 0,   base, coef, path: "SOLO" }      // ① 최우선(등급 무관)
  if grade == "STRONG": return { pct: 100, base, coef, path: "OVERRIDE" } // ② depth 무시
  return { pct: round(base × coef), base, coef, path: "LADDER" }          // ③ 일반 사다리
```

- **우선순위 ①→②→③ 엄수**: 코스닥 단독 STRONG은 ①에서 0%(②의 100% 아님).
- **등급**(STRONG/BUY/ARMED/WATCH/IDLE) = FEAR≥90 + 신호 충족 수(`phase()`).
- **STRONG 오버라이드**: depth 단계 건너뛰고 즉시 100%(3신호 동시=청산 클라이맥스, 1달 최악 −1%·n=10).
- **코스닥 단독**: 등급과 무관하게 0%(관찰). 코스피 동반 시 SYSTEMIC 자동 승격.
- `round`는 JS `Math.round`: 52.5→53, 45.5→46, 31.5→32.

---

## 2. 계수 근거 (백테스트 2020~ 통합, n=10~31)

| 등급 | n | 6달 평균 | 계수 |
|---|---|---|---|
| STRONG (FEAR90 & 3신호) | 10 | +20.3% | **1.0** |
| BUY (FEAR90 & 2신호) | 19 | +16.7% | **0.75** |
| ARMED (FEAR90 & ≤1신호) | 17 | +13.5% | **0.65** |
| WATCH (2신호 & FEAR<90) | 31 | +11.5% | **0.45** |
| IDLE | — | — | **0** |

동반: SYSTEMIC(코스피 동반) 6달 +25%·승률 80% → 정상 / KOSDAQ_ONLY(단독) 6달 +0.5%·승률 50%(n=5)=기대값 0 → **0%(관찰)**. (v2는 30% 상한이었으나 "보상 없는 리스크"라 v3에서 0으로 개정 — 동반 시 SYSTEMIC 자동 승격 경로가 있어 구조적 미스 없음.)

**STRONG override**: STRONG 1달 최악 −1%(n=10) — 3신호 동시 = 청산 클라이맥스라 진입 후 추가 하락 거의 없음 → 사다리 대기 트랜치가 유휴 현금만 까먹음 → depth 무시 100%. 반면 **BUY 1달 최악 −22%**(n=19)라 사다리(depth)가 방어 장치로 실제 작동 → BUY 이하만 사다리 유지.

⚠️ **방향성(STRONG>BUY>ARMED>WATCH)만 신뢰구간**. 계수 소수점은 노이즈 — 어느 등급이든 6달 +11~20%(전부 플러스).

---

## 3. 검증 진리표 (유닛테스트 T1~T12 · 코드 실행값과 대조)

### ③ 일반 사다리 (코스피/동반, STRONG 아님) — `pct = round(base × coef)`

| 등급 (coef) | DD −30%·base100 | −20%·base70 | −10%·base40 | −5%·base20 |
|---|---|---|---|---|
| BUY (0.75) | **75** | 52.5→**53** | **30** | **15** |
| ARMED (0.65) | **65** | 45.5→**46** | **26** | **13** |
| WATCH (0.45) | **45** | 31.5→**32** | **18** | **9** |
| IDLE (0) | 0 | 0 | 0 | 0 |

### ② STRONG 오버라이드 — depth 무시, 항상 **100** (path=OVERRIDE)

| 케이스 | 결과 | 비고 |
|---|---|---|
| STRONG · DD −30% | **100** | depth 100 아님 — 오버라이드라 무관 |
| STRONG · DD −8% | **100** | ⚠️ 구 로직은 40(=20×… 아님, base40×1.0)이었으나 v3는 100 |
| STRONG · DD −5% | **100** | 구: base20×1.0=20 → v3: 100 |

### ① 코스닥 단독(코스피 미동반) — 등급 무관 **0** (path=SOLO, 최우선)

| 케이스 | 결과 | 비고 |
|---|---|---|
| 코스닥 STRONG · DD −33% · 단독 | **0** | ①이 ②보다 우선 (100 아님) |
| 코스닥 BUY · DD −20% · 단독 | **0** | 등급 무관 |
| 코스닥 STRONG · DD −33% · **동반** | **100** | 동반이면 ②로 → OVERRIDE |

### §9 유닛테스트 앵커 (T1~T12, 전부 통과)

| # | 입력 (grade, DD, isSolo) | 기대 (pct, path) |
|---|---|---|
| T1 | STRONG, −8%, F | **100, OVERRIDE** (40 아님) |
| T2 | STRONG, −33%, F | 100, OVERRIDE |
| T3 | BUY, −8%, F | **30, LADDER** (40×0.75) |
| T4 | BUY, −7%, F | **15, LADDER** (20×0.75 — 현재 코스피 계열) |
| T5 | ARMED, −20%, F | 46, LADDER (70×0.65) |
| T6 | WATCH, −15%, F | 32, LADDER (70×0.45) |
| T7 | STRONG, −33%, **T**(단독) | **0, SOLO** (①>②) |
| T8 | STRONG, −33%, F(동반) | 100, OVERRIDE |
| T9 | IDLE, −5%, F | 0, LADDER |
| T10 | classify: (92,3)=STRONG · (92,2)=BUY · (92,0)=ARMED · (85,2)=WATCH · (85,1)=IDLE | 등급 판정 |
| T11 | depth: −26→100 · −20→70 · −11→40 · −5→20 | 계단 경계 |
| **T12** | **회귀**: 코스피 ARMED −5.8%→13% · 코스닥 BUY 동반 −31.6%→75% | 현재 화면 불변 |

### 경계값 (depth 계단, 보간 없음)

| creditDd | base% | 이유 |
|---|---|---|
| −0.25 (정확) | 100 | `dd ≤ −0.25` 포함 |
| −0.2499 | 70 | −0.25 미달 → 다음 구간 |
| −0.15 (정확) | 70 | `dd ≤ −0.15` |
| −0.08 (정확) | 40 | `dd ≤ −0.08` |
| −0.079 | 20 | −0.08 미달 |
| null (신용 없음) | 20 | 기본 소액 |

---

## 4. 직접 검증 방법

1. **유닛테스트**: 위 T1~T12는 `computeSizing`/`phase` 유닛테스트로 검증됨(scratchpad `v3_sizing_test.ts`·`v3_classify_test.ts`).
2. **코드 대조**: `kfear.ts`의 `GRADE_COEF`·`KOSDAQ_SOLO_CAP`(=0)·`depthBasePct`·`computeSizing`(①→②→③)이 위 §1과 일치하는지.
3. **화면 대조**: STRONG=`100% · STRONG→depth 무시`, BUY/ARMED/WATCH=`depth B% × 등급 G C`, 코스닥 단독=`0% · 관찰—코스피 동반 대기`. depth 사다리는 STRONG/단독에서 전체 회색+캡션.
4. **T12 회귀**: 현재 라이브 등급(ARMED/BUY 동반)의 숫자는 v3 후에도 불변 — 바뀌면 버그.

> ⚠️ 이 계수·상한은 소표본 백테스트 기반의 **참고 가이드이며 투자 권유가 아니다.** 방향성은
> 신뢰하되 정밀 수치는 노이즈로 간주. 모든 판단과 결과는 사용자 책임.
