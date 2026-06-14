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
  - 선택: `DEEP_ANALYSIS=1`(글별 개별 심층분석 on), `FILTER_BODY_CHARS`, `DIGEST_MAX_TOKENS`(기본 8192), `DIGEST_MAP_ITEMS/CHARS/TOKENS`(맵리듀스 청크, 기본 30/45000/3000), `ANALYZE_ALL`, `FILTER_FEEDBACK_PER_TYPE`(하루 distill에 넣을 액션 타입별 새 피드백 수, 기본 15)

## 파이프라인
1. **수집**(`workers/collect.ts`): 소스별 어댑터 fetch → articles 저장. 같은 (source,url) 글이 있으면 재생성 안 함(삭제 부활 방지). **영구삭제(purge)도 행 자체는 안 지우고 묘비(tombstone: analysis·body 제거, url만 유지)로 남겨** 재수집 시 부활 차단.
2. **1차 분석**(`analysis/analyze.ts` `filterRelevant`): 1번 호출로 relevant·important·summary 동시. 한국어 강제(+중국어 시 재요약). DeepSeek 등. 사이클당 `ANALYZE_BATCH`개(기본 50)를 `ANALYZE_CONCURRENCY`개(기본 3) 동시 처리 — 백로그 밀리면 env로 올리기(예 200/5), 레이트리밋(429) 나면 그 사이클 중단 후 다음에 재개. 처리량/시 ≈ BATCH × (60/COLLECT_INTERVAL_MIN).
3. **Feed / 보관함(두 페이지로 분리)**: relevant 글을 성격으로 나눔. **Feed 탭 = 매일 갈리는 transient**: 중요 / 검토대상(lowPriority), **단 ⭐저장은 제외**. **텔레그램은 하이브리드**: 오늘 창([직전 경계, 다음 경계)) 동안엔 중요/검토에 평소처럼 섞여 나오고(원문순). 경계(07시) sweep 때 **검토(낮은 중요도) 텔레그램은 다른 검토 글처럼 휴지통으로**(다이제스트가 인용 안 하니 `?article` 안 깨짐), **중요 텔레그램만 살아남아 경계 이동으로 보관함으로** (mutation 아님 — `currentWindowStart()` 경계가 옮겨갈 뿐, 행은 살아있어 다이제스트 `?article` 링크 보존). **보관함 탭 = persistent**: ⭐저장됨(saved, 전 provider) / 텔레그램(경계 지난 살아있는 = 사실상 중요 텔레그램). 서버 `feed.list`의 `priority`(`important`/`low`/`saved`/`telegram`)로 구분 — important/low는 `saved=false AND (provider<>telegram OR createdAt>=wStart)`, 보관함 telegram은 `provider=telegram AND createdAt<wStart`. `feed.counts`도 동일 기준. 다이제스트 `fetchFeedRows`·sweep은 영향 없음(중요 OR saved를 전 provider에서 그대로; sweep은 telegram 제외 그대로). 정렬은 원문 게시시각순. 날짜 필터·소스 탭·다중선택 삭제·휴지통(soft delete) 있음. 삭제/남기기/별점은 **낙관적 업데이트**(캐시 즉시 반영, 전체 refetch 안 함 — 렉 방지). **피드백 학습**: 사용자 액션을 `filter_feedback`에 기록(`action`=trash/promote/restore) — **휴지통 이동=음성(중요↓)**, **검토→남기기·휴지통→복원=양성(중요↑)**. **영구삭제(purge)·경계 자동 sweep은 기록 안 함**(휴지통엔 자동 정리 글이 섞여 있어 신호 오염 방지). 경계 루틴에서 **새 피드백만**(커서 `lastFeedbackId`, 액션 타입별 최근 `FILTER_FEEDBACK_PER_TYPE`개=기본 15)을 기존 **'학습 메모'에 LLM으로 누적 통합**(distill 1회/일, settings `filterGuidance`) → 1차 필터의 **중요도(중요 vs 검토대상) 판단에만** `guidanceBlock`으로 주입. **관련성/제외 게이트(relevant)엔 영향 없음** — relevanceCriteria 그대로(사용자가 1차 필터는 손대지 말라고 함). **누적식**이라 과거 학습이 유지·복리되고, 상호작용 시엔 DB insert만(토큰 X).
4. **다이제스트**(`digest/digest.ts`): 기간 내 중요 글 + 저장(saved) 글 종합. 2차 지침(`digestInstructions`) 사용. `[N]` 인용을 **각주(윗첨자 번호) 링크**로 변환 → 하단 번호 매긴 "참조 원문" 목록으로 점프(거기서 원문 링크 연결, `↩`로 본문 복귀). 각주 점프 시 **노란 지속 마커**(`.ref-active`, 다음 점프까지 유지·sessionStorage로 탭 복귀 시 복원). 인라인 링크는 LLM 지침으로 금지. 묶음/범위 인용(`[3,5]`/`[3-5]`)도 각 번호로 펼침. **텔레그램 글은 원문 URL이 없어** 참조를 `?article=<id>` 딥링크(새 탭)로 → App이 **보관함 탭**으로 시작, ArchivePage가 그 글만 본문 펼쳐 표시(텔레그램이 이제 보관함에 있음). 서버 `feed.get`. 각주 `[N]`엔 hover 툴팁(`data-tip`=제목·출처). **기간은 경계시각(기본 07시)**: date D = [(D-1)07시, D07시) KST. **자동은 하루 2회(슬롯)**: **17시 낮분** = 슬롯 [(D-1)07, (D-1)17)(`meta.slot='midday'`, **sweep·학습메모 절대 안 함**; 17시 크론이 `currentWindowDate()`=다음날 D로 라벨), **07시 저녁분** = [(D-1)17, D07)(`meta.slot='evening'`; 구슬롯 없는 옛 자동본=evening 취급). 두 슬롯은 분석시각(createdAt) 기준이라 **겹침/누락 없음**(낮분/저녁분은 서로 다른 캘린더 날에 생성되지만 같은 date D 라벨). **07시 루틴**(`runDailyDigests(kstToday)`): 낮분 누락 시 보충 생성 → 저녁분 생성 → **하루 창 전체 sweep**(단, 그날 자동본이 하나도 없으면 sweep 안 함). 크론 놓침 → **부팅 시 catch-up**(경계/낮분 **독립 체크** — 경계가 이르면 두 런이 다른 캘린더 날에 떨어짐; 슬롯별 `hasAutoDigestFor` 중복 방지). **맵리듀스**: 창의 글이 `DIGEST_MAP_ITEMS`(기본 30)건 초과면 **크기 균형 청크**(`packChunks` LPT: 건수≤30 & 글자≤`DIGEST_MAP_CHARS` 기본 45K, 장문·단문 섞임)로 부분요약(`DIGEST_MAP_TOKENS` 기본 3000, 동시 3, 1회 재시도) 후 최종 1회 종합. 각주 번호는 전역 유지. 최종 출력 `DIGEST_MAX_TOKENS` **기본 8192**(모델이 거부하면 낮추기). 수동: **'지금 (낮분) 작업 실행'**(`digest.runMidday`, 낮분만·sweep 없음)과 **'지금 (경계) 작업 실행'**(`digest.runEvening`, 낮분 보충+저녁분+하루 sweep) — **둘 다 해당 슬롯 마감 전엔 거부**(`tooEarly`; 일찍 실행하면 창이 일찍 닫혀 누른시각~경계 글이 누락). UI 라벨은 `digest.schedule`(서버 시각)로 동적 표시. **'이 기간 피드 정리'**(`digest.sweepRange`)는 다이제스트·피드백 신호 없이 sweep(과거일 정리용). **중요 텔레그램만 sweep 제외**(과거 다이제스트 `?article` 참조 보호; 검토 텔레그램은 함께 휴지통). **과거 날짜**는 피드가 비었거나 `fromDigests`면 그 기간 **저장 다이제스트들을 종합**(`meta.source='digests'`, 번호 인용 없음). Digest 탭 자동 optgroup에 낮분/경계 시각 라벨·배지(`digest.schedule` 동적). **피드 정렬은 원문 게시시각**(`COALESCE(publishedAt, createdAt) desc`) — 날짜 필터·다이제스트 창은 여전히 createdAt 기준.

