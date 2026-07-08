# Feed Watch — 인수인계 (HANDOFF)

개인 투자 정보 수집·분석·다이제스트 대시보드. 여러 소스에서 글을 모아 1차로
필터·요약하고, 하루 1회(또는 기간 지정) **다이제스트**로 종합한다.

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
  - `DIGEST_HOUR`(기본 **7**, KST 경계·sweep·메모), `DIGEST_MIDDAY_HOUR`(기본 **17** — 낮분 다이제스트, sweep 없음; 경계 앞이든 뒤든 가능), `COLLECT_INTERVAL_MIN`(기본 30, 현재 10), `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
  - 선택: `DEEP_ANALYSIS=1`(글별 개별 심층분석 on), `FILTER_BODY_CHARS`, `DIGEST_MAX_TOKENS`(기본 8192), `DIGEST_MAP_ITEMS/CHARS/TOKENS`(맵리듀스 청크, 기본 30/45000/3000), `DIGEST_ITEM_CHARS`(다이제스트 글당 본문 상한, 기본 2500), `ANALYZE_ALL`, `FILTER_FEEDBACK_PER_TYPE`(하루 distill에 넣을 액션 타입별 새 피드백 수, 기본 15)
  - **다이제스트 품질/비용 튜닝(중요 글이 많을 때)**: 병목은 입력이 아니라 **출구**(`DIGEST_MAX_TOKENS`)다 — 중요 글 300건/일이면 최종 8192로는 "나머지 한 줄" 목록이 잘림. 권장 상향: `DIGEST_MAX_TOKENS=12288`, `DIGEST_MAP_TOKENS=5000`, `DIGEST_MAP_ITEMS=40`, `DIGEST_MAP_CHARS=90000`(전부 env, 재배포 불필요). 근본 해법은 논지지도 changelog(예정).

## 파이프라인
1. **수집**(`workers/collect.ts`): 소스별 어댑터 fetch → articles 저장. 같은 (source,url) 글이 있으면 재생성 안 함(삭제 부활 방지). **영구삭제(purge)도 행 자체는 안 지우고 묘비(tombstone: analysis·body 제거, url만 유지)로 남겨** 재수집 시 부활 차단.
2. **1차 분석**(`analysis/analyze.ts` `filterRelevant`): 1번 호출로 relevant·important·summary 동시. 한국어 강제(+중국어 시 재요약). DeepSeek 등. 사이클당 `ANALYZE_BATCH`개(기본 50)를 `ANALYZE_CONCURRENCY`개(기본 3) 동시 처리 — 백로그 밀리면 env로 올리기(예 200/5), 레이트리밋(429) 나면 그 사이클 중단 후 다음에 재개. 처리량/시 ≈ BATCH × (60/COLLECT_INTERVAL_MIN).
3. **Feed / 보관함(두 페이지로 분리)**: relevant 글을 성격으로 나눔. **Feed 탭 = 매일 갈리는 transient**: 중요 / 검토대상(lowPriority), **단 ⭐저장은 제외**. **텔레그램은 하이브리드**: 오늘 창([직전 경계, 다음 경계)) 동안엔 중요/검토에 평소처럼 섞여 나오고(원문순). 경계(07시) sweep 때 **검토(낮은 중요도) 텔레그램은 다른 검토 글처럼 휴지통으로**(다이제스트가 인용 안 하니 `?article` 안 깨짐), **중요 텔레그램만 살아남아 경계 이동으로 보관함으로** (mutation 아님 — `currentWindowStart()` 경계가 옮겨갈 뿐, 행은 살아있어 다이제스트 `?article` 링크 보존). **보관함 탭 = persistent**: ⭐저장됨(saved, 전 provider) / 텔레그램(경계 지난 살아있는 = 사실상 중요 텔레그램). 서버 `feed.list`의 `priority`(`important`/`low`/`saved`/`telegram`)로 구분 — important/low는 `saved=false AND (provider<>telegram OR createdAt>=wStart)`, 보관함 telegram은 `provider=telegram AND createdAt<wStart`. `feed.counts`도 동일 기준. 다이제스트 `fetchFeedRows`·sweep은 영향 없음(중요 OR saved를 전 provider에서 그대로; sweep은 telegram 제외 그대로). 정렬은 원문 게시시각순. 날짜 필터·소스 탭·다중선택 삭제·휴지통(soft delete) 있음. 삭제/남기기/별점은 **낙관적 업데이트**(캐시 즉시 반영, 전체 refetch 안 함 — 렉 방지). **피드백 학습**: 사용자 액션을 `filter_feedback`에 기록(`action`=trash/promote/restore) — **휴지통 이동=음성(중요↓)**, **검토→남기기·휴지통→복원=양성(중요↑)**. **영구삭제(purge)·경계 자동 sweep은 기록 안 함**(휴지통엔 자동 정리 글이 섞여 있어 신호 오염 방지). 경계 루틴에서 **새 피드백만**(커서 `lastFeedbackId`, 액션 타입별 최근 `FILTER_FEEDBACK_PER_TYPE`개=기본 15)을 기존 **'학습 메모'에 LLM으로 누적 통합**(distill 1회/일, settings `filterGuidance`) → 1차 필터의 **중요도(중요 vs 검토대상) 판단에만** `guidanceBlock`으로 주입. **관련성/제외 게이트(relevant)엔 영향 없음** — relevanceCriteria 그대로(사용자가 1차 필터는 손대지 말라고 함). **누적식**이라 과거 학습이 유지·복리되고, 상호작용 시엔 DB insert만(토큰 X).
4. **다이제스트**(`digest/digest.ts`): 기간 내 중요 글 + 저장(saved) 글 종합. 2차 지침(`digestInstructions`) 사용. `[N]` 인용을 **각주(윗첨자 번호) 링크**로 변환. **클릭=원문 바로(새 탭)** (`citeHref`: 일반=원문 URL, 텔레그램=`?article=id`; URL 없으면 `#ref-N` 폴백만 하단 목록으로). 하단 "참조 원문" 목록은 **기본 접힘**(`<details class="digest-refs-wrap">`, [N]이 이제 원문 직행이라 목차/폴백용으로만; `jumpTo`가 폴백 점프 시 부모 details 자동 open). 맵 프롬프트(`renderItem`)는 **1차 요약(dense) + 본문 발췌(`DIGEST_ITEM_CHARS` 기본 2500자) 병용**(장문 글 뒷부분 잘려도 요지 보존), **URL 줄은 제거**(인용 규칙상 링크 못 쓰니 순수 낭비였음). 각주 점프 시 **노란 지속 마커**(`.ref-active`, 다음 점프까지 유지·sessionStorage로 탭 복귀 시 복원). 인라인 링크는 LLM 지침으로 금지. 묶음/범위 인용(`[3,5]`/`[3-5]`)도 각 번호로 펼침. **텔레그램 글은 원문 URL이 없어** 참조를 `?article=<id>` 딥링크(새 탭)로 → App이 **보관함 탭**으로 시작, ArchivePage가 그 글만 본문 펼쳐 표시(텔레그램이 이제 보관함에 있음). 서버 `feed.get`. 각주 `[N]` **호버 툴팁**(`data-tip`=제목·출처, CSS `:hover::after`; 폰은 살짝 탭=호버). **클릭=점프**(노란 마커, occurrence 기억→↩ 복귀; html은 useMemo로 안정화해 재렌더가 마커 안 지움). 툴팁 **가로 위치만 JS로 클램프**(effect가 [N]마다 `--tip-shift`/`--tip-maxw` 세팅 → 오른쪽 끝에서도 안 잘림; rect.left는 세로 스크롤에 안 변해 안전, resize 시 재계산). 길게눌러 뜨던 링크 메뉴는 `touch-callout:none`으로 억제. **기간은 경계시각(기본 07시)**: date D = [(D-1)07시, D07시) KST. **자동은 하루 2회(슬롯), 라벨=생성일(읽는 날)**: **낮분**(14시 생성, `meta.slot='midday'`, sweep·학습메모 절대 안 함) = [당일 07시, 당일 14시), **라벨=생성일 그대로**(이전엔 창 끝 날짜=다음날로 라벨해 '오늘 만든 낮분이 내일 탭에' 뜨는 혼란 → 생성일로 변경, `middayLabelDate()`; 구라벨 X+1 행도 `hasMiddayFor`가 인정해 중복 생성 방지). **아침분**(07시 생성, `meta.slot='evening'` — 내부 키는 레거시 호환으로 유지, UI 표기만 '아침분'; 구슬롯 없는 옛 자동본=evening 취급) = [전날 14시, 당일 07시), 라벨=생성일(=창 끝 날짜, 기존과 동일). 두 슬롯은 분석시각(createdAt) 기준 **겹침/누락 없음**, 한 날짜 탭 = 아침분+낮분(그날 읽는 두 판). **07시 루틴**(`runDailyDigests(kstToday)`): 어제 낮분 누락 시 보충 생성(라벨=어제) → 아침분 생성 → **하루 창 전체 sweep**(단, 그날 자동본이 하나도 없으면 sweep 안 함). 크론 놓침 → **부팅 시 catch-up**(경계/낮분 **독립 체크** — 경계가 이르면 두 런이 다른 캘린더 날에 떨어짐; 슬롯별 `hasAutoDigestFor` 중복 방지). **맵리듀스**: 창의 글이 `DIGEST_MAP_ITEMS`(기본 30)건 초과면 **크기 균형 청크**(`packChunks` LPT: 건수≤30 & 글자≤`DIGEST_MAP_CHARS` 기본 45K, 장문·단문 섞임)로 부분요약(`DIGEST_MAP_TOKENS` 기본 3000, 동시 3, 1회 재시도) 후 최종 1회 종합. 각주 번호는 전역 유지. 최종 출력 `DIGEST_MAX_TOKENS` **기본 8192**(모델이 거부하면 낮추기). 수동: **'지금 (낮분) 작업 실행'**(`digest.runMidday`, 낮분만·sweep 없음)과 **'지금 (경계) 작업 실행'**(`digest.runEvening`, 낮분 보충+저녁분+하루 sweep) — **둘 다 해당 슬롯 마감 전엔 거부**(`tooEarly`; 일찍 실행하면 창이 일찍 닫혀 누른시각~경계 글이 누락). UI 라벨은 `digest.schedule`(서버 시각)로 동적 표시. **'이 기간 피드 정리'**(`digest.sweepRange`)는 다이제스트·피드백 신호 없이 sweep(과거일 정리용). **중요 텔레그램만 sweep 제외**(과거 다이제스트 `?article` 참조 보호; 검토 텔레그램은 함께 휴지통). 수동 **생성은 백그라운드 실행**(`digest.generate`가 즉시 `{started}` 반환 — 풀데이 맵리듀스는 HTTP/엣지 타임아웃 넘겨 "upstream error" 났음; 클라가 목록 폴링해 새 다이제스트 잡음). **수동 다이제스트 날짜 = 만든 날(KST 달력일, 자정 롤오버)**: 폼 기본 날짜 = `schedule.today`(=`kstToday`, 옛 `currentWindowDate` 아님 — 밤 10시 7/7 생성 → 창 도우미 07시 경계로 7/8에 파일링되던 혼란을 자정 기준으로 교정. 밤 10시 7/7→**7/7**, 새벽 1시 7/8→**7/8**). 서버 `generateDigest`도 기본을 `kstToday()`로. 날짜 안 만진 채 생성 시 클라가 `start` 생략→서버가 만든 날로 배정. **스테일 클라/배포지연 방어**: 수동·단일일 요청의 `start`가 `currentWindowDate()`(아직 안 닫힌 미래 창=옛 기본값)와 같으면 서버가 `kstToday()`로 재배정(닫히지 않은 창을 일부러 백필할 일 없음; 07시 이전엔 두 값이 같아 무동작; 과거 백필·범위·자동 크론은 불변). 선택 날짜의 실제 시간창 미리보기 표시. **과거 날짜**는 피드가 비었거나 `fromDigests`면 그 기간 **저장 다이제스트들을 종합**(`meta.source='digests'`, 번호 인용 없음). Digest 탭 자동 optgroup에 낮분/경계 시각 라벨·배지(`digest.schedule` 동적). **피드 정렬은 원문 게시시각**(`COALESCE(publishedAt, createdAt) desc`) — 날짜 필터·다이제스트 창은 여전히 createdAt 기준.

