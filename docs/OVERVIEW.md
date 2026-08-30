# Feed Watch — 앱 전체 개요 (Claude 컨텍스트용)

> 개인 투자 정보 **수집·분석·다이제스트** 대시보드. 여러 소스의 글을 자동 수집·1차 분석하고,
> 하루 2번 다이제스트로 종합하며, 시장 공포·진입 신호를 실시간 계산한다.
> 이 문서는 Claude에게 앱 전체를 설명해 개선을 돕게 하려는 컨텍스트 브리프다.
> (더 상세한 인수인계는 리포의 `CLAUDE.md` 참조.)

---

## 1. 한 줄 요약 & 기술 스택

TypeScript 단일 리포의 **풀스택 모노리스**. React SPA 프론트 + Express/tRPC 백엔드가 한 프로세스에 함께.

- **프론트**: React 19 · Vite 6 · Tailwind 3 · tRPC 11 클라이언트 + react-query 5 + superjson
- **백엔드**: Express 4 · @trpc/server · Drizzle ORM · MySQL(mysql2, UTC 고정) · tsx 런타임 · ESM
- **LLM**: DeepSeek(OpenAI 호환, `LLM_BASE_URL`/`LLM_API_KEY`) — `complete()` 헬퍼로 추상화, Anthropic SDK 폴백
- **스케줄**: node-cron(Asia/Seoul) — 수집 인터벌 + 다이제스트/시황/리포트 크론 + 부팅 캐치업
- **소스 수집**: twitter-scraper(X 쿠키) · gramjs(텔레그램 MTProto) · ws(TradingView) · rss-parser · playwright · marked(다이제스트 렌더)
- **배포**: Railway(앱 web1 + MySQL). `start = db:migrate && tsx src/server/index.ts`. 개발 브랜치 푸시 = 자동 재배포. 아웃바운드 개방(외부 수집은 프로덕션에서만).

**규모**: 10개 사용자 탭 · 8개 소스 어댑터 · 8개 tRPC 라우터 · DB 마이그레이션 0000~0010(11개).

---

## 2. 아키텍처 / 데이터 흐름

독립된 두 파이프라인이 node-cron으로 돈다.

### ① 콘텐츠 파이프라인
```
소스 8종(RSS·X·텔레그램·네이버블로그·한경·서브스택)
  → 수집 collectAll (어댑터 fetch → (source,url) dedupe · 묘비 tombstone로 삭제글 부활 차단)
  → 1차 분석 filterRelevant (LLM 1콜: 관련성·중요도·요약 + 논지 신호 동시 산출)
  → ┬ Feed/보관함 (중요·검토·원문확인·저장·텔레그램 버킷 분기)
    ├ 다이제스트 (맵리듀스 종합 · 각주 인용)
    └ 논지 지도 (스레드별 신호 집계)
피드백 루프: 사용자 액션(삭제/남기기/복원) → filter_feedback → 1일 1회 '학습 메모' distill → 1차 분석 중요도에 재주입
```

### ② 시황분석 파이프라인 (콘텐츠와 완전 별개)
```
시장 데이터(CNN F&G·TradingView WS·KOFIA·FRED via TV·adrinfo.kr)
  → 07시 배치 스냅샷 (병렬·tolerant 수집 → settings KV에 JSON 저장, 마이그레이션 불필요)
  → 클라이언트 계산 (K-공포지수·US 진입신호를 브라우저에서, 추가 LLM 없음)
  → 9개 지표 카드 + K-공포/US 진입 패널
```

---

## 3. 10개 탭 (사용자 기능)

### 글 흐름 (수집된 글이 사용자에게 도달하는 5개 탭)

