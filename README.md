# AI Battery

Claude Code · ChatGPT(Codex) · Antigravity 의 사용량을 **배터리처럼** 보여주고, 각 도구의 **작업이 끝나면 소리 · 진동 · 알림**으로 알려주는 작은 위젯입니다. 화면 **우측 상단에 항상 떠 있고**, Windows 와 macOS 에서 동작하며, 모든 처리는 내 PC 안에서만 이루어집니다.

> **알아둘 것** — Claude 배터리는 **Claude Code CLI 로그인**이 있어야 표시됩니다. 이 앱은 토큰을 갱신하지 않으므로(CLI 의 로그인을 깨뜨리지 않기 위해), 토큰이 만료되면 줄에 "만료" 가 뜨고 **로그인** 버튼으로 다시 로그인하면 됩니다. 데스크톱 앱(Claude) 로그인과는 별개입니다.

## 화면 읽는 법

```
● Claude       [████████░░]  82%
● ChatGPT      [█████████░]  91%
● Antigravity  [████░░░░░░]  35%
갱신 00:39                 ↻ ⚙ ✕
```

- **연결된 도구만** 줄이 생깁니다. Claude Code · Codex 는 CLI(또는 Codex 앱) 로그인이 있을 때, Antigravity 는 실행 중일 때 나타나고, 아니면 사라집니다. 아무것도 연결돼 있지 않으면 "연동 설정 열기" 안내가 나옵니다.
- 배터리는 **가장 먼저 막히는 한도**(남은 비율이 가장 적은 창)의 남은 비율입니다. 초록(50% 넘게 남음) · 노랑(20~50%) · 빨강(20% 이하). 줄을 클릭하면 어느 한도인지, 나머지 한도(5시간 · 주간 · 모델별), 리셋 시각, 플랜이 펼쳐집니다.
- 앞의 점: 회색 `대기` · 파란 깜빡임 `작업 중` · 초록 `완료` · 노란 깜빡임 `허가 대기`(Claude Code 가 승인을 기다릴 때).
- 아래 줄: 마지막 갱신 시각, `↻` 새로고침, `⚙` 설정 · 연동, `✕` 숨기기(트레이 아이콘을 클릭하면 다시 열림).
- 이름 · 설정 라벨 · 아래 줄을 끌어 옮길 수 있고(배터리 부분은 클릭용), 설정이나 트레이 메뉴의 **우측 상단으로**로 되돌립니다. 위치는 기억되며, 화면 하단에 두면 커질 때 위로 자랍니다. `Esc` 로 설정 · 상세를 닫습니다.
- 트레이(메뉴바) 아이콘: 연결된 도구 중 가장 적게 남은 배터리. 작업 중이면 파란 점이 붙습니다. 오른쪽 클릭으로 메뉴.

## 설치와 실행

### 배포 파일로 (권장)

- **Windows**: `dist/AI-Battery-Setup-1.1.0.exe` 를 실행하면 설치되고 바로 켜집니다(사용자 폴더에 설치, 관리자 권한 불필요). 설치 없이 쓰려면 `dist/AI-Battery-1.1.0-portable.exe` 하나로도 되지만 실행마다 압축을 풀어 기동이 느립니다. 처음 실행 때 SmartScreen 경고가 뜨면 **추가 정보 → 실행**을 누르세요(서명되지 않은 개인 제작 프로그램이라 뜨는 경고입니다).
- **macOS**: `AI-Battery-1.1.0-mac-arm64.dmg`(Apple Silicon, M1 이상) 또는 `AI-Battery-1.1.0-mac-x64.dmg`(Intel) 를 열고 앱을 Applications 로 옮깁니다. dmg 는 Mac 에서 `npm run dist:mac` 으로 만들거나, Mac 이 없으면 아래 "GitHub 에서 dmg 만들기" 로 받습니다. **exe 는 Windows 전용**이라 Mac 에서는 열리지 않습니다. 서명이 없어 내려받은 파일은 "손상되었다" 거나 "확인되지 않은 개발자" 로 막힙니다. **시스템 설정 → 개인정보 보호 및 보안 → 아래쪽 "그래도 열기"** 를 누르거나, 터미널에서 다음을 한 번 실행하세요.

```bash
xattr -cr "/Applications/AI Battery.app"
```

다른 사람에게 줄 때는 설치 파일 하나만 전달하면 됩니다. 받는 쪽에서 처음 켜면 **연동이 자동으로 진행**됩니다(아래 참고).

### 소스로

Node.js 20 이상이 필요합니다.

```bash
npm install
```

```bash
npm start
```