## 지침(Settings, DB의 settings.analysis)
- `relevanceCriteria`(1차 필터), `importanceCriteria`(중요/낮음 분리), `summaryInstructions`(요약), `digestInstructions`(2차 다이제스트), `instructions`(DEEP_ANALYSIS용), `filterModel`/`analysisModel`.
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
- **남은 것(다음 세션)**: ① 다이제스트 = changelog(움직인 논지만 + 스레드 밖 신호 한 줄 + 변동 없으면 "오늘 논지 변동 없음"), ② Feed 카드 스레드 배지(`A 강화`) — feed.list에 신호 조인 필요, ③ A~E 명제 실제 내용으로 사용자 편집.

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
  - **그래프(최근 1년)**: 6개 지표 모두 일별 히스토리 차트. 수집기가 현재값 + ~1년 히스토리를 함께 받아 `snapshot.history`에 저장(`SeriesPoint{t,v}[]`, 약 250점/시리즈, 전체 ~37KB). 소스: F&G=`fear_and_greed_historical.data`(252점), S5FI/NDFI=TradingView **차트 히스토리 ws**(`from=chart`, `resolve_symbol`+`create_series` 1D 400봉; ⚠️**익명 세션은 series 1개 제한** "exceed limit of series" → **심볼당 연결 1개**씩 병렬), ADR=`/chart_indx`의 `dataSet={KOSPI:{adr:[[ts,v]…]},KOSDAQ:…}`(2019~; ⚠️**배열 끝 trailing comma + 미래날짜 `null`** 있어 `,\s*]`→`]` 치환 후 JSON.parse·숫자필터). 슬라이스=`sliceLastYear`(**기본 `HISTORY_DAYS`=1825일≈5년**, 소스가 그만큼 있으면; TradingView `BARS`=1300, 신용 조회 1850일로 확장). **모든 라인 지표 차트 = `InteractiveLineChart.tsx`**(커스텀 캔들처럼 휠 줌·드래그 팬·오른쪽 가격축·풀 크로스헤어[세로+가로선, 커서 위치 가격/값 표시]) + **일/주/월/년 토글**(`LineChartBlock`, 클라 리샘플=버킷당 마지막값, `mkt.tf.<id>` 저장, key=tf로 remount). 옛 `MarketChart.tsx`(`MultiLineChart`)는 미사용. **다년 히스토리는 재수집 후 채워짐**(기존 스냅샷은 1년치라 배포 후 '지금 갱신' 또는 일일배치 필요). 부팅 시 **히스토리 없으면 즉시 재수집**.
  - **egress**: Railway(프로덕션)는 아웃바운드 기본 개방이라 동작. 세 소스 모두 실서버 모듈 end-to-end 확인됨(errors 0, 히스토리 252/254/254/248/248점). 데모 모드(`VITE_STATIC_DEMO`)는 `SAMPLE_MARKET`(사인파 더미 히스토리). ⚠️샌드박스는 playwright 브라우저 다운로드 차단(egress)이라 스크린샷 검증 불가 — 빌드/타입체크로 확인.
  - **미국 순유동성 카드**(`liquidity.ts`, 맨 아래 전폭): 순유동성 = 연준자산(WALCL) − 역레포(RRPONTSYD) − TGA(WTREGEN), 지급준비금(WRESBAL) 오버레이 2선. 소스=**FRED `fredgraph.csv?id=WALCL,RRPONTSYD,WTREGEN,WRESBAL`**(API키 불필요, 다중 시리즈 CSV). ⚠️**단위 주의**: WALCL/WTREGEN/WRESBAL=백만$, RRPONTSYD=**십억$** → 전부 $조로 정규화(`TO_TRILLIONS`). WALCL/TGA/WRESBAL은 **주간**(수 기준·목 공표), RRP만 일별 → 순유동성은 WALCL 주간 날짜에서 계산(RRP는 그 날짜 이하 최근값 carry-forward). 현재값+4주변화(임펄스)+지급준비금/RRP/TGA 레벨 표시. **기준선 없음·RefControls 없음**(임계 없는 지표), "주간·후행·매매신호 아님" 배지 + 경고문(2023 AI랠리 때 지수와 반대로 감). ⚠️**소스 라우팅(2번 삽질 끝 확정)**: ① FRED `fredgraph.csv`는 주기 다른 다중 id 요청 시 **ZIP 반환**(단일 id=순수 CSV). ② 더 치명적: **fred.stlouisfed.org가 Railway 데이터센터 IP를 무응답 드롭**(4시리즈 전부 "타임아웃 N초 무응답" — egress 허용해도 소용없음). **해결: 주 경로 = TradingView 차트 ws의 `FRED:<ID>` 미러 심볼**(S5FI/NDFI와 같은 파이프, Railway 검증됨; `tradingview.ts fetchCloses` 재사용, 2개씩 순차 병렬로 TV 동시연결 억제) + FRED 직접 CSV는 폴백. `FRED:WALCL`/`FRED:RRPONTSYD`/`FRED:WTREGEN`은 TV에서 순유동성 계산용으로 널리 쓰여 존재 확인됨. TGA/RRP는 WALCL 날짜에 carry-forward 매칭(TV 바 날짜 어긋남 대비). ✅계산 로직은 실데이터(curl 1년치)로 검증: 순유동성 $5.84T, 지급준비금 $2.97T(3조 아래=레포 스트레스 근접 실신호), RRP≈0, TGA $0.88T. TV 경로 실동작은 Railway 배포 후 '지금 갱신'으로 확인.
  - ▶ **남은 개선(선택)**: 장중 ADR 더 자주(추가 크론), 기간 토글(1M/3M/1Y), F&G 색구간 배경, 다이제스트에 시황 한 줄 등.
  - **코스피/코스닥 신용잔고 카드 ✅ 구현 완료**: `src/server/market/credit.ts` = KOFIA FreeSIS `getMetaDataList.do`(service STATSCU0100000070, OBJ_NM=`STATSCU0100000070BO`, 일별, TMPV3=유가증권 TMPV4=코스닥, 원→조원). `shared/market.ts` `credit:{kospi,kosdaq}`+`history.creditKospi/kosdaq`, `MarketPage`에 카드 2개(기준선 없음). Railway 실서버 동작.
