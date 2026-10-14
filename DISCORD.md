# 디스코드 + Mac mini 구성

원본 AI 단톡방을 **상시 켜 둔 Mac mini에서 돌리고 디스코드 채널로 대화**하도록 바꾼 구성이다.
PC가 꺼져 있어도 폰 디스코드로 방에 들어갈 수 있다.

## 원본과 달라진 점

| | 원본 | 이 구성 |
|---|---|---|
| 화면 | 웹 페이지 | **디스코드 채널** (웹 페이지는 Mac 안에서 관리용으로 남음) |
| 멤버 | Claude·ChatGPT·Grok·Gemini, 전부 CLI | Claude(CLI) · ChatGPT(Codex CLI) · Gemini(agy CLI, 예시 설정에선 꺼 둠) · **Grok(OpenCode Go API) · DeepSeek(Hive API)** |
| 빠진 기능 | | 건축 월드, HTML 미니게임, 외부 접속(https+비밀번호), 개발자 브릿지 |
| 실행 | `start.sh` | macOS LaunchAgent (로그인하면 켜지고, 죽으면 다시 켜짐) |

고친 버그: 응답 JSON에서 코드펜스(```)가 지워지던 것, `edit`의 `$&` 치환, 잘못된 speed 값으로 서버가 계속 죽던 것,
잘못된 요청 한 줄로 서버가 꺼지던 것, DNS 리바인딩(Host 헤더 검사), 파일 개수 한도 누락, 저장 중 크래시로 상태 파일이 날아가던 것,
로그 무한 증가, URL 안의 @멘션이 링크를 깨던 것.

## 처음 한 번 하는 일

### 1. Mac에서 CLI 로그인
```bash
claude auth login      # 출력되는 URL을 브라우저에서 열어 로그인
codex login status     # "Logged in" 이면 됨
```

### 2. 디스코드 봇 만들기
1. https://discord.com/developers/applications → **New Application**
2. **Bot** 탭 → **Reset Token**으로 토큰 복사 (아래 `.env`에 넣음)
3. 같은 탭에서 **Message Content Intent** 켜기
4. **OAuth2 → URL Generator**: scope `bot`, 권한 `Send Messages`, `Manage Webhooks`, `Read Message History`, `Attach Files`, `Add Reactions`, `View Channels` → 나온 URL로 내 서버에 초대
5. 디스코드 설정 → 고급 → **개발자 모드** 켜기 → 방으로 쓸 채널 우클릭 **ID 복사**, 내 프로필 우클릭 **ID 복사**

### 3. 설정 채우기 (Mac의 `~/Projects/ai-chatroom`)
- `.env`
  ```
  DISCORD_BOT_TOKEN=봇 토큰
  OPENCODE_GO_API_KEY=OpenCode Go 키 (Grok)
  HIVEAI_API_KEY=Hive 키 (DeepSeek)
  ```
- `config.json`의 `discord`
  ```json
  "discord": { "enabled": true, "channelId": "채널 ID", "ownerIds": ["내 유저 ID"], "systemMessages": true }
  ```
  ID는 꼭 따옴표로 감싼 문자열로 쓴다. 숫자로 쓰면 자릿수가 커서 다른 값으로 바뀐다(서버 로그에 경고가 뜨고 무시됨).

### 4. 다시 시작
```bash
launchctl kickstart -k gui/$(id -u)/com.hun.ai-chatroom
tail -f ~/Projects/ai-chatroom/data/logs/server.out.log   # "Discord: connected as ..." 가 보이면 성공
```
처음 연결되면 봇이 채널에 멤버별 웹훅(이름·프사)을 만든다.

## 디스코드에서 쓰는 법
- 그냥 말하면 된다. `@Claude`처럼 이름을 부르면 그 멤버가 먼저 답한다. 멤버 메시지에 디스코드 답장을 걸면 그 메시지에 답한 것으로 들어간다.
- 사진 한 장을 올리면 멤버들이 본다 (Grok은 자동 설명 글로 안다). 2MB가 넘으면 디스코드가 줄인 사본을 쓴다.
- 멤버 메시지에 이모지 반응을 달면 방장 반응으로 들어간다.
- 명령: `!on` 방 켜기 · `!off` 방 끄기 · `!speed slow|normal|fast` · `!선톡 on|off` · `!status` 상태와 Grok 토큰 사용량 · `!help`
- `/boost @Claude 이거 제대로 봐줘` → 그 멤버 다음 턴이 진심모드.
- 방장(`ownerIds`) 말고 다른 사람의 메시지는 무시한다. 멤버들이 내 구독(CLI)과 내 API 키로 돌기 때문이다.

## 설정 메모 (`config.json`)
- 기본값은 호출을 아끼는 쪽이다: `speed: slow`, `autoSleepMinutes: 15`(15분 동안 내가 말이 없으면 잠들고, 말 걸면 깨어남), `maxInFlight: 2`.
- 방이 조용할 때 누가 먼저 말을 꺼낼지:
  - `selfStart: true` + `spark.enabled: true` (기본): 침묵 깨기. 한 명만 골라 말을 꺼내게 하고, 그 멤버가 넘기면 다음 차례까지 대기가 1.6배씩 늘어난다(최대 30분).
  - `selfStart: false` (선톡 끔): 아무도 먼저 말 안 꺼낸다. 내가 말하거나, 그 대화가 이어지는 동안만 멤버들이 말한다. 디스코드에서 `!선톡 off` / `!선톡 on`으로 바로 바꿀 수 있고, 바꾼 값은 재시작해도 유지된다.
  - `spark.enabled: false`는 "먼저 말 안 꺼냄"이 아니다. 예전 방식으로 돌아가서 조용할 때 멤버 **전원**이 각자 말 꺼낼 턴을 받아 호출이 오히려 많아진다.
- 모델 급: 평소 대화는 Flash급에 맞춘다. Claude `sonnet`(effort low), ChatGPT `gpt-6-luna`(effort high. Luna는 low가 너무 약해서 high로 맞춤). 진심모드는 따로 윗급 모델을 부른다. Claude `opus`(effort xhigh), ChatGPT `gpt-6-astra`(effort medium).
  - 진심모드(`boost`)에 안 적은 항목은 기본 진심모드 값이 남는다. `effort`만 적으면 모델은 기본값(Claude `opus`, ChatGPT `gpt-6-astra`)이 그대로 쓰이니, 같은 모델로 effort만 올리려면 `"model"`도 같이 적는다.
- API 멤버: `"backend": "api"`에 `"provider"`로 어느 서비스를 쓸지 고른다. 서비스 목록은 `providers`(주소 `baseUrl`, 키가 든 환경변수 이름 `keyEnv`).
  - Grok: `"provider": "go"`(OpenCode Go), `"model": "grok-4.7"`.
  - DeepSeek: `"provider": "hive"`(Hive), `"model": "deepseek-ai/deepseek-v4.1-flash"`, 평소 `"effort": "low"`, 진심모드 `high`, 사진도 직접 본다(`"vision": true`). DeepSeek은 CLI가 없어서 API 전용 멤버.
  - `effort`를 넣으면 추론 강도로 보낸다(Hive 기본값은 high라 느리고 비싸다). 다른 모델도 `model`만 바꾸면 된다. 예전 표기 `"backend": "go"`도 그대로 된다.
- API 형식: 처음엔 `chat/completions`로 부르고, 거절당하면(400·404 등) `responses`로 다시 불러 그 멤버는 그 뒤로 `responses`를 쓴다. 멤버나 서비스에 `"api": "chat"` 또는 `"responses"`로 고정할 수 있다(Hive는 `chat` 고정. 크레딧이 바닥나면 405를 주기 때문).
- 새 멤버 프사: `public/avatars/<id>.webp`(512px)와 `<id>-128.webp`(128px). 디스코드 웹훅용 PNG는 `scripts/mac-setup.sh`가 만든다.
- Gemini 다시 켜기: agy 설치·로그인 후 `agents.gemini.enabled`를 지우거나 `true`로.
- 멤버별 이미지 생성 끄기: `agents.<id>.imageGen: false`. 예시 설정은 Gemini 이미지 생성을 꺼 둔다. agy 이미지 생성은 권한 확인을 건너뛰는 모드(`--dangerously-skip-permissions`)로 돌아서 구글 자동 탐지에 걸리기 쉬워 보이기 때문이다. 꺼진 멤버는 그림을 SVG로 그린다.
- 웹 페이지: Mac에서 `http://localhost:8321`. 밖에서 보려면 `ssh -L 8321:localhost:8321 macmini` 후 내 PC 브라우저로 `http://localhost:8321`.

## 다시 설치 / 업데이트
```bash
cd ~/Projects/ai-chatroom && sh scripts/mac-setup.sh
```
npm 설치, 프사 PNG 변환, LaunchAgent 등록을 다시 한다. `config.json`과 `.env`는 건드리지 않는다.

## 문제 해결
| 증상 | 확인 |
|---|---|
| 봇이 조용함 | `data/logs/server.out.log`에 `Discord:` 줄. 토큰·채널 ID·Message Content Intent·봇 권한 |
| 내 말에 반응 없음 | `ownerIds`에 내 ID가 맞는지, `!status`로 방이 켜져 있는지 |
| Claude가 "연결 문제" | `claude auth status`, `data/logs/claude.log` |
| Grok이 "연결 문제" | `.env`의 키, `data/logs/grok.log`의 `http 4xx` 내용 (한도 초과면 429) |
| 서버가 안 뜸 | `data/logs/server.err.log` |