**Feed** (`FeedPage.tsx`) — 오늘치 transient 글
- 매일 07시 sweep에 갈리는 오늘 글만. 중요/검토(lowPriority)/원문확인 토글 + 각 건수. X Article처럼 본문이 비었거나 제목·티커만 수집된 글은 원문확인에 계속 보존하고 다이제스트에서는 제외. 저장·지난 텔레그램은 보관함으로.
- 필터: impact(상승/하락/중립)·티커·테마·추가일 날짜피커 + 소스별 탭(provider). 필터 걸리면 '초기화' 버튼.
- 다중선택 일괄 삭제/남기기 + 카드별 별점·남기기·삭제. **전부 낙관적 업데이트**(캐시 즉시 반영, 전체 refetch 안 함 → 렉 방지, 실패 시 rollback).
- 카드 펼침: 요약 / 왜 중요한지(implications) / 원문 본문(body) / 전체 분석(fullText 마크다운).

**보관함** (`ArchivePage.tsx`) — persistent 버킷
- 07시 sweep을 넘겨 계속 쌓이는 ⭐저장됨 / 텔레그램 두 버킷(칩 전환·건수).
- 텔레그램은 원문 URL이 없어 삭제 안 하고 다이제스트 인용이 여기로 연결.
- 다이제스트 `?article=id` 딥링크 → 목록 대신 그 글 하나만 본문 펼쳐 포커스.

**휴지통** (`TrashPage.tsx`) — soft-delete
- Feed 휴지통 · 다이제스트 휴지통 두 섹션. 다중선택 복원/영구삭제, 섹션 전체삭제.
- 글은 오직 여기서만 앱을 영구히 떠남(tombstone으로 행은 남아 재수집 부활 차단).

**Daily Digest** (`DigestPage.tsx`) — 기간 종합 리포트
- 새 다이제스트 생성(시작·종료일 07시 경계 기준, 백그라운드 실행 → 목록 4초 폴링해 자동 오픈).
- '지금 낮분/경계 작업' 수동 트리거(슬롯 마감 전엔 tooEarly 거부) · '이 기간 피드 정리'.
- 날짜 네비게이터(◀▶·date피커·슬롯 칩) · 선택본 휴지통.
- **각주 [N] 인용**: 호버 툴팁(제목·출처, 가로 클램프) / 클릭 점프 + 노란 지속 마커(.ref-active, sessionStorage 복원) / ↩ 복귀(occurrence 기억) / URL 있으면 새 탭, 텔레그램은 `?article`, 없으면 `#ref-N` 폴백.

**분석 (수동)** (`ManualPage.tsx`) — API 키 없이 Claude Max로
- pending 글을 소스별 그룹핑. '복사'로 지침+본문 프롬프트를 클립보드에 → claude.ai 붙여넣기 → 돌아온 JSON을 붙여 '저장'하면 파싱돼 Feed/Digest 반영. 건너뛰기·미리보기.

### 관리 · 애그리게이터 (4개 탭)

**Sources** (`SourcesPage.tsx`)
- 소스 추가(프로바이더·식별자·라벨)/토글/편집/삭제 + 소스별 '지금 수집'(즉시 fetch 테스트, 결과 인라인).
- generic_rss는 홈페이지 URL만 넣어도 피드 자동 탐지 제안('이 주소로 저장하고 수집'). X 직접수집 상태 배너. 인증 필요 소스는 로그인 안내.

**Settings** (`SettingsPage.tsx`)
- 지침 4종 편집: `relevanceCriteria`(1차 필터) · `importanceCriteria`(중요/검토 분리) · `summaryInstructions`(요약) · `digestInstructions`(2차 다이제스트).
- 고급(접힘): DEEP_ANALYSIS 지침 · 1차 글 선별 / 다이제스트 자료 정리 / 최종 연결 모델을 독립 설정. 현재 서버의 실제 모델 흐름과 Settings·Railway 우선순위 표시.
- **학습 메모(자동)**: 피드백으로 매일 distill되는 중요도 메모 보기·편집·비우기(`settings.filterGuidance`, `importanceCriteria`와 별개).

**리포트** (`ResearchPage.tsx`) — 증권사 리포트 애그리게이터
- 오늘 올라온 기업·산업 리포트를 카테고리별로(네이버 + 한경 병합, 출처 배지). 헤드라인·한 줄 요약·목표가·의견·시총.
- 5영업일 커버리지 ≥5회=주요종목, 직전 대비 TP상향=티어업. 날짜 선택·지금 수집.
- ⚠️ 파서는 Railway 실검증 대기(샌드박스 egress 차단).