- **리포트**(tab 9, `src/client/pages/ResearchPage.tsx`): 증권사 리포트 애그리게이터 **✅ 구현 완료(파서는 Railway 실검증 대기)**. 오늘 올라온 **기업·산업 리포트만** 모아 카테고리별 정렬, 헤드라인+주요내용(LLM 한 줄 요약)+시총(현재가 아님)+TP·의견 표기. **5영업일 커버리지 카운트** → 5회↑=**주요종목**, 직전 대비 TP 상향=**TP상향종목** 티어업. **소스 2곳(네이버·한경 컨센서스) 병합 수집**, 각 리포트에 출처 배지(네이버 sky/한경 emerald) 표시.
  - **서버 `src/server/research/`**: `naver.ts`(주 소스·양 많음, 기업 company_list+산업 industry_list, EUC-KR 디코드, 목록 파싱+상세 TP/의견/본문, `#_market_sum`으로 시총, externalId `nv:<nid>`) + `hankyung.ts`(consensus.hankyung.com/analysis/list, 목록 컬럼서 TP/의견, 기업·산업만, externalId `hk:<report_idx>`) + `index.ts`(`collectResearch` 둘 다 fetch→ALLOWED 필터→한경 종목코드를 네이버 이름→코드 맵으로 보강→네이버 기업 리포트 TP/의견/요약 enrich→시총 수집[최근 코드 MAX 250, mapLimit 4]→조건부 upsert; `listResearch(date?)`는 커버리지=distinct `broker|reportDate`[교차소스 dedup], TP상향=동일 브로커 직전 TP 비교, 티어 정렬). `types.ts` `ALLOWED_CATEGORIES=Set(기업,산업)`.
  - **DB**: 마이그레이션 0008=`research_reports`, 0009=summary(text)/marketCap(bigint) 추가(논지지도는 0010). tRPC `research` 라우터(`list`/`refresh`). 스케줄러 일일 크론(`RESEARCH_HOUR` 기본 8시 KST) + 부팅 시 12h↑ 오래되면 즉시 수집. Sources 탭 아닌 리포트 탭 자체에 날짜 피커 + '지금 수집' 버튼. 정적 데모는 `SAMPLE_*` 스텁.
  - ⚠️ **파서는 샌드박스 egress 차단(네이버/한경 호스트 blocked)이라 실검증 못 함** — Railway(아웃바운드 개방)에서만 동작. 배포 후 결과가 비거나 어긋나면 사용자가 실제 HTML 붙여주면 파서 튜닝. **양쪽 소스 같은 리포트는 지금 병합 안 함**(카드 2장) — 원하면 병합 가능.

## 방향·다음 작업 (대화 요약 — 인계)
**문제의식**: 현재 구조(피드에 글 쌓고 훑고 지움)가 "신경 끄기" 목표를 재현. 사용자는 **하루 2~3회 다이제스트만** 보고 끝내고 싶어함. 놓침 불안은 필터로 거르지 말고 **다이제스트 "누락금지 규칙"**으로 해결.

**결정**: 별도 사이트 X → **이 앱 안에 새 탭** 추가(Railway 추가비용 ~$0; 사용량 기반·$5 크레딧 포함). 다음 큰 작업 = **논지 지도(Thesis Map) 탭**.

**다이제스트 효율 지침(병행, Settings 적용 권장)**:
- 1차 필터: 넓게(투자·경제·산업·기술과 조금이라도 관련=관련, 광고/스팸만 제외).
- 중요도: 순수 쓰레기(광고·인사·무의미 잡담)만 '낮음', 나머지 '높음'.
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
