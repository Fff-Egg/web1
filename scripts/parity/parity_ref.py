# 레퍼런스(capitulation_backtest.py / fear_index.py) 핵심 함수를 그대로 옮겨,
# 합성 데이터로 기준 출력을 뽑아 JSON으로 덤프. TS 포트가 이 숫자와 일치하는지 대조.
import json
import os
import numpy as np
import pandas as pd

# ── 레퍼런스 상수/함수 (원본 그대로) ──
PCT_WIN, SPIKE_LOOKBACK, SPIKE_PCT = 252, 6, 0.95
CREDIT_DD, CREDIT_10D = -0.08, -0.03
DISP_N, DISP_ABS, DISP_PCT = 60, 92.0, 0.05

def roll_pct(s, win=PCT_WIN):
    return s.rolling(win, min_periods=win).apply(lambda w: (w <= w[-1]).mean(), raw=True)

# ── 합성 입력 (결정적) ──
n = 400
rng = np.arange(n)
ret = 0.0005 + 0.004 * np.sin(rng / 11.0) + 0.002 * np.cos(rng / 5.0)
ret[-15:] = -0.03                         # 마지막 15일 급락
idx = pd.date_range("2024-01-01", periods=n, freq="D")
px = pd.Series(2000.0 * np.exp(np.cumsum(ret)), index=idx)

credit_v = 15 + 3 * np.sin(rng / 40.0)
for i in range(n - 15, n):                # 마지막 15일 신용 언와인드
    credit_v[i] = credit_v[i - 1] * 0.985
credit = pd.Series(credit_v, index=idx)

liq_v = 2 + 0.8 * np.sin(rng / 7.0)
liq_v[-15:] = [7, 6.5, 6, 5, 4.5, 4, 3.5, 3, 2.8, 2.6, 2.4, 2.2, 2.1, 2.0, 1.9]  # 스파이크→하락
liq = pd.Series(liq_v, index=idx)

# ── 레퍼런스 계산 (build_signals / build_fear 그대로) ──
c = credit.reindex(px.index).ffill()
peak = c.rolling(PCT_WIN, min_periods=200).max()
credit_dd = c / peak - 1
credit_10d = c.pct_change(10)
idx_10d = px.pct_change(10)
S1 = (credit_dd <= CREDIT_DD) & (credit_10d <= CREDIT_10D) & (idx_10d < 0)

l = liq.reindex(px.index).ffill()
liq_pct = roll_pct(l)
spike = (liq_pct >= SPIKE_PCT).rolling(SPIKE_LOOKBACK, min_periods=1).max().astype(bool)
decl2 = (l < l.shift(1)) & (l.shift(1) < l.shift(2))
S2 = spike & decl2

disp = px / px.rolling(DISP_N).mean() * 100
disp_pct = roll_pct(disp)
S3 = (disp <= DISP_ABS) | (disp_pct <= DISP_PCT)

n_on = S1.astype(int) + S2.astype(int) + S3.astype(int)

# FEAR (fear_index.build_fear 그대로)
f1 = 1 - roll_pct(credit.reindex(px.index).ffill().pct_change(10))
f2 = roll_pct(liq.reindex(px.index).ffill())
f3 = 1 - roll_pct(disp)
rv = np.log(px).diff().rolling(20).std() * np.sqrt(252) * 100     # 기본 ddof=1
f4 = roll_pct(rv)
FEAR = pd.concat([f1, f2, f3, f4], axis=1).mean(axis=1) * 100      # skipna 평균


def L(s):  # NaN → None (JSON)
    return [None if (v is None or (isinstance(v, float) and np.isnan(v))) else float(v) for v in np.asarray(s, dtype=float)]


out = {
    "input": {"px": L(px), "credit": L(credit), "liq": L(liq)},
    "ref": {
        "peak": L(peak), "credit_dd": L(credit_dd), "credit_10d": L(credit_10d), "idx_10d": L(idx_10d),
        "liq_pct": L(liq_pct), "disp": L(disp), "disp_pct": L(disp_pct), "rv": L(rv),
        "f1": L(f1), "f2": L(f2), "f3": L(f3), "f4": L(f4), "FEAR": L(FEAR),
        "ma60": L(px.rolling(60).mean()),
        "S1": [bool(x) for x in S1], "S2": [bool(x) for x in S2], "S3": [bool(x) for x in S3],
        "n_on": [int(x) for x in n_on],
    },
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "parity_data.json")
with open(path, "w") as fh:
    json.dump(out, fh)
print("ref dumped:", path)
print("last row — credit_dd %.6f  FEAR %.6f  rv %.6f  S1 %s S2 %s S3 %s n_on %d"
      % (credit_dd.iloc[-1], FEAR.iloc[-1], rv.iloc[-1], bool(S1.iloc[-1]), bool(S2.iloc[-1]), bool(S3.iloc[-1]), int(n_on.iloc[-1])))