**논지 지도** (`ThesisMapPage.tsx`) — 투자 논지 추적
- 스레드(A~E) 카드: 코드 배지·한줄 명제·7일 verdict 집계(강화/약화/반증/중립)·net 추세 화살표·마지막 신호일. 30일 반증>0이면 빨강 경고.
- 신호는 **1차 분석이 자동 기록**(추가 LLM 콜 없음). 신뢰도는 LLM이 아니라 시스템 집계.
- 신규 논지 후보 인박스(붙이기/승격/버리기) · A~E 시딩 · 스레드 CRUD/보관.

### 시황분석 (`MarketPage.tsx`) — 앱에서 가장 큰 기능 → §4

---

## 4. 시황분석 딥다이브

상단 6개 그리드 카드 + 전폭 3개 패널. 모든 지표가 현재값 + ~5년 히스토리를 함께 받아 인터랙티브 차트(휠줌·크로스헤어)로.

### 시장 지표 카드
| 카드 | 소스 | 핵심 |
|---|---|---|
| 공포·탐욕 | CNN F&G JSON | 0~100 + 한국어 라벨, 전일/주/월/년 |
| 커스텀 캔들 | TradingView WS | 심볼 직접 지정(티커 자동 해석), OHLC 캔들·타임프레임 토글 |
| S5FI/NDFI | TradingView `INDEX:S5FI/NDFI` | S&P500·나스닥100 50일선 위 비율(breadth) |
| 코스피/코스닥 ADR | adrinfo.kr HTML | 등락비율 + 전일 종가 대비 |
| 신용잔고 | KOFIA FreeSIS | 신용거래융자(조원). ⚠️ 게이트웨이 ÷8 → ×8 보정 |
| 미국 순유동성 | FRED via TV 미러 | 연준자산 − 역레포 − TGA. 주간·후행 배경(매매신호 아님) |

### K-공포지수 (`kfear.ts` + `KFearPanel.tsx`) — 코스피·코스닥 개별, 전부 클라 계산

**FEAR(0~100)** = 4성분 동일가중 평균, 각 **252일 롤링 분위수**(skipna):
```
F1 = 1 − pct252(신용 10일 변화율)   # 청산 속도
F2 = pct252(반대매매 금액)          # v4: 비중 아닌 절대금액(분모 왜곡 제거)
F3 = 1 − pct252(60일 이격도)        # 가격 낙폭
F4 = pct252(20일 실현변동성)        # 패닉(VKOSPI 대용)
```
**3신호**: S1 신용청산(DD≤−8% & 10일≤−3% & 지수10일<0) · S2 반대매매(v5: 금액 1년 상위5% 스파이크[6일내] & 금액 2일 연속↓) · S3 이격도(≤−8% or 1년 하위5%).

**등급** = FEAR≥90 + 신호 개수: STRONG(3)/BUY(2)/ARMED(≤1)/WATCH(FEAR<90&2)/IDLE.

**권장 비중** = 등급비중 × 이중 얕음게이트:
- GRADE_WEIGHT = {STRONG 100, BUY 60, ARMED 50, WATCH 45, IDLE 0} (depth 사다리 폐지)
- 이중 게이트: 신용DD>−8% **AND** 이격도>−7% 둘 다 얕으면 ×0.5, 하나라도 깊으면 ×1.0(하나만 얕음 실측 +23.8%라 안 깎음)
- 코스닥 단독(코스피 미동반) → 0% 관찰(등급 무관 최우선)
- 차트 4개: FEAR(90) / S1 신용DD(−8·−15) / S2 금액 분위(95) / S3 이격 편차(−8)

⚠️ KOFIA는 T+1 발표 → 평가 기준일을 KOFIA 최신 거래일로 truncate. KST 거래일 정렬(kstDay)로 tz 정합.

### US 진입신호 (`usEntry.ts` + `USEntryPanel.tsx`) — 나스닥, 전부 클라 계산

