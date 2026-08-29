# Feed Watch — 인수인계 (HANDOFF)

개인 투자 정보 수집·분석·다이제스트 대시보드. 여러 소스에서 글을 모아 1차로
필터·요약하고, 하루 1회(또는 기간 지정) **다이제스트**로 종합한다.

> 📖 **처음 오는 사람은 §0을 먼저 읽으면 앱 전체가 잡힌다.** 더 깊은 개요는 `docs/OVERVIEW.md`(앱 전체)와
> `docs/fear-indicators.md`(K-공포지수·US 진입신호 지표 상세)에 자족적으로 정리돼 있다. 이 CLAUDE.md의
> §0 이후는 세션 인수인계·주의사항·세부 구현 노트다.

## 0. 전체 개요 — 처음 보는 사람용 (여기부터)

**무엇인가**: 여러 소스(RSS·X·텔레그램·네이버블로그·한경·서브스택)에서 투자 관련 글을 **자동 수집 → LLM 1차
분석(관련성·중요도·요약) → 하루 2회 다이제스트로 종합**하고, 별도로 **시장 공포·진입 신호**(국내 K-공포지수 ·
미국 US 진입신호)를 실시간 계산하는 **개인용 웹 대시보드**. 목표 = "모든 글 훑기"를 버리고
**"하루 2~3회 다이제스트 + 움직인 신호만 보기"**(신경 끄기).

**스택**: TypeScript 단일 리포 풀스택 모노리스. 프론트 = React 19 · Vite 6 · Tailwind · tRPC 11 + react-query.
백엔드 = Express · @trpc/server · Drizzle ORM · MySQL · node-cron. LLM = **DeepSeek**(OpenAI 호환).
배포 = **Railway**(개발 브랜치 푸시 = 자동 재배포). 계산 무거운 지표(K-공포·US 진입)는 **전부 클라이언트**.

**두 파이프라인** (node-cron 스케줄러가 오케스트레이션):
```
① 콘텐츠: 소스 8종 → 수집 collectAll(묘비 dedup) → 1차분석(LLM 1콜: 관련성·중요도·요약·논지신호 동시)
          → Feed/보관함 · 다이제스트(맵리듀스·각주 인용) · 논지지도
          ↖ 피드백 학습: 사용자 액션(삭제/남기기/복원) → filter_feedback → 1일 1회 '학습 메모' → 1차분석 중요도에 재주입
② 시황분석: 시장데이터(CNN·TradingView WS·KOFIA·FRED·adrinfo) → 07시 스냅샷(settings KV)
          → 클라 계산(K-공포지수 · US 진입신호) · 지표 카드
```

**10개 탭** (`src/client/App.tsx` + `src/client/pages/`):
| 탭 | 역할 |
|---|---|
| **시황분석** | 시장지표 9카드 + K-공포지수 + US 진입신호 (앱에서 가장 큰 기능 → 아래 §탭 구성) |
| **Daily Digest** | 기간 종합 리포트 생성·열람(맵리듀스·각주 인용, 하루 2슬롯) |
| **Feed** | 오늘치 transient 글(중요/검토), 필터·다중선택·낙관적 업데이트 |
| **보관함** | 저장·텔레그램 persistent 버킷 |
| **분석(수동)** | API키 없이 Claude Max 붙여넣기 분석 |
| **Sources** | 수집 소스 CRUD·'지금 수집'·피드 자동탐지 |
| **휴지통** | soft-delete 복원/영구삭제(tombstone) |
| **Settings** | 1·2차 분석 지침 + 자동 '학습 메모' |
| **리포트** | 증권사 리포트 애그리게이터(커버리지·TP상향 티어) |
| **논지 지도** | 투자 논지 스레드에 1차분석이 자동 기록한 신호 집계 |

**핵심 DB 테이블** (`db/schema.ts`, 마이그레이션 0000~0010, **수동 작성**): `sources` · `articles`(soft-delete
deletedAt·tombstone) · `analyses`(relevant/lowPriority/saved/summary/fullText) · `digests`(period·slot) ·
`settings`(KV — 지침·filterGuidance·marketSnapshot) · `filter_feedback` · `research_reports` ·
`threads`+`signals`(논지지도).

**파일 지도**: `src/client/pages/`(14 페이지+차트 3개+계산모듈 `kfear.ts`/`usEntry.ts`) ·
`src/client/data/client.ts`(tRPC 래퍼) · `src/server/adapters/`(소스 8종+registry) ·
`src/server/{analysis,digest,market,research,repo,trpc,scheduler.ts}` · `src/shared/`(지침 기본값·타입·providers) ·
`drizzle/`(마이그레이션). tRPC 라우터 8개: sources·settings·feed·digest·manual·market·research·thesis.

**이 문서 나머지 읽는 법**: 배포/env=§실행 환경, 콘텐츠 파이프라인 상세=§파이프라인, 시황분석(K-공포 v5·US
진입·데이터 정합성 앵커)=§탭 구성 안 큰 문단, 다이제스트 각주 버그 등=§알려진 버그, 다음 할 일=맨 아래 §방향.

## ⚠️ 새 세션 시작 시 먼저 할 것
- 컨테이너가 가끔 **옛 커밋으로 리셋**된다. 작업 전 반드시:
  `git fetch origin claude/focused-planck-m3wgbz && git reset --hard origin/claude/focused-planck-m3wgbz`
- 개발 브랜치: **`claude/focused-planck-m3wgbz`** (여기에만 커밋·푸시). 푸시하면 Railway가 자동 재배포.
- 푸시는 GitHub MCP가 아니라 일반 `git push -u origin <branch>` 사용.

## 현재 상태 / 핵심 메모
- **X 직접수집 동작 확인됨 ✅** (무료, 브리지 불필요): Railway `X_AUTH_TOKEN`·`X_CT0`(끝자리 **숫자 0**, 영문 O 아님) = 내 X 계정 쿠키. **쿠키는 반드시 `.x.com` 도메인에 set**(`x/client.ts`) — 라이브러리가 `api.x.com`으로 요청해서 `.twitter.com`이면 쿠키 누락 → **401**. Sources 탭 배너 "X 직접수집: 켜짐✓" + 소스별 **'지금 수집'**으로 확인. 401 재발 시 쿠키 재복사(만료/로그아웃), 403·429는 일시 레이트리밋.
- **다이제스트 시각 = 07시(경계·sweep·메모) + 17시(낮분)**. ⚠️ Railway에 `DIGEST_HOUR=7`, `DIGEST_MIDDAY_HOUR=17` **반드시 설정**(과거엔 21로 돼 있었음 — env가 코드 기본값을 덮으므로 Railway를 안 바꾸면 21/14 그대로). 경계 07시라 하루 창 = [(D-1)07시, D07시), 낮분(17시)은 자정을 가로질러 **다음날 07시 경계 창**에 속함(slotBounds·currentWindowDate가 M≥H 케이스 처리).
- 마지막 작업 브랜치 `claude/focused-planck-m3wgbz`(HEAD=최신). 새 세션은 위 ⚠️대로 reset 먼저.

