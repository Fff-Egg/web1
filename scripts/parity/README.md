# K-공포지수 — 파이썬 레퍼런스 ↔ TS 포트 수치 파리티 검증

`src/client/pages/kfear.ts`(TS 포트)가 검증된 파이썬 레퍼런스
(`capitulation_backtest.py` / `fear_index.py`)와 **숫자까지 일치**하는지 대조한다.
동일한 합성 입력을 양쪽에 넣고 전 시리즈·전 성분을 element-by-element로 비교.

## 실행

```bash
pip install pandas numpy
python3 scripts/parity/parity_ref.py      # 레퍼런스 출력 → parity_data.json
npx tsx scripts/parity/parity_ts.ts       # TS 포트 재계산 → 대조
```

## 무엇을 검증하나
- `rollStd(logret,20)×√252×100` = rv — **표본표준편차 ddof=1** 일치
- `rollPct` — 252일 롤링 분위수(self-inclusive, min_periods=win) 일치
- `rollMax`(mp=200)·`rollMean`(60)·`pctChange`(10) 일치
- `credit_dd`·`disp`·`disp_pct`·`F1`~`F4`·`FEAR`(skipna 평균) 일치
- `buildMarket` 최신행의 S1/S2/S3/n_on/creditDd/FEAR = 레퍼런스 `iloc[-1]`

## 최종 결과 (2026-07 검증)
**전 항목 maxΔ = 0.00e+0 (bit-exact 일치, tol 1e-6).**
→ std ddof·분위수·pct_change·FEAR 공식까지 파이썬 레퍼런스와 소수점 끝까지 동일.

> 주의: 타임스탬프 규약(KST 정렬)은 *계산*이 아니라 *데이터 정렬(ingestion)* 문제라 이
> 파리티와 독립적이다 — `kfear.ts`의 `kstDay` 정규화 + `koreaIndexes.ts`의 진단 로그로 별도 확인.
