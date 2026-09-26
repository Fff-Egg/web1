// 파이썬 레퍼런스가 뽑은 parity_data.json의 입력을 TS 포트 헬퍼로 재계산해
// element-by-element로 대조. std ddof·percentile·min_periods·pct_change·FEAR 공식이
// 숫자까지 일치하는지 검증.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { __test, computeKFear } from "../../src/client/pages/kfear.js";

const { rollPct, rollStd, rollMean, rollMax, pctChange, meanSkip } = __test;
const P = join(dirname(fileURLToPath(import.meta.url)), "parity_data.json");
const data = JSON.parse(readFileSync(P, "utf8"));
const px: number[] = data.input.px;
const credit: number[] = data.input.credit;
const liq: number[] = data.input.liq;
const R = data.ref;

let fails = 0;
const near = (a: number | null, b: number | null, tol: number) => {
  const an = a === null || (typeof a === "number" && Number.isNaN(a));
  const bn = b === null || (typeof b === "number" && Number.isNaN(b));
  if (an && bn) return true; // NaN ↔ null 일치
  if (an !== bn) return false; // 한쪽만 NaN → 불일치
  return Math.abs((a as number) - (b as number)) <= tol;
};
function cmp(name: string, ts: (number | null)[], ref: (number | null)[], tol = 1e-6) {
  if (ts.length !== ref.length) { fails++; console.log(`FAIL ${name}: length ${ts.length} vs ${ref.length}`); return; }
  let maxd = 0, bad = -1, nanMismatch = 0;
  for (let i = 0; i < ref.length; i++) {
    if (!near(ts[i], ref[i], tol)) {
      const an = ts[i] === null || Number.isNaN(ts[i] as number);
      const bn = ref[i] === null;
      if (an !== bn) nanMismatch++;
      else { const d = Math.abs((ts[i] as number) - (ref[i] as number)); if (d > maxd) { maxd = d; bad = i; } }
    }
  }
  if (maxd > tol || nanMismatch > 0) {
    fails++;
    console.log(`FAIL ${name}: maxΔ=${maxd.toExponential(3)} @${bad} (ts=${ts[bad]}, ref=${ref[bad]}) · NaN불일치=${nanMismatch}`);
  } else {
    console.log(`ok   ${name}: maxΔ=${maxd.toExponential(2)} (n=${ref.length})`);
  }
}

const n = px.length;
// creditA = credit (같은 날짜라 정렬 후 동일)
const peak = rollMax(credit, 252, 200);
const creditDd = credit.map((c, i) => (Number.isFinite(c) && Number.isFinite(peak[i]) && peak[i] !== 0 ? c / peak[i] - 1 : NaN));
const credit10d = pctChange(credit, 10);
const idx10d = pctChange(px, 10);
const liqPct = rollPct(liq, 252);
const ma60 = rollMean(px, 60);
const disp = px.map((p, i) => (Number.isFinite(ma60[i]) && ma60[i] !== 0 ? (p / ma60[i]) * 100 : NaN));
const dispPct = rollPct(disp, 252);
const logret = new Array<number>(n).fill(NaN);
for (let i = 1; i < n; i++) if (px[i] > 0 && px[i - 1] > 0) logret[i] = Math.log(px[i] / px[i - 1]);
const rv = rollStd(logret, 20).map((v) => (Number.isFinite(v) ? v * Math.sqrt(252) * 100 : NaN));
const f1 = rollPct(credit10d, 252).map((v) => (Number.isFinite(v) ? 1 - v : NaN));
const f2 = liqPct;
const f3 = dispPct.map((v) => (Number.isFinite(v) ? 1 - v : NaN));
const f4 = rollPct(rv, 252);
const FEAR = new Array<number>(n).fill(NaN);
for (let i = 0; i < n; i++) { const m = meanSkip([f1[i], f2[i], f3[i], f4[i]]); if (Number.isFinite(m)) FEAR[i] = m * 100; }

// ── 원시 프리미티브 대조 ──
cmp("rollMax(credit,252,mp=200) = peak", peak, R.peak);
cmp("rollMean(px,60) = ma60", ma60, R.ma60);
cmp("pctChange(credit,10)", credit10d, R.credit_10d);
cmp("pctChange(px,10)", idx10d, R.idx_10d);
cmp("rollPct(liq) = liq_pct", liqPct, R.liq_pct);
cmp("rollStd(logret,20)×√252×100 = rv  [ddof=1]", rv, R.rv);
// ── 파생 대조 ──
cmp("credit_dd", creditDd, R.credit_dd);
cmp("disp", disp, R.disp);
cmp("disp_pct", dispPct, R.disp_pct);
cmp("F1", f1, R.f1);
cmp("F2", f2, R.f2);
cmp("F3", f3, R.f3);
cmp("F4", f4, R.f4);
cmp("FEAR", FEAR, R.FEAR);

// ── 신호 부울 대조 (마지막 행 = buildMarket 통합 확인) ──
const toPt = (a: number[]) => a.map((v, i) => ({ t: i * 86400000, v }));
const kf = computeKFear({ history: { kospiClose: toPt(px), kosdaqClose: toPt(px), creditKospi: toPt(credit), creditKosdaq: toPt(credit), forcedLiqRatio: toPt(liq) } } as any);
const last = n - 1;
const eqb = (name: string, a: unknown, b: unknown) => { if (a !== b) { fails++; console.log(`FAIL ${name}: ${a} vs ${b}`); } else console.log(`ok   ${name}: ${a}`); };
console.log("\n── buildMarket 최신행 vs 레퍼런스 iloc[-1] ──");
eqb("S1", kf.kospi.signals[0].met, R.S1[last]);
eqb("S2", kf.kospi.signals[1].met, R.S2[last]);
eqb("S3", kf.kospi.signals[2].met, R.S3[last]);
eqb("n_on", kf.kospi.nOn, R.n_on[last]);
console.log(`   creditDd: TS ${kf.kospi.creditDd?.toFixed(6)} vs ref ${R.credit_dd[last]?.toFixed(6)}`);
console.log(`   FEAR:     TS ${kf.kospi.fear?.toFixed(6)} vs ref ${R.FEAR[last]?.toFixed(6)}`);
if (!near(kf.kospi.creditDd, R.credit_dd[last], 1e-6)) { fails++; console.log("FAIL creditDd 최신행"); }
if (!near(kf.kospi.fear, R.FEAR[last], 1e-6)) { fails++; console.log("FAIL FEAR 최신행"); }

console.log(fails === 0 ? "\n✅ PARITY: 전 시리즈·전 성분 파이썬 레퍼런스와 일치 (tol 1e-6)" : `\n❌ ${fails} MISMATCH`);
process.exit(fails === 0 ? 0 : 1);
