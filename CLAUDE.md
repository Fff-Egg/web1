# Feed Watch — 인수인계 (HANDOFF)

개인 투자 정보 수집·분석·다이제스트 대시보드. 여러 소스에서 글을 모아 1차로
필터·요약하고, 하루 1회(또는 기간 지정) **다이제스트**로 종합한다.

## ⚠️ 새 세션 시작 시 먼저 할 것
- 컨테이너가 가끔 **옛 커밋으로 리셋**된다. 작업 전 반드시:
  `git fetch origin claude/focused-planck-m3wgbz && git reset --hard origin/claude/focused-planck-m3wgbz`
- 개발 브랜치: **`claude/focused-planck-m3wgbz`** (여기에만 커밋·푸시). 푸시하면 Railway가 자동 재배포.
- 푸시는 GitHub MCP가 아니라 일반 `git push -u origin <branch>` 사용.

## 실행 환경 (Railway)
- 앱(web1) + MySQL. `start` = `db:migrate && tsx src/server/index.ts`.
- 주요 환경변수:
  - `DATABASE_URL` (MySQL public URL)
  - 분석 LLM = **DeepSeek**: `LLM_BASE_URL=https://api.deepseek.com/v1`, `LLM_API_KEY`, `LLM_MODEL=deepseek-v4-flash` (OpenAI 호환)
  - `TELEGRAM_API_ID/HASH/SESSION` (텔레그램 MTProto, 공개·비공개 채널 배치 수집)
  - `X_RSS_BRIDGE` (X용, 선택) / 소스별 `config.rssUrl`
  - `DIGEST_HOUR`(기본 21, KST), `COLLECT_INTERVAL_MIN`(기본 30, 현재 10), `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
  - 선택: `DEEP_ANALYSIS=1`(글별 개별 심층분석 on), `FILTER_BODY_CHARS`, `DIGEST_MAX_TOKENS`, `ANALYZE_ALL`, `FILTER_FEEDBACK_PER_TYPE`(하루 distill에 넣을 액션 타입별 새 피드백 수, 기본 15)

## 파이프라인
1. **수집**(`workers/collect.ts`): 소스별 어댑터 fetch → articles 저장. 같은 (source,url) 글이 있으면 재생성 안 함(삭제 부활 방지). **영구삭제(purge)도 행 자체는 안 지우고 묘비(tombstone: analysis·body 제거, url만 유지)로 남겨** 재수집 시 부활 차단.
2. **1차 분석**(`analysis/analyze.ts` `filterRelevant`): 1번 호출로 relevant·important·summary 동시. 한국어 강제(+중국어 시 재요약). DeepSeek 등.
3. **Feed**: relevant 글. 버킷 = 중요 / 검토대상(lowPriority) / ⭐저장됨(saved). created_at(피드 진입 시각)순. 날짜 필터·소스 탭·다중선택 삭제·휴지통(soft delete) 있음. **피드백 학습**: 사용자 액션을 `filter_feedback`에 기록(`action`=trash/promote/restore) — **휴지통 이동=음성(중요↓)**, **검토→남기기·휴지통→복원=양성(중요↑)**. **영구삭제(purge)·21시 자동 sweep은 기록 안 함**(휴지통엔 자동 정리 글이 섞여 있어 신호 오염 방지). 21시에 **새 피드백만**(커서 `lastFeedbackId`, 액션 타입별 최근 `FILTER_FEEDBACK_PER_TYPE`개=기본 15)을 기존 **'학습 메모'에 LLM으로 누적 통합**(distill 1회/일, settings `filterGuidance`) → 1차 필터의 **중요도(중요 vs 검토대상) 판단에만** `guidanceBlock`으로 주입. **관련성/제외 게이트(relevant)엔 영향 없음** — relevanceCriteria 그대로(사용자가 1차 필터는 손대지 말라고 함). **누적식**이라 과거 학습이 유지·복리되고, 상호작용 시엔 DB insert만(토큰 X).
4. **다이제스트**(`digest/digest.ts`): 기간 내 중요 글 + 저장(saved) 글 종합. 2차 지침(`digestInstructions`) 사용. `[N]` 인용을 **각주(윗첨자 번호) 링크**로 변환 → 하단 번호 매긴 "참조 원문" 목록으로 점프(거기서 원문 링크 연결, `↩`로 본문 복귀). 인라인 링크는 LLM 지침으로 금지. 묶음/범위 인용(`[3,5]`/`[3-5]`)도 각 번호로 펼침. **텔레그램 글은 원문 URL이 없어** 참조를 `?article=<id>` 딥링크(새 탭)로 → App이 Feed 탭으로 시작, FeedPage가 그 글만(전체 목록 X, 가벼움) 본문 펼쳐 표시; "전체 피드 보기"로 해제. 서버 `feed.get`. 각주 `[N]`엔 hover 툴팁(`data-tip`=제목·출처). **기간은 21시 경계**: date D = [(D-1)21시, D21시) KST(예: 11일=10일21시~11일21시). 21시 크론이 **자동 다이제스트**(`meta.auto`, analysisModel) 생성 후 그 구간 **비저장 피드를 휴지통으로**(soft delete). 크론은 in-process라 21시에 서버가 꺼져/재시작 중이면 놓침 → **부팅 시 catch-up**(오늘 21시 지났는데 오늘자 자동본 없으면 1회 실행, `hasAutoDigestFor`로 중복 방지). 수동: Digest 탭 **'지금 21시 작업 실행'**(`digest.runEvening`)으로 즉시 실행(생성·정리 건수 반환). 단 **텔레그램은 sweep 제외**(원문이 피드에만 있어 살려둬야 과거 다이제스트의 `?article` 참조가 안 깨짐). **과거 날짜**는 피드가 비었거나 `fromDigests`면 그 기간에 걸치는 **저장 다이제스트들을 종합**(`meta.source='digests'`, 번호 인용 없음). Digest 탭은 자동/수동 optgroup 분리 + 배지.

## 지침(Settings, DB의 settings.analysis)
- `relevanceCriteria`(1차 필터), `importanceCriteria`(중요/낮음 분리), `summaryInstructions`(요약), `digestInstructions`(2차 다이제스트), `instructions`(DEEP_ANALYSIS용), `filterModel`/`analysisModel`.
- 기본값: `src/shared/analysis.ts`.

## 소스 어댑터 (`src/server/adapters/`)
generic_rss, naver_blog, hankyung, substack, x(브리지 RSS·로그인X), telegram(MTProto 세션·배치·비공개는 숫자ID -100…), naver_premium·fanding(로그인 필요·클라우드 미지원).

## 마이그레이션 (중요)
- `drizzle-kit generate`는 **대화형이라 이 환경에서 막힘**. 마이그레이션은 **수동 작성**:
  `drizzle/00XX_name.sql` + `drizzle/meta/_journal.json`에 엔트리 추가(idx/tag/when). 컬럼 추가는 nullable 또는 default로(기존행 보호).
- 현재 0000~0007 (0006: markdown/body/full_text → mediumtext, 0007: `filter_feedback` 테이블).

## 검증·배포
- `npm run typecheck` / `npm run build` 통과 후 커밋·푸시. 빌드는 client(vite)+server(tsc). gramjs(telegram)는 server 전용.

## 남은 아이디어 (사용자와 논의 중)
- 다이제스트 **하루 2~3회** 자동(지난 회차 이후 분량) + **텔레그램으로 전송**(대시보드 안 열게).
- 다이제스트 지침을 "핵심 3~5 + 원문 정독 추천 + 나머지 한 줄(누락금지)" 편집장 스타일로.
- 더 큰 틀: **논지 지도(스레드) 모델** — 글 요약 대신 논지 강화/약화 changelog.
