# 다이제스트 LLM 연결 진단 (2026-09-08)

## 목적과 변경 범위
반복된 `terminated; cause=ECONNRESET: read ECONNRESET`을 다음 발생 시 조사할 수 있도록 **계측만** 추가했다. 이 오류만으로 입력 글 수, 토큰 부족, Thinking 결함, DeepSeek 장애 중 하나를 확정할 수 없다.

- Pro 1회 → 실패하면 Flash, Thinking 설정, 토큰 예산, 스케줄은 변경하지 않았다.
- 스트리밍을 켜거나 타임아웃·재시도를 추가하지 않았다. 계측 때문에 추가 LLM 호출이 발생하지 않는다.
- HTTP 응답을 기존처럼 전체 수신 후 JSON으로 처리하되, 수신 도중 바이트·청크·시각을 센다. 전송 청크는 SSE 이벤트나 생성 토큰이 아니다.
- DB 마이그레이션 없음: 실패 계측은 기존 `digests.meta.models.stages.*.errors[].diagnostics`에 저장한다.

## 다음 실패 때 확인 방법
1. 해당 다이제스트 → **실패 원인 N건 보기** → **진단 정보 복사**를 누른다.
2. 복사한 JSON과 발생 시각을 전달한다. 복사가 차단되면 상세 JSON을 직접 복사한다.
3. Railway 로그에서 JSON의 `runId` (`dg-...`)를 검색한다. `llm_start`, `llm_success`, `llm_failure`로 모델·단계·시도 번호를 비교한다. 성공 호출도 수치만 로그에 남겨 비교할 수 있다.
4. 시작 로그만 있고 종료 로그가 없다면 같은 시각의 재시작·배포·컨테이너 종료 로그도 확인한다. 폴백까지 실패해 보고서가 저장되지 않아도 Railway 실패 로그는 남는다.

## 해석
- `awaiting_headers`: HTTP 헤더를 받기 전 실패. DNS/TLS/연결/제공자 지연 등은 코드와 운영 로그로 추가 구분해야 한다.
- `reading_body`: 헤더 이후 본문을 읽는 도중 종료. HTTP 200이어도 완성 응답을 받은 것은 아니다.
- `parsing_response`: 본문은 받았으나 JSON 해석 실패.
- `validating_response`: JSON 수신 후 토큰 한도/빈 본문 등을 판정하다 실패. `finishReason`, 제공자 보고 토큰 수로 판단한다.
- `durationMs`, `headersMs`, `firstByteMs`, `lastByteMs`는 요청 시작 기준. `idleMs`는 본문 수신 실패 시 마지막 데이터(없으면 헤더) 이후 경과 시간.
- `systemChars`, `userChars`는 입력 글자 수, `requestBytes`는 실제 직렬화 요청 크기. 글 수 그 자체가 아니며 입력 크기와 실패 시간의 상관관계를 비교하는 용도다.
- 토큰 사용량 응답을 못 받은 경우 **확인 불가**이지 0토큰/무료가 아니다. `reasoningChars`는 문자 수이며 토큰과 합산하지 않는다.
- `appTimeoutMs:null`: 앱 자체 AbortSignal 타이머를 설정하지 않았다는 뜻일 뿐 Node/프록시/제공자 제한이 없다는 뜻이 아니다.
- 원인 서버를 확정하려면 제공자 요청 ID와 Railway 운영 로그를 함께 확인해야 한다. 입력 증가와 실패의 인과관계를 수치 하나로 확정하지 않는다.

## 개인정보와 한계
진단에는 프롬프트·본문·사고 텍스트·API 키·전체 URL·전체 응답 헤더를 저장하지 않는다. 호스트명과 허용 형식의 요청 ID/오류 코드만 남긴다. 제공자 오류 본문과 JSON 파싱 오류 원문도 기록하지 않는다.
기존 다이제스트에 소급해서 계측을 채울 수 없다. 새 버전 배포 후 실행부터 적용된다. Anthropic SDK 경로는 단계별 HTTP 계측 없이 시도별 총시간만 기록한다.