**TERM = VIX/VIX3M**(만기구조 역전) + 신용 스프레드 2트랙:
```
A(주 진입) = TERM ≥ 1.05
B(강 신호) = TERM ≥ 1.00 AND HY OAS ≥ 4.5%   # HY는 T+1 → D-1 관측치 shift(1)
MEGA 배지  = VIX ≥ 40
```
**3단 티어**: Tier0 조정매수(나스닥 IXIC 52주 고점대비 −8% & 200일선 위 → 소량) / Tier1(A or B → 본대) / Tier2(AB or MEGA → 최대). 200일선 필터가 강세장 조정↔하락장 자동 구분.
**상태머신**: IDLE/WATCH(TERM≥0.95 or HY≥4.25)/ARMED(TERM≥1.00)/ACTIVE_A|B|AB/POST(21거래일). 검증 앵커 13건 재현 체크.
데이터: TV 미러 `TVC:VIX`·`CBOE:VIX3M`·`FRED:BAMLH0A0HYM2`·`NASDAQ:IXIC`.

> ⚠️ 두 신호 모두 n=5~20 소표본 백테스트 기반 관찰 도구이며 투자 권유가 아님. "100%"는 배정 예비대의 100%이지 전체 몰빵이 아님.

---

## 5. 백엔드 파이프라인 (수집 → 분석 → 종합, 4단계)

1. **수집** (`workers/collect.ts` collectAll): 소스별 어댑터로 fetch → `articles` upsert. 같은 (source,url) 글은 삭제됐어도 재생성 안 함(불안정 GUID 부활 차단). X=쿠키 직접수집, 텔레그램=MTProto 배치(커서 lastMessageId).
2. **1차 분석** (`analysis/analyze.ts` filterRelevant): LLM 1콜로 섹터 비편향 관련성·중요도·요약 + 논지 신호 동시 산출. 활성 스레드는 필터가 아닌 사후 태그로만 사용. 한국어 강제·fail-open. 본문 미수집 shell은 LLM 판정 전에 원문확인함으로 보존. 배치(50)×동시성(3), 429 감지 시 사이클 중단 후 재개.
3. **피드백 학습** (`feedback.ts` refreshGuidance): 사용자 액션(휴지통=중요↓/남기기·복원=중요↑)만 `filter_feedback`에 기록. 경계 루틴에서 새 피드백만 distill해 '학습 메모'에 누적 통합 → 1차 필터 중요도에만 재주입(관련성 게이트 불변).
4. **다이제스트** (`digest/digest.ts`): 경계 07시(아침분+하루 sweep+피드백 distill) · 17시(낮분). 창 글 30건 초과면 **Flash(기본=필터 모델)**로 크기 균형 청크를 사실 위주 압축한 뒤 **Pro(분석 모델)**가 최종 연결·작성한다. 최종 Pro 실패 시 같은 Pro를 증액 예산으로 한 번 더 시도하고, 두 번 모두 실패할 때만 Flash로 폴백한다. 전역 각주 [N] 유지. [N] 인용을 각주 링크로(일반=원문 URL, 텔레그램=`?article`). 과거일은 저장 다이제스트 재종합.

---

## 6. 데이터 정합성 & 검증

- **앵커 방어** (`market/anchors.ts`): HARD assert(불일치 시 throw→소스 통째 거부, 신용 유가 07-07=29.075조·코스피 종가 등 실측 고정) + SOFT 경고(staleness→errors[] 화면 배너). 날짜매칭 ms 허용오차(KOFIA=0, 지수 20h).
- **단위·정렬 함정**: KOFIA ÷8 아티팩트 → ×8 보정 / 반대매매 금액 컬럼은 이중 2점 비율(4.48 AND 2.83)로 스케일 무관 식별 / KST 거래일 정렬 + KOFIA 최신일 truncate로 tz 1일 밀림 제거.
- **검증됨**: K-공포 사이징 T1~T12 유닛테스트 · US 진입 §4-4 앵커 + Tier0 13건 재현 · 파이썬↔TS bit-exact 파리티.
- **부분 실패 내성**: 소스별 tolerant 수집(한 곳 실패해도 나머지 진행) · 빈 시리즈면 직전값 carry-forward · TradingView 전역 세마포어 `TV_MAX=3`.