## 실행 환경 (Railway)
- 앱(web1) + MySQL. `start` = `db:migrate && tsx src/server/index.ts`.
- 주요 환경변수:
  - `DATABASE_URL` (MySQL public URL)
  - 분석 LLM = **DeepSeek**: `LLM_BASE_URL=https://api.deepseek.com/v1`, `LLM_API_KEY`, `LLM_MODEL=deepseek-v4-flash` (OpenAI 호환)
  - `TELEGRAM_API_ID/HASH/SESSION` (텔레그램 MTProto, 공개·비공개 채널 배치 수집)
  - X: `X_AUTH_TOKEN`+`X_CT0`(끝 **숫자 0**, 내 계정 쿠키로 직접 수집, 권장·브라우저 불필요) > 소스별 `config.rssUrl` > `X_RSS_BRIDGE`(브리지 템플릿). 쿠키 만료/로그아웃 시 갱신 필요
  - DB 커넥션은 **UTC 고정**(`db/client.ts`: `timezone:"Z"` + 세션 `SET time_zone='+00:00'`) — 경계 창(`createdAt`) 비교가 시간대로 어긋나지 않게 (이전에 이것 때문에 sweep 0건 버그 있었음)
  - `DIGEST_HOUR`(기본 **7**, KST 경계·sweep·메모), `DIGEST_MIDDAY_HOUR`(기본 **17** — 낮분 다이제스트, sweep 없음; 경계 앞이든 뒤든 가능), `COLLECT_INTERVAL_MIN`(기본·권장 15), `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
  - 선택: `DEEP_ANALYSIS=1`(글별 개별 심층분석 on), `FILTER_BODY_CHARS`, `DIGEST_MAX_TOKENS`(비추론 최종·Flash 폴백 기본 8192), `DIGEST_PRO_THINKING`(최종 Pro 사고모드, 기본 ON), `DIGEST_PRO_THINKING_TOKENS`(사고+본문 Pro 1회 호출 최소 24576), `DIGEST_MAP_ITEMS/CHARS/TOKENS`(맵리듀스 청크, 기본 30/45000/8000), `DIGEST_ITEM_CHARS`(다이제스트 글당 본문 상한, 기본 2500), `ANALYZE_ALL`, `ANALYSIS_AVOID_PEAK`(기본 1: KST 10~13·15~19 자동 분석 대기), `ANALYSIS_DRAIN_MAX_ROUNDS`(13·19시 적체 연속 처리 상한, 기본 20), `FILTER_FEEDBACK_PER_TYPE`(하루 distill에 넣을 액션 타입별 새 피드백 수, 기본 15). 예전 `DIGEST_FINAL_RETRY_TOKENS` 값이 Railway에 남아 있어도 이제 최종 Pro는 재시도하지 않아 사용되지 않는다.
  - **다이제스트 품질/비용 튜닝(중요 글이 많을 때)**: 병목은 입력이 아니라 **출구**다. 최종 Pro는 Thinking ON으로 `max_tokens`를 최소 24576 확보하되 **딱 1회만 호출**한다. 실패하면 같은 Pro를 다시 과금하지 않고, 원인을 기록한 뒤 Thinking OFF인 Flash로 즉시 최종 작성한다(Flash 상한=`DIGEST_MAX_TOKENS`). 맵 Flash는 Thinking OFF이며 `DIGEST_MAP_TOKENS=8000` 기본. `DIGEST_MAP_ITEMS=40`, `DIGEST_MAP_CHARS=90000`은 대량 피드에서 호출 수를 줄이는 선택값이다. 각 호출 실패는 종류(사고만 생성·토큰 한도·429·5xx·네트워크 등), 모델, 토큰 예산, Thinking 상태, 정제된 원문 오류와 `runId`를 `digests.meta.models`에 저장하고 다이제스트 상단의 **실패 원인 보기**에서 확인한다(API 키·Bearer 값은 저장 전 제거).

## 파이프라인
1. **수집**(`workers/collect.ts`): 소스별 어댑터 fetch → articles 저장. 같은 (source,url) 글이 있으면 재생성 안 함(삭제 부활 방지). **영구삭제(purge)도 행 자체는 안 지우고 묘비(tombstone: analysis·body 제거, url만 유지)로 남겨** 재수집 시 부활 차단.
2. **1차 분석**(`analysis/analyze.ts` `filterRelevant`): 1번 호출로 relevant·important·summary 동시. 한국어 강제(+중국어 시 재요약). DeepSeek 등. 사이클당 `ANALYZE_BATCH`개(기본 50)를 `ANALYZE_CONCURRENCY`개(기본 3) 동시 처리 — 백로그 밀리면 env로 올리기(예 200/5), 레이트리밋(429) 나면 그 사이클 중단 후 다음에 재개. 처리량/시 ≈ BATCH × (60/COLLECT_INTERVAL_MIN).
   - **피크 요금 회피**: 수집은 중단하지 않고 자동 글별 LLM 분석만 매일 KST 10:00~13:00·15:00~19:00 대기한다. 13시·19시에 오래된 미분석 글부터 최대 20배치 연속 처리하고 이후 정상 주기로 이어간다. 부팅이 피크 시간이어도 자동 다이제스트 catch-up은 다음 13/19시로 미뤄 비싼 재생성을 막는다. `ANALYSIS_AVOID_PEAK=0`이면 비활성화.
3. **Feed / 보관함(두 페이지로 분리)**: relevant 글을 성격으로 나눔. **Feed 탭 = 매일 갈리는 transient**: 중요 / 검토대상(lowPriority), **단 ⭐저장은 제외**. **텔레그램은 하이브리드**: 오늘 창([직전 경계, 다음 경계)) 동안엔 중요/검토에 평소처럼 섞여 나오고(원문순). 경계(07시) sweep 때 **검토(낮은 중요도) 텔레그램은 다른 검토 글처럼 휴지통으로**(다이제스트가 인용 안 하니 `?article` 안 깨짐), **중요 텔레그램만 살아남아 경계 이동으로 보관함으로** (mutation 아님 — `currentWindowStart()` 경계가 옮겨갈 뿐, 행은 살아있어 다이제스트 `?article` 링크 보존). **보관함 탭 = persistent**: ⭐저장됨(saved, 전 provider) / 텔레그램(경계 지난 살아있는 = 사실상 중요 텔레그램). 서버 `feed.list`의 `priority`(`important`/`low`/`saved`/`telegram`)로 구분 — important/low는 `saved=false AND (provider<>telegram OR createdAt>=wStart)`, 보관함 telegram은 `provider=telegram AND createdAt<wStart`. `feed.counts`도 동일 기준. 다이제스트 `fetchFeedRows`·sweep은 영향 없음(중요 OR saved를 전 provider에서 그대로; sweep은 telegram 제외 그대로). 정렬은 원문 게시시각순. 날짜 필터·소스 탭·다중선택 삭제·휴지통(soft delete) 있음. 삭제/남기기/별점은 **낙관적 업데이트**(캐시 즉시 반영, 전체 refetch 안 함 — 렉 방지). **피드백 학습**: 사용자 액션을 `filter_feedback`에 기록(`action`=trash/promote/restore) — **휴지통 이동=음성(중요↓)**, **검토→남기기·휴지통→복원=양성(중요↑)**. **영구삭제(purge)·경계 자동 sweep은 기록 안 함**(휴지통엔 자동 정리 글이 섞여 있어 신호 오염 방지). 경계 루틴에서 **새 피드백만**(커서 `lastFeedbackId`, 액션 타입별 최근 `FILTER_FEEDBACK_PER_TYPE`개=기본 15)을 기존 **'학습 메모'에 LLM으로 누적 통합**(distill 1회/일, settings `filterGuidance`) → 1차 필터의 **중요도(중요 vs 검토대상) 판단에만** `guidanceBlock`으로 주입. **관련성/제외 게이트(relevant)엔 영향 없음** — relevanceCriteria 그대로(사용자가 1차 필터는 손대지 말라고 함). **누적식**이라 과거 학습이 유지·복리되고, 상호작용 시엔 DB insert만(토큰 X).
4. **다이제스트**(`digest/digest.ts`): 기간 내 중요 글 + 저장(saved) 글 종합. 2차 지침(`digestInstructions`) 사용. `[N]` 인용을 **각주(윗첨자 번호) 링크**로 변환. **클릭=원문 바로(새 탭)** (`citeHref`: 일반=원문 URL, 텔레그램=`?article=id`; URL 없으면 `#ref-N` 폴백만 하단 목록으로). 하단 "참조 원문" 목록은 **기본 접힘**(`<details class="digest-refs-wrap">`, [N]이 이제 원문 직행이라 목차/폴백용으로만; `jumpTo`가 폴백 점프 시 부모 details 자동 open). 맵 프롬프트(`renderItem`)는 **1차 요약(dense) + 본문 발췌(`DIGEST_ITEM_CHARS` 기본 2500자) 병용**(장문 글 뒷부분 잘려도 요지 보존), **URL 줄은 제거**(인용 규칙상 링크 못 쓰니 순수 낭비였음). 각주 점프 시 **노란 지속 마커**(`.ref-active`, 다음 점프까지 유지·sessionStorage로 탭 복귀 시 복원). 인라인 링크는 LLM 지침으로 금지. 묶음/범위 인용(`[3,5]`/`[3-5]`)도 각 번호로 펼침. **텔레그램 글은 원문 URL이 없어** 참조를 `?article=<id>` 딥링크(새 탭)로 → App이 **보관함 탭**으로 시작, ArchivePage가 그 글만 본문 펼쳐 표시(텔레그램이 이제 보관함에 있음). 서버 `feed.get`. 각주 `[N]` **호버 툴팁**(`data-tip`=제목·출처, CSS `:hover::after`; 폰은 살짝 탭=호버). **클릭=점프**(노란 마커, occurrence 기억→↩ 복귀; html은 useMemo로 안정화해 재렌더가 마커 안 지움). 툴팁 **가로 위치만 JS로 클램프**(effect가 [N]마다 `--tip-shift`/`--tip-maxw` 세팅 → 오른쪽 끝에서도 안 잘림; rect.left는 세로 스크롤에 안 변해 안전, resize 시 재계산). 길게눌러 뜨던 링크 메뉴는 `touch-callout:none`으로 억제. **기간은 경계시각(기본 07시)**: date D = [(D-1)07시, D07시) KST. **자동은 하루 2회(슬롯), 라벨=생성일(읽는 날)**: **낮분**(14시 생성, `meta.slot='midday'`, sweep·학습메모 절대 안 함) = [당일 07시, 당일 14시), **라벨=생성일 그대로**(이전엔 창 끝 날짜=다음날로 라벨해 '오늘 만든 낮분이 내일 탭에' 뜨는 혼란 → 생성일로 변경, `middayLabelDate()`; 구라벨 X+1 행도 `hasMiddayFor`가 인정해 중복 생성 방지). **아침분**(07시 생성, `meta.slot='evening'` — 내부 키는 레거시 호환으로 유지, UI 표기만 '아침분'; 구슬롯 없는 옛 자동본=evening 취급) = [전날 14시, 당일 07시), 라벨=생성일(=창 끝 날짜, 기존과 동일). 두 슬롯은 분석시각(createdAt) 기준 **겹침/누락 없음**, 한 날짜 탭 = 아침분+낮분(그날 읽는 두 판). **07시 루틴**(`runDailyDigests(kstToday)`): 어제 낮분 누락 시 보충 생성(라벨=어제) → 아침분 생성 → **하루 창 전체 sweep**(단, 그날 자동본이 하나도 없으면 sweep 안 함). 크론 놓침 → **부팅 시 catch-up**(경계/낮분 **독립 체크** — 경계가 이르면 두 런이 다른 캘린더 날에 떨어짐; 슬롯별 `hasAutoDigestFor` 중복 방지). **맵리듀스**: 창의 글이 `DIGEST_MAP_ITEMS`(기본 30)건 초과면 **크기 균형 청크**(`packChunks` LPT: 건수≤30 & 글자≤`DIGEST_MAP_CHARS` 기본 45K, 장문·단문 섞임)로 부분요약(`DIGEST_MAP_TOKENS` 기본 8000, 동시 3, 같은 Flash 1회 재시도) 후 최종 종합. 각주 번호는 전역 유지. 최종 Pro는 Thinking 예산을 포함해 최소 24576토큰으로 **1회만** 실행하고, 실패하면 이유를 남긴 뒤 `DIGEST_MAX_TOKENS`(기본 8192) 한도의 Flash로 즉시 폴백한다. 수동: **'지금 (낮분) 작업 실행'**(`digest.runMidday`, 낮분만·sweep 없음)과 **'지금 (경계) 작업 실행'**(`digest.runEvening`, 낮분 보충+저녁분+하루 sweep) — **둘 다 해당 슬롯 마감 전엔 거부**(`tooEarly`; 일찍 실행하면 창이 일찍 닫혀 누른시각~경계 글이 누락). UI 라벨은 `digest.schedule`(서버 시각)로 동적 표시. **'이 기간 피드 정리'**(`digest.sweepRange`)는 다이제스트·피드백 신호 없이 sweep(과거일 정리용). **중요 텔레그램만 sweep 제외**(과거 다이제스트 `?article` 참조 보호; 검토 텔레그램은 함께 휴지통). 수동 **생성은 백그라운드 실행**(`digest.generate`가 즉시 `{started}` 반환 — 풀데이 맵리듀스는 HTTP/엣지 타임아웃 넘겨 "upstream error" 났음; 클라가 목록 폴링해 새 다이제스트 잡음). **수동 다이제스트 날짜 = 만든 날(KST 달력일, 자정 롤오버)**: 폼 기본 날짜 = `schedule.today`(=`kstToday`, 옛 `currentWindowDate` 아님 — 밤 10시 7/7 생성 → 창 도우미 07시 경계로 7/8에 파일링되던 혼란을 자정 기준으로 교정. 밤 10시 7/7→**7/7**, 새벽 1시 7/8→**7/8**). 서버 `generateDigest`도 기본을 `kstToday()`로. 날짜 안 만진 채 생성 시 클라가 `start` 생략→서버가 만든 날로 배정. **스테일 클라/배포지연 방어**: 수동·단일일 요청의 `start`가 `currentWindowDate()`(아직 안 닫힌 미래 창=옛 기본값)와 같으면 서버가 `kstToday()`로 재배정(닫히지 않은 창을 일부러 백필할 일 없음; 07시 이전엔 두 값이 같아 무동작; 과거 백필·범위·자동 크론은 불변). 선택 날짜의 실제 시간창 미리보기 표시. **과거 날짜**는 피드가 비었거나 `fromDigests`면 그 기간 **저장 다이제스트들을 종합**(`meta.source='digests'`, 번호 인용 없음). Digest 탭 자동 optgroup에 낮분/경계 시각 라벨·배지(`digest.schedule` 동적). **피드 정렬은 원문 게시시각**(`COALESCE(publishedAt, createdAt) desc`) — 날짜 필터·다이제스트 창은 여전히 createdAt 기준.

   - **다이제스트 모델 파이프라인(v2)**: 1차 글 선별=`filterModel/FILTER_MODEL`, 큰 창의 묶음별 사실 압축=`digestMapModel`(미지정 시 필터 모델 상속), 최종 연결·작성=`analysisModel/ANALYSIS_MODEL`. 최종 Pro는 **1회만** 실행하고, 실패하면 상세 원인을 저장한 뒤 같은 Pro 재시도 없이 자료 정리 모델(Flash)로 즉시 폴백한다. OpenAI 호환 응답이 본문을 일부 담았더라도 `finish_reason=length`이면 **불완전본을 폐기**하고 Flash가 새 완성본을 작성한다. 맵 Flash 청크는 일시 오류에 대비해 같은 Flash로 1회 재시도한다. `meta.models.version=2`에 map/final 실제 모델·시도·재시도·폴백·오류 상세를 분리 기록한다. OpenAI 호환 API의 stale `claude-*` id는 `resolveModel()`로 실제 `LLM_MODEL` 이름을 표시한다.