## 지침(Settings, DB의 settings.analysis)
- `relevanceCriteria`(1차 필터), `importanceCriteria`(중요/낮음 분리), `summaryInstructions`(요약), `digestInstructions`(2차 다이제스트), `instructions`(DEEP_ANALYSIS용), `filterModel`/`analysisModel`.
- 기본값: `src/shared/analysis.ts`.
- **학습 메모**(`settings.filterGuidance`, 별도 키): 피드백으로 자동 학습되는 중요도 메모. `importanceCriteria`와 **별개**(참고용 주입). Settings 탭 "학습 메모 (자동)"에서 보기·편집·비우기(`settings.getFilterGuidance`/`setFilterGuidance`).

## 소스 어댑터 (`src/server/adapters/`)
generic_rss(피드 URL 또는 **홈페이지 URL도 허용** — 백그라운드는 `<link rel="alternate">` 자동탐지만으로 피드 복구·캐시. **'지금 수집' 실패 시엔** `probeFeedUrl`로 흔한 경로(`/feed/`·`/rss`·`/atom.xml`…)까지 탐색해 **제안만**(`suggestedFeedUrl`) 반환 → UI에서 '이 주소로 저장하고 수집' 확인 시 source identifier로 저장(추측 자동적용 안 함·백그라운드 반복탐색 안 함). 못 찾으면 "HTML일 수 있다" 한국어 에러), naver_blog, hankyung, substack, x(쿠키 직접 수집 우선 `src/server/x/client.ts`+twitter-scraper, 폴백=브리지 RSS), telegram(MTProto 세션·배치·비공개는 숫자ID -100…), naver_premium·fanding(로그인 필요·클라우드 미지원). Sources 탭 소스별 **'지금 수집'**(`sources.collectNow`)으로 즉시 fetch 테스트(결과/에러 인라인).

## 마이그레이션 (중요)
- `drizzle-kit generate`는 **대화형이라 이 환경에서 막힘**. 마이그레이션은 **수동 작성**:
  `drizzle/00XX_name.sql` + `drizzle/meta/_journal.json`에 엔트리 추가(idx/tag/when). 컬럼 추가는 nullable 또는 default로(기존행 보호).
- 현재 0000~0007 (0006: markdown/body/full_text → mediumtext, 0007: `filter_feedback` 테이블).

## 검증·배포
- `npm run typecheck` / `npm run build` 통과 후 커밋·푸시. 빌드는 client(vite)+server(tsc). gramjs(telegram)는 server 전용.

## 남은 아이디어 (사용자와 논의 중)
- ~~다이제스트 하루 2~3회~~ → **17시·07시 2회 적용됨**(시각은 env로 조절). 남은 것: **텔레그램으로 전송**(대시보드 안 열게).
- 다이제스트 지침을 "핵심 3~5 + 원문 정독 추천 + 나머지 한 줄(누락금지)" 편집장 스타일로.
- 더 큰 틀: **논지 지도(스레드) 모델** — 글 요약 대신 논지 강화/약화 changelog.
