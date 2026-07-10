import type { SeriesPoint } from "../../shared/market.js";
import { sliceLastYear } from "../../shared/market.js";
import { fetchCloses } from "./tradingview.js";

/**
 * US 진입신호 실행기 입력 시계열 (US_진입신호_CLAUDE_CODE 지시서 v1.0).
 *
 * 나스닥 진입신호는 합성지수가 아니라 **절대값 2트랙**이다:
 *   TERM = VIX 종가 / VIX3M 종가 (같은 거래일)
 *   A(주 진입)     : TERM ≥ 1.05
 *   B(강 신호)     : TERM ≥ 1.00 AND HY OAS ≥ 4.5%
 *   MEGA 배지      : VIX ≥ 40
 *
 * 필요 데이터는 3개 시계열(VIX·VIX3M·HY OAS)뿐이고 전부 TradingView 차트 WS 미러로
 * 수집한다(S5FI/NDFI·FRED 순유동성과 동일 파이프, Railway 검증됨). 판정·상태머신은
 * 클라(usEntry.ts)가 저장된 히스토리로 계산한다(K-공포지수와 동일 구조, 추가 LLM 없음).
 *   VIX   = TVC:VIX  (폴백 CBOE:VIX / FRED:VIXCLS)
 *   VIX3M = CBOE:VIX3M  (폴백 TVC:VIX3M, 구명칭 VXV)
 *   HY    = FRED:BAMLH0A0HYM2  (ICE BofA US High Yield OAS, %p, T+1 — 클라에서 shift(1))
 *   IXIC  = NASDAQ:IXIC  (신호엔 불필요, 첫 발동가 대비 나스닥 등락률·성과추적용)
 */

const VIX_SYMBOLS = ["TVC:VIX", "CBOE:VIX", "FRED:VIXCLS"];
const VIX3M_SYMBOLS = ["CBOE:VIX3M", "TVC:VIX3M"];
const HY_SYMBOLS = ["FRED:BAMLH0A0HYM2"];
const IXIC_SYMBOLS = ["NASDAQ:IXIC", "TVC:IXIC"];
const DAYS = 1200; // TERM/HY 추이 차트 + 21거래일 에피소드 병합에 충분한 뒷꼬리.

async function firstWithData(symbols: string[], timeoutMs: number): Promise<SeriesPoint[]> {
  for (const sym of symbols) {
    const pts = await fetchCloses(sym, timeoutMs).catch(() => [] as SeriesPoint[]);
    if (pts.length > 0) return sliceLastYear(pts, DAYS);
  }
  return [];
}

export async function fetchUsEntry(
  timeoutMs = 22_000,
): Promise<{ vix: SeriesPoint[]; vix3m: SeriesPoint[]; hyOas: SeriesPoint[]; ixic: SeriesPoint[] }> {
  const [vix, vix3m, hyOas, ixic] = await Promise.all([
    firstWithData(VIX_SYMBOLS, timeoutMs),
    firstWithData(VIX3M_SYMBOLS, timeoutMs),
    firstWithData(HY_SYMBOLS, timeoutMs),
    firstWithData(IXIC_SYMBOLS, timeoutMs),
  ]);
  // 진단(Railway 로그): 최신 TERM/HY/VIX — §4-4 스냅샷 앵커(2026-07-09 VIX 15.85·TERM
  // 0.835·HY 2.70) 대조용. 심볼이 바뀌거나 값이 어긋나면 여기서 먼저 드러난다.
  const lastV = vix.at(-1);
  const last3 = vix3m.at(-1);
  const lastH = hyOas.at(-1);
  if (lastV && last3 && last3.v > 0) {
    const term = lastV.v / last3.v;
    const d = new Date(lastV.t).toISOString().slice(0, 10);
    console.log(`[usEntry] VIX=${lastV.v} VIX3M=${last3.v} TERM=${term.toFixed(3)} HY=${lastH?.v ?? "—"} (${d})`);
  } else {
    console.warn(`[usEntry] VIX/VIX3M 수집 실패 — vix=${vix.length} vix3m=${vix3m.length} hy=${hyOas.length}`);
  }
  return { vix, vix3m, hyOas, ixic };
}