## 지침(Settings, DB의 settings.analysis)
- `relevanceCriteria`(1차 필터), `importanceCriteria`(중요/낮음 분리), `summaryInstructions`(요약), `digestInstructions`(2차 다이제스트), `instructions`(DEEP_ANALYSIS용), `filterModel`/`digestMapModel`/`analysisModel`.
- 기본값: `src/shared/analysis.ts`.
- **학습 메모**(`settings.filterGuidance`, 별도 키): 피드백으로 자동 학습되는 중요도 메모. `importanceCriteria`와 **별개**(참고용 주입). Settings 탭 "학습 메모 (자동)"에서 보기·편집·비우기(`settings.getFilterGuidance`/`setFilterGuidance`).

## 소스 어댑터 (`src/server/adapters/`)
generic_rss(피드 URL 또는 **홈페이지 URL도 허용** — 백그라운드는 `<link rel="alternate">` 자동탐지만으로 피드 복구·캐시. **'지금 수집' 실패 시엔** `probeFeedUrl`로 흔한 경로(`/feed/`·`/rss`·`/atom.xml`…)까지 탐색해 **제안만**(`suggestedFeedUrl`) 반환 → UI에서 '이 주소로 저장하고 수집' 확인 시 source identifier로 저장(추측 자동적용 안 함·백그라운드 반복탐색 안 함). 못 찾으면 "HTML일 수 있다" 한국어 에러), naver_blog, hankyung, substack, x(쿠키 직접 수집 우선 `src/server/x/client.ts`+twitter-scraper, 폴백=브리지 RSS), telegram(MTProto 세션·배치·비공개는 숫자ID -100…), naver_premium·fanding(로그인 필요·클라우드 미지원). Sources 탭 소스별 **'지금 수집'**(`sources.collectNow`)으로 즉시 fetch 테스트(결과/에러 인라인).

## 마이그레이션 (중요)
- `drizzle-kit generate`는 **대화형이라 이 환경에서 막힘**. 마이그레이션은 **수동 작성**:
  `drizzle/00XX_name.sql` + `drizzle/meta/_journal.json`에 엔트리 추가(idx/tag/when). 컬럼 추가는 nullable 또는 default로(기존행 보호).
- 현재 0000~0010 (0006: markdown/body/full_text → mediumtext, 0007: `filter_feedback`, 0008: `research_reports`[리포트], 0009: research_reports에 summary/marketCap 추가, 0010: `threads`+`signals` 논지 지도).

## 논지 지도(Thesis Map) — 구현됨 (1차 슬라이스)
- **DB**(0010): `threads`(code·name·thesis 한줄·context·archived·sort) + `signals`(articleId FK·threadId FK nullable·candidate·verdict·tier·note, unique(articleId,threadId)). **threadId NULL = 신규 논지 후보(인박스)**, 그 제안명은 `candidate`에. verdict=`support/weaken/refute/neutral`(강화/약화/반증/중립), tier=`confirmed/mgmt/inference/speculation`(확정/경영진주장/추론/추측).
- **1차 분석 통합**(`analysis/analyze.ts`): 활성 스레드 목록(`thesisRepo.listBrief`)을 **기존 1차 호출 system 프롬프트에 주입**(`threadsBlock`) → 출력 JSON에 `signals[]`+`newThread` 추가(`THESIS_OUTPUT`, **스레드 있을 때만**; 없으면 프롬프트·동작 그대로). **추가 LLM 호출 없음**. relevant 글만 `thesisRepo.storeSignals`로 저장(스레드 매핑은 id 우선·code 폴백, verdict/tier 한↔영 정규화, 알 수 없는 스레드 참조는 skip, newThread는 candidate 행). **관련성/요약 게이트 불변** — 신호는 부가 출력일 뿐.
- **집계는 시스템**(`thesisRepo.listWithStats`): 스레드별 7/30일 verdict 카운트·총합·마지막 신호일(LLM 신뢰도 아님). 7일 net(강화−약화−반증) 화살표, 30일 반증>0이면 카드 상단 빨강 경고.
- **탭 "논지 지도"**(`ThesisMapPage.tsx`, App **맨 오른쪽 탭**, 리포트 다음): 스레드 카드(코드 배지·명제·집계·추세, 펼치면 신호목록+원문/?article 링크·반증 위로 정렬), 스레드 CRUD/보관, **신규 논지 후보 인박스**(붙이기→assignSignal / 승격→promoteSignal / 버리기→dismiss), **A~E 시딩**(`thesis.seed`, 비어있을 때만). tRPC `thesis` 라우터 + `data/client.ts` 메서드. 정적 데모는 샘플/무동작 스텁.
- **남은 것(다음 세션)**: ① 다이제스트 = changelog(움직인 논지만 + 스레드 밖 신호 한 줄 + 변동 없으면 "오늘 논지 변동 없음"), ② Feed 카드 스레드 배지(`A 강화`) — feed.list에 신호 조인 필요, ③ A~E 명제 실제 내용으로 사용자 편집, ④ '보관' 복구 UI(서버 setArchived(false)·includeArchived는 이미 지원, UI만 없음 — 보관하면 화면에서 못 봄; 사용자가 일단 그대로 두기로 함).

## 검증·배포
- `npm run typecheck` / `npm run build` 통과 후 커밋·푸시. 빌드는 client(vite)+server(tsc). gramjs(telegram)는 server 전용.