배포 파일 만들기 (각 OS 에서 실행해야 합니다. 아이콘은 자동 생성됩니다):

```bash
npm run dist:win
```

```bash
npm run dist:mac
```

### Mac 이 없을 때 — GitHub 에서 dmg 만들기

Windows 에서는 dmg 를 만들 수 없습니다(electron-builder 가 macOS 빌드를 macOS 에서만 허용). Mac 이 없다면 GitHub 의 macOS 서버가 대신 만들어 주도록 `.github/workflows/build.yml` 을 넣어 두었습니다.

1. 이 폴더를 GitHub 저장소로 올립니다(비공개여도 됩니다. `node_modules/` 와 `dist/` 는 `.gitignore` 로 빠집니다).
2. 저장소의 **Actions** 탭 → **Build** → **Run workflow** 를 누릅니다. main 브랜치에 push 해도 실행됩니다.
3. 10분쯤 뒤 실행 결과 페이지 아래 **Artifacts** 에서 `AI-Battery-mac`(dmg 2개: Apple Silicon 용 `-mac-arm64`, Intel 용 `-mac-x64`)과 `AI-Battery-windows`(exe 2개)를 내려받습니다.
4. `v1.1.0` 처럼 `v` 로 시작하는 태그를 push 하면 같은 파일이 **Releases** 에 자동으로 첨부되어 링크로 나눠 줄 수 있습니다.

서명 · 공증은 하지 않으므로 받은 쪽에서는 위 "받아서 쓰기"의 macOS 안내대로 한 번 허용해야 합니다.

## 연동은 자동입니다

처음 켜면 이 순서로 스스로 연결합니다.

1. **CLI 찾기** — `claude` · `codex` 명령이 설치돼 있는지 확인합니다.
2. **로그인 안내** — CLI 는 있는데 로그인이 없으면 **로그인 터미널을 한 번** 엽니다(브라우저에서 로그인하면 끝. 1분 안에 배터리가 나타납니다). 다시 띄우려면 ⚙ → 연동 → **로그인**.
3. **CLI 가 없으면** ⚙ → 연동 → **설치 + 로그인** 한 번으로 공식 설치 스크립트를 터미널에서 실행하고 이어서 로그인합니다. (Claude: `irm https://claude.ai/install.ps1 | iex` / `curl -fsSL https://claude.ai/install.sh | bash`, Codex: `npm install -g @openai/codex` 또는 `brew install codex`)
4. **완료 알림 연결** — Claude Code 훅과 Codex notify 를 설정 파일에 넣습니다(각 도구의 설정 폴더가 있을 때만). 기존 파일은 원자적으로 교체하고, 원본은 `*.bak-ai-battery` 로 **한 번만** 백업하며, 들여쓰기 · 줄바꿈 종류는 유지합니다. Codex 에 이미 다른 notify 가 있으면(예: Codex 앱의 플러그인) 건드리지 않고 기록 감시만 씁니다.
5. 설정(⚙) 의 **연동** 칸에서 도구별 상태가 보이고 연결/해제를 직접 바꿀 수 있습니다. 손으로 **해제**한 것은 다시 켜도 자동으로 되살리지 않습니다. **자동 연결**을 끄면 넣었던 설정을 모두 제거합니다.

훅과 notify 는 `curl` 로 `http://127.0.0.1:47831` 에 한 줄 알려주는 것뿐이라, 이 앱이 꺼져 있어도 Claude Code / Codex 동작에는 영향이 없습니다. 요청에는 이 PC 에서 만든 비밀 토큰이 붙어, 다른 프로그램이나 웹페이지가 가짜 알림을 울릴 수 없습니다.

### 처음 켰을 때 확인할 것

- **macOS** 는 처음 한 번 키체인 접근 허용 창이 뜹니다. **"항상 허용"**을 누르세요. 거부하거나 그냥 두면 5분 뒤 다시 시도합니다(줄에 "키체인" 표시).
- **ChatGPT 줄**은 Codex CLI 또는 Codex 앱에 ChatGPT 계정으로 로그인돼 있어야 합니다.
- **Antigravity 줄**은 Antigravity 가 켜져 있을 때만 나타납니다.

## 데이터를 어디서 가져오나