---

## 7. 데이터 모델 · tRPC · 배포

**tRPC 라우터 8개**: sources · settings · feed · digest · manual · market · research · thesis. (`initTRPC.context().create({transformer: superjson})`)

**DB 테이블** (`db/schema.ts`):
- `sources` · `articles`(soft-delete deletedAt · tombstone) · `analyses`(relevant/lowPriority/saved/summary/fullText/tickers/themes/impact) · `digests`(periodStart/End · meta · slot) · `settings`(key/value JSON KV — 지침·filterGuidance·marketSnapshot 등) · `filter_feedback` · `research_reports` · `threads`+`signals`(논지지도, signals unique(article_id,thread_id), thread_id NULL=신규후보)

**마이그레이션**(수동 작성 — drizzle-kit generate는 대화형이라 이 환경서 막힘):
0000 초기 · 0001 settings · 0002 full_text · 0003 trash+digest 기간화 · 0004 low_priority · 0005 saved · 0006 text→mediumtext · 0007 filter_feedback · 0008 research_reports · 0009 research summary/marketCap · 0010 thesis_map. 컬럼 추가는 nullable/default로.

**주요 env**: `DATABASE_URL`, `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`, `X_AUTH_TOKEN/X_CT0`, `TELEGRAM_API_ID/HASH/SESSION`, `DIGEST_HOUR`(7)/`DIGEST_MIDDAY_HOUR`(17), `COLLECT_INTERVAL_MIN`, `MARKET_HOUR`(7)/`RESEARCH_HOUR`(8), `ANALYZE_BATCH/CONCURRENCY`, `DIGEST_MAX_TOKENS` 등.

---

## 8. 파일 지도 (어디에 뭐가 있나)

```
src/client/pages/     — 14개 페이지·컴포넌트 (10 탭 + 차트 3개 + 계산 모듈 kfear.ts/usEntry.ts)
src/client/data/client.ts — tRPC 래퍼(DataApi) + 정적 데모 스텁
src/server/adapters/  — 소스 어댑터 8종 + registry
src/server/analysis/  — analyze.ts(1차 분석) · anthropic.ts(LLM) · feedback.ts(학습)
src/server/digest/    — digest.ts(맵리듀스·각주·2슬롯)
src/server/market/    — tradingview/cnn/adr/credit/forcedLiq/liquidity/koreaIndexes/usEntry/anchors
src/server/research/  — naver.ts · hankyung.ts · index.ts
src/server/repo/      — thesis.ts 등 저장소 레이어
src/server/trpc/routers/ — 8개 라우터
src/server/scheduler.ts  — node-cron 오케스트레이션
src/shared/           — analysis.ts(지침 기본값·프롬프트) · market.ts · providers.ts · research.ts
drizzle/              — 0000~0010 마이그레이션 SQL
CLAUDE.md             — 전체 인수인계(가장 상세)
```

---

## 9. 알려진 제약 / 남은 것 (개선 후보)

- **다이제스트 텔레그램 전송** 미구현(계획됨).
- **논지 지도 = changelog 다이제스트**(움직인 논지만) 미구현 · Feed 카드 스레드 배지 미구현.
- **리포트·시황 파서**는 Railway(아웃바운드 개방)에서만 실동작 — 샌드박스는 외부 호스트 차단.
- 시황: 과거 신호 성적표(2020~ 백테스트) · US 진입 상태전이 텔레그램 알림 미구현.
- 다이제스트 각주 ↩ 복귀가 간헐적(react-query background refetch 관련, CLAUDE.md '알려진 버그' 참조).
- 신호 시스템은 소표본 백테스트 기반 — 계수 수치는 방향성만 신뢰.

---

*이 문서를 Claude에 붙여넣거나 업로드하면 앱 전체 맥락을 제공할 수 있다. 코드 수정을 요청할 땐 위 §8 파일 지도를 참고해 대상 파일을 지목하면 정확도가 올라간다.*