## 알려진 버그 (디버깅 인계)
- **다이제스트 각주 `↩`(원문 복귀)가 간헐적**(가끔 됨/안 됨). 본문 `[N]` 클릭→참조→`↩`가 보통은 누른
  발생 위치로 돌아오나 **가끔 맨 위 첫 발생으로** 점프. 서버는 단일 ↩(`href="#cite-N"`, 첫 발생만
  `id="cite-N"`)로 원복됨(커밋 8c7bfe7). 클라 `DigestPage.tsx`에 자동추적 있음: `lastCite`(Map
  N→발생 sup.id)에 `[N]` 클릭 시 기억, `↩` 시 그 위치로 `jumpTo`. 발생별 id는 useEffect(deps
  `[digest.data, selectedId]`)가 부여하며 시작에서 `lastCite.current.clear()`.
  - **유력 원인**: react-query가 digest를 background refetch(window focus 등)하면 `digest.data`
    새 객체 → id useEffect 재실행·`lastCite` clear → 클릭~↩ 사이 비워지면 ↩ 폴백(맨 위). 둘째로
    id 부여 전 클릭 타이밍.
  - **수정 방향**: `lastCite`를 `selectedId` 변경 때만 clear, 또는 클릭 시 발생 id를
    sessionStorage/hash에 즉시 저장(맵 의존 제거), 또는 digest `useQuery`에
    `refetchOnWindowFocus:false`+`staleTime`. 재현: 디제스트 열고 포커스 아웃→복귀 후 `[N]`→↩.

## 🔥 LLM 파이프라인 장애 대응 (2026-08-23 대규모 디버깅 — **새 세션은 반드시 읽을 것**)

하루 동안 **다이제스트가 아예 안 만들어지고 DeepSeek 토큰만 태우던** 사고를 추적·수리한 기록.
버그가 하나가 아니라 **줄줄이 겹쳐 있었고**, 하나를 고칠 때마다 뒤에 숨은 다음 게 드러났다.
아래 "되돌리지 말 것"이 핵심 — 여기 적힌 방어들은 전부 실제로 돈이 샌 뒤에 넣은 것이다.

### 증상 → 원인 사슬 (시간순으로 드러난 순서)

| # | 증상(화면) | 진짜 원인 | 고친 커밋 |
|---|---|---|---|
| A | `LLM API 400: unexpected end of hex escape at position 19243` | 프롬프트 절단(`slice`)이 **이모지 한가운데**를 잘라 반쪽(lone surrogate)이 남음. `JSON.stringify`는 `\ud83d`로 내보내고 Node는 통과시키지만 **서버측 엄격 파서(serde_json)는 거부** | `f35110b` |
| B | 빨간 **`Load failed`** (앱 에러 아님) | `runEvening`이 HTTP 요청 안에서 맵리듀스를 통째로 `await` → 모바일/엣지 타임아웃 | `4c35016` |
| C | 다이제스트는 생겼는데 **"### 묶음 1, 2 제목만 있고 내용 없음"** | `ANALYSIS_MODEL=deepseek-v4-pro`가 **추론형**이라 `max_tokens`를 사고에 다 쓰고 `content=""`로 200 반환. `complete()`가 `(content ?? "").trim()`으로 **빈 문자열을 조용히 통과** → 재시도도 로그도 없이 쓸모없는 리포트 저장 | `45bd058`·`3f7750f` |
| D | **하루에 토큰 400만 개** 소모 | `catchUpRoutines`가 "오늘 자동본이 **저장**돼 있나"로만 판단 → C 때문에 저장이 안 되니 **부팅마다 재실행**. push=자동재배포=부팅이라 **고치려고 배포할 때마다 재실행**됨 | `7b87ad1` |
| E | 07시 루틴을 고쳐도 수동 생성이 빈손 | 폼 기본 날짜가 가리키는 창을 **07시 sweep이 이미 비웠음**. 게다가 열린 창을 직접 골라도 서버가 조용히 되돌려 **오늘 글로는 만들 방법이 아예 없었음** | `f53055f` |

### 실측 증거 (DeepSeek 사용량 2026-08-22, v4-pro)
```
Input (Cache hit)  2,614,784   ← 83%가 동일 프롬프트 재전송
Input (Cache miss)   511,983
Output               917,097   ← 콜당 ~7,000 = max_tokens 한도 꽉 참, 그런데 내용은 0자
```
글 323건이면 1회 실행에 12콜(11청크+종합) → **하루 10~15회 통째로 재실행**, 전부 빈손.
하루 비용 ~$4.4(한 달 $9.70의 절반). **정보량이 아니라 반복이 원인**이었다.

### 지금 들어가 있는 방어 (⚠️ 되돌리지 말 것)

1. **`stripLoneSurrogates()`** (`analysis/anthropic.ts`) — 모든 LLM 요청의 system·user에 적용.
   우리 절단부뿐 아니라 **소스 피드가 깨진 문자를 줘도** 막는 마지막 관문. 정상 이모지는 보존.
   추가로 `digest.ts`·`analyze.ts`의 `clip()`이 절단 위치가 상위 서로게이트면 한 칸 당겨 자른다.
2. **빈 응답 = 에러** (`completeOpenAI`) — `content`가 비면 `finish_reason`·`reasoning_content` 길이·
   `usage`·`max_tokens`를 담아 **throw**. 조용한 통과가 C의 본질이었다. `finish_reason=length`인데
   내용이 온 경우에도 경고를 남긴다(반쪽 결과 방지).
3. **DeepSeek V4 호출별 thinking 정책** — V4 API는 thinking이 기본 ON이라 기사별 1차 분석까지
   매번 사고 토큰을 쓰면 Flash 비용이 폭증한다. 앱은 일반 호출에
   `{"thinking":{"type":"disabled"}}`를 안전 기본값으로 자동 전송하고, 다이제스트는 호출별 값을
   마지막에 덮어쓴다: **필터·맵·Flash 폴백 OFF / 최종 Pro만 ON**. 전역 `LLM_EXTRA_BODY`에 오래된
   thinking 값이 있어도 단계 정책이 우선한다. 비상 시 `DIGEST_PRO_THINKING=0`으로 최종 Pro도 끈다.
4. **2단 모델 파이프라인** (`digest/modelPipeline.ts`) — 초기 수습 때 `digest.ts completeRetry`에
   넣었던 단순 폴백을 이후 세션이 전용 모듈로 승격시켰다. 현재 구조:
   - **맵(자료 정리) = Flash**, **최종(연결·작성) = Pro**. 값싼 모델로 대량 압축하고 비싼 모델은
     종합 1회에만 쓴다. Flash 맵은 Thinking OFF, 최종 Pro는 Thinking ON(기본 high)이며 사고와 본문이
     같은 `max_tokens`를 쓰므로 단 한 번의 Pro 호출에 최소 24576을 확보한다.
   - `completeDigestStage` 최종 시도 순서: ① Pro 원래 예산(기본 최소 24576) **1회** → ② 실패 사유 저장 →
     ③ 같은 Pro 재시도 없이 Flash(`DIGEST_MAX_TOKENS`, 기본 8192)로 즉시 폴백. 맵 단계만 같은 Flash를
     1회 재시도한다.
   - **맵 호출은 보통 `fallbackModel`을 안 넘긴다** — Flash가 Flash로 재시도하고, 깨진 청크는
     자리표시자로 드러난다. **최종 호출만 Flash를 폴백으로 넘겨** Pro 1회가 실패해도 완성본은 남긴다.
5. **`ModelTrace` v2** (`modelPipeline.ts`) — 스테이지별(map/final)로 `configured`/`planned`/`used`/
   `attempts`/`retries`/`fallbacks`/`failures`를 `digests.meta.models`에 기록(마이그레이션 불필요).
   클라 배지가 리포트 위에 `자료 정리 <flash> → 최종 연결·작성 <pro>` 형태로 표시하고,
   폴백이 돌았으면 그 사실을 드러낸다. 서버 로그에도 같은 정보가 남는다.
6. **맵 청크 부분실패 내성** (`mapStage`) — 청크별 try/catch. 실패한 묶음은
   "요약 실패, 이 번호들은 인용하지 마세요" 자리표시자로 남겨 **구멍을 숨기지 않고** 나머지로 종합.
   전부 실패면 throw해 **쓸모없는 리포트가 저장되지 않게** 한다.
7. **catch-up 일일 상한** (`scheduler.ts`) — settings KV `digestCatchUp`에 날짜별 슬롯 시도 횟수를
   기록하고 **하루 2회**로 제한. **실행 전에 카운트를 올려** 실패해도 루프가 멈춘다. D의 증폭기 차단.
8. **경계·낮분 수동 실행 백그라운드화** — 빠른 부분(진단 쿼리·`tooEarly`)만 동기, 무거운 부분은
   `void`로 띄우고 즉시 `{started:true}` 반환. 클라는 `generate`가 쓰던 폴링(`genState`)을 재사용.

### 진단하는 법 (Railway 로그 태그)
```
[llm] 빈 응답 (model=…) finish_reason=length reasoning_len=… tokens(…) max_tokens=…
[llm] 응답이 max_tokens(N)에서 잘림 …
[digest] <제목>: 모델 A + B (폴백 N콜) · 실패 묶음 M개
[digest] 묶음 N 요약 실패([a]~[b]): …
[digest] 경계 루틴 완료/실패: …
[scheduler] catch-up: … 오늘 이미 N회 시도해 건너뜁니다
[kofia:credit|forcedLiq] 자릿수 마스킹(#) N개 복원 후 파싱 성공
```

### 하지 말 것
- `complete()`가 빈 문자열을 그대로 반환하게 되돌리기(사고 C의 원인)
- 맵 단계를 다시 추론형(Pro)에 맡기기 — 사고 C가 정확히 그 구성이었다
- catch-up 상한 제거(사고 D의 증폭기)
- `generateDigest`에 "사용자가 고른 날짜를 서버가 되돌리는" 로직 재도입(사고 E)
- 절단(`clip`/`slice`)에서 서로게이트 경계 검사 제거(사고 A)
- 실패해도 리포트를 저장하게 만들기(빈 리포트가 목록을 오염시킨다)

