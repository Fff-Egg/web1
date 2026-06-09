# 실서버 배포 가이드 (Railway)

브라우저 클릭만으로 배포합니다. 터미널 필요 없음. (Railway는 Node 앱 + MySQL을
한 프로젝트에서 제공해서 이 앱에 가장 잘 맞습니다.)

> 비용: Railway는 무료가 아니며 사용량 기반 과금(소액, 보통 월 몇 달러)입니다.
> 분석에는 Anthropic API 사용료가 별도로 듭니다.

## 0. 미리 준비할 것
- **GitHub 계정** (이미 있음, `Fff-Egg`)
- **Anthropic API 키**: https://console.anthropic.com → API Keys → 키 생성
  (크레딧 충전 필요). 키는 `sk-ant-...` 형태.

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
| `ANTHROPIC_API_KEY` | `sk-ant-...` (1단계에서 만든 키) |
| `DIGEST_HOUR` | `21` (선택, 저녁 9시 KST 다이제스트) |
| `COLLECT_INTERVAL_MIN` | `30` (선택, 수집 주기 분) |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `1` (선택, 빌드 빨라짐 — 서버는 브라우저 불필요) |

> `FILTER_MODEL` / `ANALYSIS_MODEL` 은 기본값이 있어 생략 가능
> (Haiku로 1차 필터, Opus로 심층 분석).

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
- **Deploy 로그가 빨갛게 crash**: 보통 `DATABASE_URL` 또는 `ANTHROPIC_API_KEY` 미설정.
  Variables 확인 후 재배포(Deploy).
- **분석이 안 됨**: `ANTHROPIC_API_KEY` 크레딧 잔액 확인.
- **수집이 비어 있음**: 일부 사이트가 봇 차단(403)할 수 있음. 다른 RSS로 테스트.
