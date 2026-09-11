# K-공포지수 — 권장 비중(사이징) 검증 명세 (v4)

> 화면의 **"권장 비중 N%"**가 어떻게 나오는지 코드와 1:1 대조. **우선순위 ①→②**:
> 코스닥 단독=0% → 등급 기본비중 × 이중 얕음게이트. depth 4단 사다리는 v4에서 **폐지**.
> 계산 함수 = `src/client/pages/kfear.ts`의 `computeSizing()`. 검증 = §3 진리표(T1~T12).

---

## 1. 공식 (코드 그대로 · v4)

```ts
// kfear.ts
export const GRADE_WEIGHT = { STRONG: 100, BUY: 60, ARMED: 50, WATCH: 45, IDLE: 0 };
export const KOSDAQ_SOLO_CAP = 0;   // 코스닥 단독 = 0%
const SHALLOW_CREDIT = -8;  const SHALLOW_DISP = -7;   // 이중 게이트 임계

shallowGate(creditDd, dispDev):     // 둘 다 얕으면 ×0.5, 아니면 ×1.0
  creditShallow = creditDd*100 > -8   (null이면 얕음)
  dispShallow   = dispDev     > -7    (null이면 얕음)
  return (creditShallow && dispShallow) ? 0.5 : 1.0

computeSizing(grade, creditDd, dispDev, isSolo):
  weight = GRADE_WEIGHT[grade]
  if isSolo:       return { pct: 0, weight, gate: 1, path: "SOLO" }   // ① 최우선
  if weight == 0:  return { pct: 0, weight, gate: 1, path: "NONE" }   // IDLE
  gate = shallowGate(creditDd, dispDev)
  return { pct: round(weight × gate), weight, gate, path: gate<1 ? "GATED" : "FULL" }
```

- **우선순위 ①→② 엄수**: 코스닥 단독 STRONG은 ①에서 0%.
- **depth 사다리 폐지**: FEAR≥90 시점엔 신용이 이미 깊어(20건 중 18건 DD≤−8%) 4단 구분이 무의미.
- **등급은 신호개수**로: STRONG(3)·BUY(2)·ARMED(≤1)·WATCH(FEAR<90&2)·IDLE. ARMED는 BUY 아래 고정.
- **이중 게이트**: 신용·이격도 무상관(−0.04) 독립정보. **둘 다** 얕아야 ×0.5(가짜바닥). STRONG도 적용.

---

## 2. 근거 (백테스트 2018~2026, n=15~20 병합이벤트)

| 등급 | n | 6달 | 승률 | 1달 |
|---|---|---|---|---|
| STRONG(3신호) | 16 | +19.5% | 81% | +5.2% |
| BUY(2신호) | 14 | +12.7% | 79% | +1.7% |
| ARMED(1신호) | 11 | +15.5% | 91% | +3.5% |

⚠️ ARMED 승률 91%는 n=11 착시 가능 — 1달 수익(3>2>1신호) 기준 STRONG>BUY는 견고하나 BUY↔ARMED 우열 단정 불가 → **ARMED를 BUY 아래(50<60)에 고정**.

**이중 게이트 (신용/이격도 교차):** 둘 다 얕음 n=1 +5.6% / **하나만 얕음 n=4 +23.8%** / 둘 다 깊음 n=15 +12.8%. → "하나만 얕음"은 오히려 최고라 **안 깎음**, "둘 다 얕음"만 ×0.5.

**반대매매 절대금액화**: 비중(÷미수금)은 분모 왜곡(2023-10 미수금 부풀어 69%, 2025-04 예탁금 많아 1.8% 희석). 절대금액 분위수는 왜곡 없음(단독 신호 비중 +16.4% vs 금액 +19.6%). F2·S2 모두 금액.

**시스템 비교**: 현행(비중 F2 / depth 4단) 6달 +11.5% → **v4(절대금액 / 신호등급 / 이중게이트) +16.3%**. 진입 33→20회로 줄며 성과 상승 = 헛신호 제거.

---

## 3. 검증 진리표 (유닛테스트 T1~T12, 전부 통과)

`pct = round(GRADE_WEIGHT[grade] × gate)`. gate = 0.5 if (신용>−8% AND 이격>−7%) else 1.0.

| # | 입력 (grade, creditDd, dispDev, isSolo) | 기대 (pct, path) | 포인트 |
|---|---|---|---|
| T1 | STRONG, −33%, −20%, F | **100, FULL** | 3신호 |
| T2 | BUY, −33%, −20%, F | **60, FULL** | 2신호 |
| T3 | ARMED, −33%, −20%, F | **50, FULL** | 1신호 |
| T4 | WATCH, −20%, −15%, F | **45, FULL** | FEAR<90&2신호 |
| T5 | BUY, **−5%, −3%**, F | **30, GATED** | 둘 다 얕음 60×0.5 |
| T6 | BUY, **−5%, −15%**, F | **60, FULL** | 이격 깊음 → 하나만 얕음 → **안 깎음** |
| T7 | STRONG, **−5%, −3%**, F | **50, GATED** | 얕은 STRONG도 게이트(100×0.5) |
| T8 | STRONG, −33%, −20%, **T**(단독) | **0, SOLO** | ① 우선 |
| T9 | STRONG, −33%, −20%, F(동반) | **100, FULL** | 동반 정상 |
| T10 | IDLE, −5%, −3%, F | **0, NONE** | 비중0이면 게이트 무의미 |

**T5·T6 대비가 핵심**: 신용 같은 −5%라도 이격도가 깊으면(T6) 안 깎고, 둘 다 얕아야(T5) 깎음.

**T11 classify**: (92,3)=STRONG · (92,2)=BUY · (92,1)=ARMED · (85,2)=WATCH · (85,1)=IDLE.
**T12 shallowGate**: (−5,−3)=0.5 · (−5,−15)=1.0 · (−15,−3)=1.0 · (−15,−15)=1.0.

---

## 4. 직접 검증 방법

1. **유닛테스트**: T1~T12 = scratchpad `v4_test.ts`(`computeSizing`/`phase`/`shallowGate`), S2/F2 금액·폴백 = `v4_s2_test.ts`.
2. **코드 대조**: `GRADE_WEIGHT`·`SHALLOW_CREDIT/DISP`·`shallowGate`·`computeSizing`(①→②)이 §1과 일치.
3. **화면 대조**: 권장비중 하단 `[등급] N × 게이트 G`, 이중게이트 칩(신용/이격 얕음·깊음), GATED 시 `⚠️ 둘 다 얕음 → ×0.5`. depth 사다리 UI 없음. S2(v5) = "정점 상위X% (M/D·N일전) · 2일 연속↓ 충족".

> ⚠️ n=15~20 소표본 — 방향성만 신뢰(STRONG>BUY 견고, ARMED 승률 착시 가능), 게이트 각 칸 1~4건이라 정밀 계수는 노이즈. "100%"는 이 시스템 배정 예비대의 100%지 전체 몰빵 아님. 투자 권유 아님.