---

## 다이제스트 날짜 규칙 (사고 E 이후 확정 — 헷갈리기 쉬움)

**날짜 = 창이 "끝나는 날"**이다. `D` 선택 → `[(D-1) 07시, D 07시)`.

⚠️ **07시 경계 루틴은 종합을 마친 창을 곧바로 휴지통으로 sweep한다**(`trashWindowFeed`가 `deletedAt`을
찍고 `fetchFeedRows`는 `isNull(deletedAt)`로 거른다). 따라서 **이미 마감된 날을 고르면 피드가 비어
저장 다이제스트로 대체 종합**된다. **오늘 모인 글로 만들려면 아직 열려 있는 창**(`currentWindowDate`,
07시 이후엔 내일 날짜)을 골라야 한다.

- 폼에 **빠른 선택 버튼 2개**: `[오늘 모인 글 (진행 중)]` / `[어제분 (마감됨)]`.
- **날짜 칸 바로 아래에 그 날짜가 뜻하는 실제 구간**을 표시(`spanOf`). "23일"만으로는 22~23인지
  23~24인지 알 수 없던 게 혼란의 뿌리였다.
- **저장된 다이제스트 목록**도 동일: 네비게이터 아래에 그 날짜 탭이 덮는 구간(`tabSpan`), 각 칩에
  자기 구간(`chipSpan`)을 병기.
- 서버는 **사용자가 명시한 날짜를 그대로 존중**한다(옛 `looksLikeStaleDefault` 재작성 제거).
  날짜를 안 보내면 종전대로 만든 날(`kstToday()`)로 파일링.
- **저장 목록 그룹핑(`dateOf`)은 자동/수동이 다르다**:
  - 자동본 → **창 끝 날짜**(`periodEnd`). 아침분·낮분이 그 날짜 탭을 이루고 `tabSpan`과 일치.
  - 수동본 → **만든 날(KST `createdAt`)**. 8/23 오후에 `[8/23 07시, 8/24 07시)` 창을 만들면
    `periodEnd`는 8/24지만 사용자는 "23일에 만든 것"으로 찾는다 — 라벨로 묶으면 **오늘 만든 게
    내일 탭에 숨는다**(실제 혼란 사례). 어느 기간을 종합했는지는 칩의 `chipSpan`이 보여준다.

**자동 두 슬롯은 검증됨**(`DIGEST_HOUR=7`·`DIGEST_MIDDAY_HOUR=16` 실계산):
```
아침분(D) = [(D-1) 16:00, D 07:00)     낮분(D) = [D 07:00, D 16:00)
경계가 정확히 맞물려 구멍·겹침 0. 07시 sweep 창 [(D-1) 07:00, D 07:00)도
낮분(D-1) + 아침분(D)이 빈틈없이 덮는다 → 종합 안 된 글이 지워지는 일은 없다.
```
자동 실행은 `{auto:true, slot, start}`를 넘기므로 위 서버측 날짜 로직 변경과 **무관**하다.

---

## Railway 비용 구조 (2026-08 실측 — $33/월의 정체)

프로젝트가 **3개**였다(하나만 보고 오해하기 쉬움):

| 프로젝트 | 서비스 | 메모리 | 월 추정 |
|---|---|---|---|
| `motivated-flow` | web1 (앱) | ~230 MB | ~$2 |
| `spirited-courtesy` | MySQL | ~630 MB | ~$6 |
| `illustrious-recreation` | **RSSHub(chromium-bundled)** + Redis | **~2.5 GB** | **~$26** |

**RSSHub가 범인**이었다 — X 수집의 옛 폴백(`X_RSS_BRIDGE`)인데, 쿠키 직접수집이 1순위로 동작하는
지금은 **코드가 아예 타지 않는다**(`x.ts`: `if (hasXSession()) return fetchDirect(...)`). 소스 24개를
전수 확인한 결과 rsshub 주소를 쓰는 소스는 0개. 브라우저를 통째로 담은 이미지라 상시 2.5GB를 잡는다.
→ 삭제 시 월 ~$26 절감.

**DeepSeek은 Railway와 별개 청구**다(LLM 호출 비용). Railway엔 egress 바이트만 잡힌다.

⚠️ **코드에 남은 구조적 비용 요인**(당장 급하진 않으나 계속 커진다):
`articles` 행을 **물리 삭제하는 코드가 0건**(영구삭제도 묘비만 남김) · `articles.url` 인덱스 없어
수집 시 아이템마다 O(N) 스캔 · `analyze.ts`의 `id NOT IN (SELECT …)` 정상상태 전수 스캔 ·
`analyses.created_at`/`articles.deleted_at` 인덱스 없음 · `content:encoded` 전문을 그대로 저장하는데
LLM엔 5000자만 씀 · 휴지통 자동 만료 없음 · `marketSnapshot` KV가 37KB→~642KB(시리즈 6→22,
`HISTORY_DAYS` 370→1825)인데 **응답 압축 미들웨어 없음**.

