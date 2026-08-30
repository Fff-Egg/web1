# 실서버 배포 가이드 (Railway)

브라우저 클릭만으로 배포합니다. 터미널 필요 없음. (Railway는 Node 앱 + MySQL을
한 프로젝트에서 제공해서 이 앱에 가장 잘 맞습니다.)

> 비용: Railway는 무료가 아니며 사용량 기반 과금(소액, 보통 월 몇 달러)입니다.
> 분석에는 선택한 LLM 공급자의 API 사용료가 별도로 듭니다.

## 0. 미리 준비할 것
- **GitHub 계정** (이미 있음, `Fff-Egg`)
- **LLM API 키**: Anthropic 키 또는 DeepSeek·OpenRouter 등 OpenAI 호환 API의
  Base URL/API 키/모델 이름을 준비합니다. 수동 분석만 쓰면 생략할 수 있습니다.

## 1. Railway 가입 & 프로젝트 생성
1. https://railway.app → **Login with GitHub**
2. **New Project** → **Deploy from GitHub repo** → `Fff-Egg/web1` 선택
3. 배포할 브랜치를 **`claude/focused-planck-m3wgbz`** 로 지정
   (Service → Settings → Source → Branch)

## 2. MySQL 추가
1. 같은 프로젝트 안에서 **New → Database → Add MySQL**
2. 잠시 후 MySQL 서비스가 생성됩니다 (연결 정보 자동 제공).

## 3. 환경변수 설정 (앱 서비스 → Variables)
다음을 추가합니다:

| 변수 | 값 |
|---|---|
| `DATABASE_URL` | `${{ MySQL.MYSQL_URL }}` (Railway 변수 참조 — MySQL 서비스 이름이 다르면 맞게) |
| `APP_USERNAME` | 원하는 로그인 아이디 (생략 시 `admin`) |
| `APP_PASSWORD` | **필수 권장:** 길고 고유한 사이트 접속 암호 |
| `ANTHROPIC_API_KEY` | Claude 사용 시 `sk-ant-...` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | DeepSeek 등 OpenAI 호환 API 사용 시 세 변수를 함께 설정 |
| `FILTER_MODEL` | 글 선별·다이제스트 자료 정리 모델 (예: `deepseek-v4-flash`) |
| `ANALYSIS_MODEL` | 최종 연결·심층 모델 (예: `deepseek-v4-pro`) |
| `DIGEST_FINAL_RETRY_TOKENS` | Pro가 사고 토큰을 소진했을 때 같은 Pro 재시도 예산 (예: `16384`) |
| `DIGEST_HOUR` | `7` (선택, 하루 경계 다이제스트·피드 정리 시각 KST) |
| `DIGEST_MIDDAY_HOUR` | `17` (선택, 두 번째 다이제스트 시각 KST) |
| `COLLECT_INTERVAL_MIN` | `15` (선택, 수집 주기 분) |
| `ANALYSIS_AVOID_PEAK` | `1` (선택, KST 10~13시·15~19시 자동 LLM 분석 대기) |
| `ANALYSIS_DRAIN_MAX_ROUNDS` | `20` (선택, 13시·19시 적체 처리 최대 배치 수) |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `1` (선택, 빌드 빨라짐 — 서버는 브라우저 불필요) |

> 웹 **설정 → 고급**에 모델을 직접 쓰면 Railway의 `FILTER_MODEL` / `ANALYSIS_MODEL`보다 우선합니다.
> OpenAI 호환 API에서 `FILTER_MODEL=claude-*` 같은 옛 값을 두면 실제로는 `LLM_MODEL`로 치환되므로,
> 혼동을 피하려면 실제 모델 id(예: `deepseek-v4-flash`)로 바꾸세요.
> `APP_PASSWORD`를 설정하지 않으면 서버 로그에 공개 접근 경고가 출력됩니다.

## 4. 배포
- 환경변수를 저장하면 Railway가 자동으로 **빌드 → 마이그레이션 → 서버 시작**을 합니다.
  - 빌드: `npm run build` (웹 + 서버)
  - 시작: `npm start` → DB 테이블 자동 생성 후 서버 가동
- **Settings → Networking → Generate Domain** 을 누르면 공개 URL이 생깁니다.
  (예: `https://web1-production.up.railway.app`)
- 그 주소로 들어가면 **진짜 동작하는 대시보드**입니다.

## 5. 사용 시작
1. 공개 URL 접속 → **Sources** 탭에서 보고 싶은 소스 추가
   (공개: 네이버블로그/한국경제/Substack RSS/일반 RSS — 바로 수집·분석됨)
2. **Settings** 탭에서 **분석 지침** 작성·저장
3. 수집·분석은 자동(주기적), **Daily Digest**는 매일 저녁 자동 생성
4. **Feed** 탭에서 분석 결과 + "원문 보기 ↗" 확인

## 인증 소스(Substack 유료 / 네이버프리미엄 / Fanding / X)는?
서버에는 브라우저가 없어 **서버에서 직접 로그인은 안 됩니다.** 두 가지 방법:
- (간단) 공개 소스 + 분석 + 다이제스트만 서버에서 24시간 운영하고, 인증 소스는 생략
- (고급) 내 PC에서 한 번 로그인해 세션 파일(`sessions/source-<id>.json`)을 만든 뒤
  서버에 올리는 방식 — 필요해지면 그때 안내

## 문제가 생기면
- **Deploy 로그가 빨갛게 crash**: 보통 `DATABASE_URL` 또는 LLM 변수 조합 오류.
  Variables 확인 후 재배포(Deploy).
- **분석이 안 됨**: 선택한 LLM API 키·모델·크레딧을 확인.
- **수집이 비어 있음**: 일부 사이트가 봇 차단(403)할 수 있음. 다른 RSS로 테스트.