| 도구 | 사용량 | 완료 감지 |
| --- | --- | --- |
| Claude Code | Claude Code CLI 가 저장한 로그인 정보(`~/.claude/.credentials.json`, macOS 는 키체인)로 Anthropic 사용량 API 조회. 5시간 · 주간 · 모델별 한도 | `~/.claude/settings.json` 의 **Stop / Notification 훅**(자동 설정) + `~/.claude/projects` 대화 기록 감시. 허가 요청도 즉시 알림 |
| ChatGPT · Codex | Codex 로그인 정보(`~/.codex/auth.json`)로 ChatGPT 사용량 API 조회. 실패하면 최근 세션 기록의 값 사용 | `~/.codex/config.toml` 의 **notify**(자동 설정, 비어 있을 때만) + `~/.codex/sessions` 기록의 `task_complete` 감지 |
| Antigravity | 실행 중인 Antigravity 의 언어 서버에 쿼터를 질의. 모델 계열(Gemini, Claude 등)별로 묶어 표시 | `~/.gemini/antigravity` 의 대화 파일 변경이 멈추면 완료로 판정 (추정 방식, 대기 시간은 설정에서 조절) |

## 알림

- 완료: 띵-동 차임 + OS 알림 + 진동. 허가 요청: 짧은 삐삐삑 + 진동 3회. 허가 대기 표시는 승인하거나 턴이 끝날 때까지 유지됩니다.
- **진동**은 표준 진동 기능을 가진 장치에 보냅니다.
  - 게임패드(Xbox · PlayStation 등 연결된 컨트롤러). 브라우저 규칙상 연결 후 버튼을 한 번 눌러야 인식됩니다.
  - SteelSeries 진동 마우스(Rival 700 / 710 등). SteelSeries GG(Engine) 가 설치돼 있으면 자동으로 사용합니다.
  - 일반 마우스에는 진동 모터가 없어 진동이 가지 않습니다. 설정의 **연동 → 진동 장치**에서 인식된 장치를 확인할 수 있습니다.
- 설정(⚙) 에서 소리 · 진동 · 도구별 알림 · 항상 위 · 로그인 시 자동 시작 · 갱신 주기 · Antigravity 판정 대기 시간을 바꾸고, **알림 테스트**로 미리 들어볼 수 있습니다.

## 개인정보

- 사용량 조회에 쓰는 토큰은 각 도구가 이미 내 PC 에 저장해 둔 것을 읽기만 하며, 공식 사용량 API 호출 외에는 사용하거나 저장하지 않습니다. 로그인 · 설치는 각 도구의 공식 명령을 터미널에서 그대로 실행할 뿐, 이 앱은 비밀번호나 토큰을 보지 않습니다.
- 로컬 수신 서버는 `127.0.0.1:47831` 에만 열리고, 토큰 없는 요청과 브라우저에서 온 요청은 거부합니다. 포트는 환경변수 `AI_BATTERY_PORT` 로 바꿀 수 있습니다.
- 위젯은 어떤 페이지로도 이동하지 않습니다(링크 · 파일을 떨어뜨려도 무시).
- 설정 파일: Windows `%APPDATA%\AI Battery\settings.json`, macOS `~/Library/Application Support/AI Battery/settings.json`. 로그: 같은 폴더의 `logs/ai-battery.log` (⚙ → 로그, 또는 트레이 메뉴 → 로그 폴더 열기).

## 개발

```bash
npm test
```

단위 테스트(훅 설치기 · 수신 서버 · 사용량 정규화 · 설정 · 상태 머신)와 완료 감지 통합 테스트(임시 폴더에 가짜 기록을 써 넣음, 약 20초)를 실행합니다. 단위 테스트만: `npm run test:unit`.

```bash
npm run probe
```

세 도구의 사용량을 실제로 조회해 콘솔에 출력합니다. 화면만 브라우저에서 보려면 `node test/serve-ui.js` 후 `http://127.0.0.1:47899` (가짜 데이터).

구조:

```
src/main.js              Electron 메인 (위젯 창 · 트레이 · 알림 · 폴링 · 훅 수신 · 자동 연동)
src/cli.js               Claude / Codex CLI 탐지, 설치 · 로그인 터미널 실행
src/hooks.js             Claude Code 훅 · Codex notify 설치/해제 (원자적 쓰기, TOML 스캐너)
src/server.js            127.0.0.1:47831 훅 수신 서버 (토큰 검증)
src/providers/*.js       도구별 사용량 조회 (claude, codex, antigravity)
src/watchers.js          도구별 완료 감지 (파일 감시) · 상태 머신
src/haptics.js           SteelSeries 진동 장치
src/settings.js          검증되는 설정 저장소
src/log.js               회전 로그 파일
src/png.js               배터리 아이콘 생성 (트레이 · 앱 아이콘)
src/renderer/            화면 (index.html, style.css, app.js)
scripts/make-icon.js     build/icon.png 생성 (electron-builder 가 ico/icns 로 변환)
test/                    run.js 가 *.test.js 를 모두 실행
```