## 탭 구성 (`src/client/App.tsx`)
순서(10개): **시황분석 / Daily Digest / Feed / 보관함 / 분석(수동) / Sources / 휴지통 / Settings / 리포트 / 논지 지도**.
- **시황분석**(tab 1, `src/client/pages/MarketPage.tsx`): 시장 지표 대시보드 **✅ 구현 완료**. 하루 1회 배치 수집(기본 07시 KST `MARKET_HOUR`) → `settings` KV(`key="marketSnapshot"`, 마이그레이션 불필요)에 JSON 스냅샷 저장. tRPC `market.latest`(저장본)·`market.refresh`('지금 갱신' 버튼=즉시 재수집). 서버 수집기 = **`src/server/market/`**: `cnn.ts`/`tradingview.ts`/`adr.ts`/`index.ts`(병렬·소스별 tolerant — 한 곳 실패해도 나머지 진행, 실패는 `errors[]` 한국어 메모). 스케줄러(`scheduler.ts`)에 일일 크론 + **부팅 시 스냅샷 없거나 20h↑ 오래되면 즉시 수집**.
  - **S5FI / NDFI**(S&P500/나스닥100 50일선 위 비율, breadth) — **TradingView 쿼트 websocket**(`wss://data.tradingview.com/socket.io/websocket`, 심볼 `INDEX:S5FI`/`INDEX:NDFI`). ⚠️ scanner REST(`scanner.tradingview.com/.../scan`)는 이 심볼(barchart EOD) **0건 반환**이라 못 씀. ⚠️ ws 핸드셰이크에 **`Origin: https://www.tradingview.com` 헤더 필수**(없으면 non-101 거부) → native WebSocket 불가, **`ws` 라이브러리 사용**(deps에 추가함). `update_mode=endofday`(미국 장마감 후 확정). 값=`lp`, 변화=`ch`/`chp`.
  - **CNN Fear & Greed** — JSON `https://production.dataviz.cnn.io/index/fearandgreed/graphdata`. ⚠️ **브라우저 UA + `Origin/Referer: edition.cnn.com` 헤더 필수**(없으면 418 "I'm a teapot. You're a bot."). `fear_and_greed.{score,rating,previous_close,previous_1_week/month/year}`.
  - **ADR 코스피/코스닥** — `http://adrinfo.kr/` HTML. 페이지 내 인라인 JS 상수 파싱: `data_kospi_daily=[{time,adr},…]`(마지막=현재값)·`kospi_daily_last_adr=NN`(전일종가). kosdaq도 동일. KR 장마감(15:30 KST) 확정.
  - **타이밍 메모**: US 소스(F&G·S5FI·NDFI)는 미국 장마감 후=KST 새벽 확정, ADR은 전일 KR 장마감 확정 → **07시 KST 단일 배치**가 세 소스 모두 가장 신선한 *확정값* 포착(US는 밤사이, KR은 전일 종가). `MARKET_HOUR` env로 조정.
  - **레이아웃**: 지표별 **개별 차트**(오버레이 X). 순서 = ① 공포·탐욕 / **커스텀 심볼 슬롯** ② NDFI / S5FI ③ 코스피 ADR / 코스닥 ADR. 차트마다 **사용자 지정 기준선**(낮음/높음 number input, `localStorage` `mkt.ref.<id>`에 저장, 오렌지 점선; auto-domain이 기준선 포함해 항상 보이게). 기본값 F&G·NDFI·S5FI·ADR=25/75, 커스텀=없음.
  - **커스텀 슬롯은 캔들차트**(이 칸만, 나머지는 라인): TradingView처럼 **OHLC 캔들** + **타임프레임 토글**(4시간`240`/일`1D`/주`1W`/월`1M`/년`12M`, `mkt.tf.custom`에 저장). tRPC `market.candles({symbol,timeframe})`가 ws로 라이브 OHLC fetch(저장 안 함, react-query 캐시 staleTime 5분). `fetchCandles`=`fetchBars`(resolution·count 일반화)→`{t,o,h,l,c}`. 클라 `CandleChart.tsx`(의존성 없는 SVG 캔들, 상승 녹색·하락 빨강, 호버 OHLC 툴팁, 기준선 공유). 봉수: 4h 360/1D 260/1W 260/1M 240/1Y 40. **휠 줌(커서 기준 앵커)+드래그 팬**(viewport=`{count,end}` state, symbol+tf로 remount 리셋), **오른쪽 가격축**(nice-ticks 라벨+그리드+현재가 태그; SVG는 `preserveAspectRatio=none`이라 텍스트 왜곡돼서 **가격 라벨은 HTML 오버레이**, 캔들·그리드만 SVG). 휠은 native non-passive 리스너로 preventDefault.
  - **커스텀 심볼 슬롯**(옛 VIX 자리): 사용자가 **TradingView 심볼을 직접 입력**해 갈아끼움(VIX·WTI·개별주·코인 등). 서버 `setCustomSymbol`(settings KV `marketCustomSymbol`, 기본 `CBOE:VIX`)이 그 심볼만 재수집해 스냅샷에 머지(전체 재수집 안 함). tRPC `market.setSymbol`. 심볼은 `fetchSymbol`(차트 ws). **티커만 입력해도 됨** — 차트 ws가 bare 티커를 자동 해석(`aapl`→`NASDAQ:AAPL`, `005930`→`KRX:005930`, `USOIL`→`TVC:USOIL`, `BTCUSD`→`BITSTAMP:BTCUSD`); `symbol_resolved`의 **`pro_name`=정식심볼**을 저장(다음 배치도 그 심볼로). description=표시명. `symbol_error`·실패 시 빈 결과→한국어 에러("심볼을 찾지 못했습니다"). ⚠️ `symbol-search.tradingview.com`은 데이터센터 IP에서 403 자주 떠서 안 씀 — ws 자동 해석으로 대체. 기준선은 **심볼별로 기억**(`mkt.ref.custom:<resolved>`). 확인: aapl/NVDA/005930/USOIL/BTCUSD/TSLA end-to-end OK.
  - **그래프(최근 ~5년)**: 6개 지표 모두 일별 히스토리 차트. 수집기가 현재값 + ~1년 히스토리를 함께 받아 `snapshot.history`에 저장(`SeriesPoint{t,v}[]`, 약 250점/시리즈, 전체 ~37KB). 소스: F&G=`fear_and_greed_historical.data`(252점), S5FI/NDFI=TradingView **차트 히스토리 ws**(`from=chart`, `resolve_symbol`+`create_series` 1D 400봉; ⚠️**익명 세션은 series 1개 제한** "exceed limit of series" → **심볼당 연결 1개**씩 병렬), ADR=`/chart_indx`의 `dataSet={KOSPI:{adr:[[ts,v]…]},KOSDAQ:…}`(2019~; ⚠️**배열 끝 trailing comma + 미래날짜 `null`** 있어 `,\s*]`→`]` 치환 후 JSON.parse·숫자필터). 슬라이스=`sliceLastYear`(**기본 `HISTORY_DAYS`=1825일≈5년**, 소스가 그만큼 있으면; TradingView `BARS`=1300, 신용 조회 1850일로 확장). **모든 라인 지표 차트 = `InteractiveLineChart.tsx`**(커스텀 캔들처럼 휠 줌·드래그 팬·오른쪽 가격축·풀 크로스헤어[세로+가로선, 커서 위치 가격/값]; **툴팁은 커서 왼/오로 비켜 떠 선을 안 가림** — `translateX` 오프셋, `valAt`는 이진탐색) + **일/주/월/년 토글**(`LineChartBlock`, 클라 리샘플=버킷당 마지막값, `mkt.tf.<id>` 저장, key=tf로 remount). 옛 `MarketChart.tsx`(`MultiLineChart`)는 미사용. **다년 히스토리는 재수집 후 채워짐**(기존 스냅샷은 1년치라 배포 후 '지금 갱신' 또는 일일배치 필요). 부팅 시 **히스토리 없으면 즉시 재수집**.
  - **egress**: Railway(프로덕션)는 아웃바운드 기본 개방이라 동작. 세 소스 모두 실서버 모듈 end-to-end 확인됨(errors 0, 히스토리 252/254/254/248/248점). 데모 모드(`VITE_STATIC_DEMO`)는 `SAMPLE_MARKET`(사인파 더미 히스토리). ⚠️샌드박스는 playwright 브라우저 다운로드 차단(egress)이라 스크린샷 검증 불가 — 빌드/타입체크로 확인.
  - **미국 순유동성 카드**(`liquidity.ts`, 맨 아래 전폭): 순유동성 = 연준자산(WALCL) − 역레포(RRPONTSYD) − TGA(WTREGEN), 지급준비금(WRESBAL) 오버레이 2선. 소스=**FRED `fredgraph.csv?id=WALCL,RRPONTSYD,WTREGEN,WRESBAL`**(API키 불필요, 다중 시리즈 CSV). ⚠️**단위 주의**: WALCL/WTREGEN/WRESBAL=백만$, RRPONTSYD=**십억$** → 전부 $조로 정규화(`TO_TRILLIONS`). WALCL/TGA/WRESBAL은 **주간**(수 기준·목 공표), RRP만 일별 → 순유동성은 WALCL 주간 날짜에서 계산(RRP는 그 날짜 이하 최근값 carry-forward). 현재값+4주변화(임펄스)+지급준비금/RRP/TGA 레벨 표시. **기준선 없음·RefControls 없음**(임계 없는 지표), "주간·후행·매매신호 아님" 배지 + 경고문(2023 AI랠리 때 지수와 반대로 감). ⚠️**소스 라우팅(2번 삽질 끝 확정)**: ① FRED `fredgraph.csv`는 주기 다른 다중 id 요청 시 **ZIP 반환**(단일 id=순수 CSV). ② 더 치명적: **fred.stlouisfed.org가 Railway 데이터센터 IP를 무응답 드롭**(4시리즈 전부 "타임아웃 N초 무응답" — egress 허용해도 소용없음). **해결: 주 경로 = TradingView 차트 ws의 `FRED:<ID>` 미러 심볼**(S5FI/NDFI와 같은 파이프, Railway 검증됨; `tradingview.ts fetchCloses` 재사용) + FRED 직접 CSV는 폴백. `FRED:WALCL`/`FRED:RRPONTSYD`/`FRED:WTREGEN`은 TV에서 순유동성 계산용으로 널리 쓰여 존재 확인됨. TGA/RRP는 WALCL 날짜에 carry-forward 매칭(TV 바 날짜 어긋남 대비). ✅계산 로직은 실데이터(curl 1년치)로 검증: 순유동성 $5.84T, 지급준비금 $2.97T(3조 아래=레포 스트레스 근접 실신호), RRP≈0, TGA $0.88T. TV 경로 실동작은 Railway 배포 후 '지금 갱신'으로 확인. ⚠️**TV 동시연결 한도(2026-07 실측 버그)**: 스냅샷 1회가 TV ws를 ~9개(S5FI/NDFI/커스텀/유동성4/코스피/VKOSPI) **동시** 개방 → 익명 세션 레이트리밋에 걸려 경합에서 진 심볼(관측: TGA·VKOSPI)이 빈 응답 → '데이터 없음'. **해결: `tradingview.ts`에 프로세스 전역 세마포어(`TV_MAX=3`, `tvAcquire/tvRelease`)로 모든 `fetchBars`를 게이트** — 배치가 몇 초 더 걸리지만 전 심볼이 안정 수신. **부분 실패 내성**: 이전엔 TGA 한 시리즈만 죽어도 `fetchLiquidity`가 throw→카드 전체 '데이터 없음'이었음 → 이제 **전 시리즈 전멸일 때만 throw**, 하나라도 살면 그 개별 차트(지급준비금/TGA/RRP)를 렌더(net은 WALCL+TGA 둘 다 있을 때만 계산, 없으면 `quote.net=null`+헤더에 '일부 미수집' 표기). TGA는 `FRED:WTREGEN`→`FRED:WDTGAL`(일별) 폴백 심볼 추가.
  - **K-공포지수 대시보드**(맨 아래, `KFearPanel.tsx`+`kfear.ts`): 검증된 레퍼런스(사용자 제공 `capitulation_backtest.py`/`fear_index.py`/`fear_executor.py`) 로직을 **TS로 이식**. **코스피·코스닥 개별** 계산: **FEAR(0~100)** = 4성분 동일가중 평균(**252일 롤링 분위수 정규화**) — F1=1−pct(신용 10일변화율), **F2=pct(반대매매 금액·절대치 — v4)**, F3=1−pct(60일 이격도), F4=pct(20일 실현변동성=**VKOSPI 대용**) — mean은 pandas처럼 **skipna**. **3신호**: S1 신용청산(피크 −8%&10일 −3%&지수10일↓), **S2 반대매매(v5 복원: 반대매매 금액 1년 상위5% 스파이크[6일내 분위≥0.95] & 금액 2일 연속 하락[엄격, 동률·ffill 제외] — v4의 '스파이크 당일 단일조건'을 원설계로 되돌림; 근거=MDD 7/8 개선·STRONG 진입가 −2.4~3.9% 우위, 수익 우열은 노이즈로 미증명)**, S3 이격도60(≤−8% or 1년 하위5%). **등급**(fear≥90&3신호=STRONG / fear≥90&2신호=BUY / fear≥90&≤1신호=ARMED / fear<90&2신호=WATCH / else IDLE). **권장 비중(v4 통합, 우선순위 ①→② 엄수, `computeSizing(grade,creditDd,dispDev,isSolo)`)**: ①코스닥 단독(코스피 미동반)=**0%**(등급 무관·관찰, `KOSDAQ_SOLO_CAP`=0) → ②**등급 기본비중 × 이중 얕음게이트**. 등급비중=`GRADE_WEIGHT`{STRONG100·BUY60·ARMED50·WATCH45·IDLE0}(**depth 4단 사다리 폐지** — FEAR≥90 시점엔 신용 이미 깊어 무의미, 20건 중 18건 이미 DD≤−8%). **이중 얕음게이트**(`shallowGate`): 신용DD>−8% **AND** 이격도편차>−7% 둘 다 얕으면 ×0.5(가짜바닥), 하나라도 깊으면 ×1.0(하나만얕음 실측 +23.8%라 안 깎음; 신용·이격도 무상관 −0.04 독립정보). STRONG도 게이트 적용(얕은 3신호 방어). `Sizing.path`=SOLO/GATED/FULL/NONE로 UI 분기(depth 사다리 UI 제거→이중게이트 상태 표시). **반대매매 절대금액**: `forcedLiq.ts`가 `{ratio,amount}` 반환 — 비중(%)은 07-07=2.2 앵커고정(폴백=중앙값 스캔), **금액 컬럼**(`extractAmount`)은 **이중 2점 비율**(07-09/07-07≈4.48 **AND** 07-10/07-08≈2.83[=81613/28846], **완전 스케일무관·크기게이트 없음**)로 식별해 `forcedLiqAmount`로 수집. ⚠️값은 화면 백만원이 아니라 **원÷8 스케일**(신용잔고와 같은 게이트웨이 아티팩트, TMPV6; ×8÷1e6=백만원=화면). pct252는 스케일 무관이라 raw 저장. 금액 미식별 시 비중 폴백(criteria '⚠비중 폴백'). **차트 4개/카드**: FEAR(임계 90)+S1 신용DD(−8·−15)+S2 반대매매 금액 분위(95=상위5%)+S3 이격도 편차(−8), 모두 완전워밍업 동일 인덱스 정렬(`s1/s2/s3History`). 유닛테스트 T1~T12(scratchpad `v4_test.ts`, T5≠T6=게이트 핵심)·S2/F2 금액·폴백 통과. 6달 가중 +16.3%(현행 +11.5%). **코스닥 동반 판정**: kospiAccompanies=코스피FEAR≥90 → SYSTEMIC/KOSDAQ_ONLY. 계산 **전부 클라**(`kfear.ts`, stored history), `__test`로 헬퍼 유닛테스트(scratchpad). **VKOSPI 문제 해소**(F4가 실현변동성으로 대체 — 못 가져오던 VKOSPI 불필요). **데이터**: `server/market/koreaIndexes.ts`(구 capitulation.ts)가 TradingView `KRX:KOSPI`/`KRX:KOSDAQ` 종가 1200일, `forcedLiq.ts` 반대매매 1200일(FEAR 252창+60이평 워밍업 확보), 신용은 5년. 면책(소표본 n=6~16) 상시 표기. ⚠️**KOFIA T+1 정렬(중요)**: 지수(TV)는 당일, KOFIA(신용·반대매매)는 T+1이라, 평가 "오늘"(기준일)을 **KOFIA가 실제 있는 마지막 거래일**로 맞춘다(`buildMarket`이 price를 `min(credit,liq 마지막)` 이하 kstDay로 truncate). 안 그러면 지수-앞선 하루가 KOFIA ffill로 flat이 돼 **F1/F2/S1·반대매매 금액 분위수가 왜곡**된다(7/8 지수 있는데 KOFIA는 7/7까지 → 7/8=7/7 복사). 그래서 기준일이 어제로 뜰 수 있음(정상). (v3의 'S2 2일 연속↓ 깨짐' 예시는 v4에서 그 조건이 폐지돼 무효 — 정렬 필요성 자체는 유효.) ⚠️**데이터 정합성 방어(`anchors.ts`)**: 소스가 조용히 틀어지면(×8 배수 변경·TMPV 컬럼 이동·심볼 변경) 전 신호가 무의미 → 실측 앵커로 2겹 방어. **HARD assert**(수집기 내부, 불일치 시 throw→소스 통째 거부→화면엔 '수집 실패'만, 이상값 X): 신용 유가 07-07=29.075조·코스닥 07-07=7.990조·전체 06-24 합=38.633조(assertAnchorSum, 한 컬럼만 스케일 틀어져도 잡음), 반대매매 07-07=2.2%, 코스피 06-23=8203.84·07-08=7246.79. 날짜매칭은 **ms 허용오차**(KOFIA=0 정확, 지수=`TZ_TOL_MS`20h로 tz오프셋≤15h만 잡고 인접거래일≥24h 배제 — 앵커일 봉 없을 때 옆날 잘못잡아 false-throw하는 버그 방지). **SOFT 경고**(`checkAnchors`→errors[]): staleness(지수<KOFIA−2일)·앵커 전부 창밖(2029경 노후) 알림. 반대매매 컬럼선택도 중앙값→**앵커고정**(07-07=2.2 컬럼). 신용 히스토리 부족 시 S1이 '조용히 미충족' 안 되게 커버리지 가드(최근252창 유한<200→'데이터 부족' 표기). 코스닥 종가도 정밀 앵커(07-08=785.00·07-07=831.23, Investing 실측)로 검증하되 **코스닥만 드롭**(오종목이 코스피까지 안 죽이게, `anchorViolated` 소프트)+sanity band(200~4000) 폴백. **KST 거래일 정렬(`kstDay`)로 tz 문제 근본 해결**: 소스마다 타임스탬프 규약이 달라도(KOFIA=UTC자정, TV 일봉=UTC자정 or 전일15:00Z=KST자정) +9h 후 날짜로 내려 같은 거래일이면 같은 키 → `alignFfill`·`lastKofia` truncate가 결정적으로 맞음(지수-앞선 하루가 ffill로 KOFIA 1일 밀리던 잠재 이슈 제거). 밀리던 지표는 S1/S2/F1/F2(KOFIA계열)뿐이었고 S3/F3/F4(지수계열)는 무관했음. ⚠️미구현(문서 4~5): 과거 신호 성적표·방식 비교(2020~ 백테스트는 히스토리 확장 필요). 파서 실검증은 Railway '지금 갱신' 필요.
  - **US 진입신호 실행기 ✅ 구현 완료**(K-공포지수 바로 아래, `USEntryPanel.tsx`+`usEntry.ts`): 나스닥 진입신호를 **절대값 2트랙**으로(지시서 `US_진입신호_CLAUDE_CODE v1.0`, 7788조합 백테스트). **TERM=VIX/VIX3M**(만기구조 역전). **A(주 진입)=TERM≥1.05**, **B(강 신호)=TERM≥1.00 & HY OAS≥4.5%**, MEGA 배지=VIX≥40. 상태머신 IDLE/WATCH(TERM≥0.95 or HY≥4.25)/ARMED(TERM≥1.00)/ACTIVE_A|B|AB/POST(소멸후 21거래일). **3단 티어**(예비대→본대→최대): **Tier 0 조정매수**=나스닥 IXIC 고점(52주)대비 −8% & **200일선 위**(추세 필터가 강세장 조정↔하락장 자동 구분 — 하락장은 −8% 시점 이미 200일선 아래라 꺼짐, `rollMax`252+`rollMean`200으로 IXIC 계산, DD≤−8% & above200)→소량(10~20%), **Tier 1 주신호**=A or B→본대, **Tier 2 확인상향**=AB/MEGA→최대. Tier 0은 폭락/조정 사전구분 불가(2020-02도 켜짐)라 소량 전용·2단 구조. `usEntry.ts`에 dd/above200/tier0/tier·ddHistory 추가, 유닛테스트로 강세장조정 ON·하락장 OFF 검증. **검증 앵커 13건**(`TIER0_ANCHORS`, 성과 n=13·6달 +21.1%·승률 100%·최악 +5.4%·2022년 0건) — `verifyTier0Anchors`가 실데이터에서 앵커 재현(리콜) 체크, 히스토리 창(≈5년)보다 오래된 앵커(2020~2021)는 '창 밖' 제외, 패널 푸터에 'N/M 재현' 표기. 리트머스=2023-05-03·2023-09-26 재현이면 롤링 정의 정상. IXIC 수집 깊이를 `HISTORY_DAYS`(5년)로 확대(1200→앵커 워밍업 확보). 신호상태(레이어1)=매일 재평가·쿨다운 없음(연속 N일차·첫발동가 대비 나스닥 등락률로 추격 판단), 에피소드(레이어2)=21거래일 병합(직전 발동 표시·통계용). 계산 **전부 클라**(`usEntry.ts`, `__test` 유닛). **데이터=`server/market/usEntry.ts`**가 TradingView 차트 WS 미러로 수집(S5FI/NDFI·FRED 순유동성과 동일 파이프, `fetchCloses`): VIX=`TVC:VIX`(폴백 CBOE:VIX/FRED:VIXCLS), VIX3M=`CBOE:VIX3M`, HY=`FRED:BAMLH0A0HYM2`(ICE BofA US HY OAS, %p), IXIC=`NASDAQ:IXIC`(성과추적용). `shared/market.ts history.{vix,vix3m,hyOas,ixic}` 추가(마이그레이션 불필요, settings KV 스냅샷). ⚠️**HY T+1 정렬**: HY는 T+1 발표라 D일 판정에 **D-1 관측치 사용**(클라에서 거래일 캘린더 ffill 후 shift(1) — 지시서 backtest와 동일). ⚠️**UTC 거래일 키**(US 시계열은 UTC 자정 일봉이라 `dayKey=floor(t/DAY)`로 정렬, K-Fear의 kstDay와 대칭). **§4-4 스냅샷 앵커 검증됨**(2026-07-09 VIX 15.85·VIX3M 18.99→TERM 0.835·HY(D-1) 2.70→IDLE, 유닛테스트 통과). 소표본(n=10, 2008급 미포함) 면책 상시. 진단 로그(`[usEntry]` 최신 TERM/HY/VIX)로 Railway 실값 대조. **차트 3개**: TERM(임계 1.0·1.05)+HY OAS(4.5)+나스닥 고점대비 낙폭(−8=Tier0). ⚠️미구현(선택): 상태전이 텔레그램 알림, 에피소드 성과 앵커 대조 자동화.
    - **VVIX 단기 반등 확인(보조 신호) ✅ 구현 완료**(US 진입신호 카드 안 Tier 사다리 아래 `ReboundBlock`, 계산 `computeVvixRebound`): **최근 3거래일 VVIX≥140 AND 오늘 VIX<전일 VIX** → `CONFIRMED`(그 외 `PANIC`/`IDLE`/`UNAVAILABLE`). **Tier·fired·state·sizing에 일절 영향 없음**(진입 규모가 아니라 "공포가 진정되기 시작했나"만 관찰, 1주~1개월 전용). ⚠️**`computeUsEntry` 밖의 독립 순수함수**여야 함 — 안에 넣으면 VIX3M 실패 시 조기 `return EMPTY`에 걸려 VVIX 카드까지 죽는다(+`EMPTY`는 모듈 공유 객체라 mutate 금지). **판정 행 = `VVIX ∩ VIX` UTC dayKey 정확 조인**(ffill 금지, VIX3M/TERM과 독립) — `TVC:VIX`에 미국 휴장일 유령봉 22개(5년)가 있어 raw VIX로 cooling을 재면 증시 닫힌 날이 하락으로 잡힘(실측). 심볼 `CBOE:VVIX`(폴백 bare `VVIX`) — ⚠️**`TVC:VVIX`·`FRED:VVIXCLS`는 존재하지 않음**(실측 n=0), 폴백에 넣지 말 것. 구멍/stale 방어(`VVIX_LOOKBACK_CAL_DAYS=10`·`VVIX_STALE_TD=3`)로 `carryForwardEmpty`가 되살린 묵은 VVIX × 오늘 VIX 조합 차단. 성과는 **전체표본(2007~ n=14)과 앱 창(2021~ n=5, 재현 검증) 병기** — 전체표본 최악값 4개가 전부 앱 창에서 나와 좋은 성과는 대부분 창 밖. 앵커 `VVIX_REBOUND_ANCHORS` 5건(`verifyVvixAnchors`, 파이프라인 회귀 감지용이지 백테스트 증명 아님). 면책: 140은 절대수준이라 2008 미포착·발동빈도 2020 이후 급증(non-stationary)·채택 규칙도 동일 탐색 산물이라 상방 편향. 상세 = `docs/fear-indicators.md` §2-J.
  - ▶ **남은 개선(선택)**: 장중 ADR 더 자주(추가 크론), 기간 토글(1M/3M/1Y), F&G 색구간 배경, 다이제스트에 시황 한 줄 등.
  - **코스피/코스닥 신용잔고 카드 ✅ 구현 완료**: `src/server/market/credit.ts` = KOFIA FreeSIS `getMetaDataList.do`(service STATSCU0100000070, OBJ_NM=`STATSCU0100000070BO`, 일별). **컬럼(실화면 대조로 확정)**: TMPV2/3/4=신용거래융자 전체/유가/코스닥(=이게 "신용잔고"), TMPV5/6/7=신용거래대주 전체/유가/코스닥, TMPV8=청약자금대출, TMPV9=예탁증권담보융자. ⚠️**단위 함정**: 게이트웨이가 모든 잔고를 **실제 원의 정확히 1/8**로 반환(전 컬럼·전 날짜 일관 — `tmpV40:"08"` 표시 파라미터 탓 추정). 2026-07-07 실화면 대조로 검증: TMPV3 3.634e12 ×8 = 29.07조 = 화면 유가증권. **`KOFIA_UNIT_FACTOR=8`로 ×8 보정 후 /1e12(=`TO_JO` 1.25e11로 나눔)**. `shared/market.ts` `credit:{kospi,kosdaq}`+`history.creditKospi/kosdaq`, `MarketPage`에 카드 2개(기준선 없음). Railway 실서버 동작.
- **리포트**(tab 9, `src/client/pages/ResearchPage.tsx`): 증권사 리포트 애그리게이터 **✅ 구현 완료(파서는 Railway 실검증 대기)**. 오늘 올라온 **기업·산업 리포트만** 모아 카테고리별 정렬, 헤드라인+주요내용(LLM 한 줄 요약)+시총(현재가 아님)+TP·의견 표기. **5영업일 커버리지 카운트** → 5회↑=**주요종목**, 직전 대비 TP 상향=**TP상향종목** 티어업. **소스 2곳(네이버·한경 컨센서스) 병합 수집**, 각 리포트에 출처 배지(네이버 sky/한경 emerald) 표시.
  - **서버 `src/server/research/`**: `naver.ts`(주 소스·양 많음, 기업 company_list+산업 industry_list, EUC-KR 디코드, 목록 파싱+상세 TP/의견/본문, `#_market_sum`으로 시총, externalId `nv:<nid>`) + `hankyung.ts`(consensus.hankyung.com/analysis/list, 목록 컬럼서 TP/의견, 기업·산업만, externalId `hk:<report_idx>`) + `index.ts`(`collectResearch` 둘 다 fetch→ALLOWED 필터→한경 종목코드를 네이버 이름→코드 맵으로 보강→네이버 기업 리포트 TP/의견/요약 enrich→시총 수집[최근 코드 MAX 250, mapLimit 4]→조건부 upsert; `listResearch(date?)`는 커버리지=distinct `broker|reportDate`[교차소스 dedup], TP상향=동일 브로커 직전 TP 비교, 티어 정렬). `types.ts` `ALLOWED_CATEGORIES=Set(기업,산업)`.
  - **DB**: 마이그레이션 0008=`research_reports`, 0009=summary(text)/marketCap(bigint) 추가(논지지도는 0010). tRPC `research` 라우터(`list`/`refresh`). 스케줄러 일일 크론(`RESEARCH_HOUR` 기본 8시 KST) + 부팅 시 12h↑ 오래되면 즉시 수집. Sources 탭 아닌 리포트 탭 자체에 날짜 피커 + '지금 수집' 버튼. 정적 데모는 `SAMPLE_*` 스텁.
  - ⚠️ **파서는 샌드박스 egress 차단(네이버/한경 호스트 blocked)이라 실검증 못 함** — Railway(아웃바운드 개방)에서만 동작. 배포 후 결과가 비거나 어긋나면 사용자가 실제 HTML 붙여주면 파서 튜닝. **양쪽 소스 같은 리포트는 지금 병합 안 함**(카드 2장) — 원하면 병합 가능.

## 방향·다음 작업 (대화 요약 — 인계)
**문제의식**: 현재 구조(피드에 글 쌓고 훑고 지움)가 "신경 끄기" 목표를 재현. 사용자는 **하루 2~3회 다이제스트만** 보고 끝내고 싶어함. 놓침 불안은 필터로 거르지 말고 **다이제스트 "누락금지 규칙"**으로 해결.

**결정**: 별도 사이트 X → **이 앱 안에 새 탭** 추가(Railway 추가비용 ~$0; 사용량 기반·$5 크레딧 포함). 다음 큰 작업 = **논지 지도(Thesis Map) 탭**.

**다이제스트 효율 지침(병행, Settings 적용 권장)**:
- 1차 필터: 넓게(투자·경제·산업·기술과 조금이라도 관련=관련, 광고/스팸만 제외).
- 중요도: 순수 쓰레기(광고·인사·개인일상·무정보반응·완전중복)만 '낮음'. 모델 JSON의
  `lowReason`이 이 5개와 정확히 맞을 때만 검토로 보내며, 기술 구조·병목·대체재·비용곡선·개인 해석·
  미확인 찌라시는 직접 실적 신호가 없어도 '높음'으로 fail-open.
- 요약: 숫자·가격·종목명 보존.
- 2차(편집장 스타일): "오늘의 핵심 3~5 / 신호 연결 / 원문 정독 추천(최대 3~5, [N]만) / 나머지 한 줄(누락금지) / 볼 것 없으면 '없음'".
- 남은 것: 다이제스트 **텔레그램 전송**.

**논지 지도(Thesis Map) 탭 — 설계(다음 세션 구현)**:
- 사용자 프레임워크(스레드 A:NAND/HBF, B:HBM/DRAM, C:광인터커넥트, D:ALAB, E:로보틱스)를 시스템 중심 데이터로.
- DB(수동 마이그레이션): `threads`(id,name,thesis 한줄,context,archived). `signals`(articleId FK, threadId FK, verdict[강화/약화/반증/중립], tier[확정/경영진주장/추론/추측], note, createdAt, unique(articleId,threadId)).
- 1차 분석(`filterRelevant`)에 스레드 목록(이름+한줄명제) 주입 → 출력 JSON에 `signals[]`+`newThread` 추가 → relevant 글의 signals 저장. **추가 LLM 호출 없음**(기존 1차 호출에 합침).
- 신뢰도는 **LLM 아님, 시스템 집계**(7/30일 verdict 카운트·마지막 신호일·추세 화살표).
- 새 "논지 지도" 탭: 스레드 카드(명제·집계·추세, **반증 신호는 맨 위 빨강**, 펼치면 신호목록+원문링크), 스레드 CRUD/archive, **"새 논지 후보" 인박스**(어느 스레드에도 안 맞는 중요 신호 → 승격 시 스레드化), A~E 시딩 버튼. Feed 카드엔 스레드 배지(`A 강화`).
- 다이제스트 = **changelog**: 움직인 논지만 섹션 + 스레드 밖 신호 한 줄(누락금지) + 원문 모음. 변동 없으면 "오늘 논지 변동 없음".
- 원칙: "모든 글 훑기"를 버리고 **"움직인 논지만 보기"**로.

**대안 틀(논의됨, 미채택)**: 알림 모델(트리거 시에만 텔레그램 한 줄)·주간 브리프 모델. 논지지도+알림 조합이 사용자에 적합.
