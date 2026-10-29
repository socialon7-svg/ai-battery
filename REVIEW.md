# AI Battery 검수 보고서 (2026-10-29)

## 조치 결과 (v1.1.0)

아래 1~19 번과 테스트 공백은 **모두 반영**되었습니다. 추가로 요청된 두 가지도 함께 들어갔습니다.

| 항목 | 조치 |
| --- | --- |
| 상 1 키체인 블로킹 | `security` 를 비동기 실행, 실패 시 5분 백오프, 줄에 "키체인" 표시 |
| 상 2 드롭 네비게이션 | `will-navigate`/`will-redirect`/`window.open` 차단, 렌더러 `dragover`/`drop` 차단, IPC 는 자체 `index.html` 프레임만 허용 |
| 상 3 비원자 쓰기·TOML 파손 | 임시 파일 + rename, 원본 백업 1회, 들여쓰기·CRLF 유지, 문자열·주석·괄호 깊이를 아는 TOML 스캐너 (테스트 15개) |
| 상 4 무인증 서버 | 설치 시 생성한 토큰을 훅 명령과 서버가 공유, `Origin`/`Sec-Fetch-Site` 거부, JSON 만, 256KB 제한, Buffer 조립, 경로 앵커 (테스트 9개) |
| 중 5 허가 대기 덮임 | `Activity` 에 `attention` 상태 분리, 트랜스크립트가 실제로 진행될 때만 해제 (테스트 5개) |
| 중 6 창 아래로 넘침·드래그 | 리사이즈 시 작업영역 클램프(위로 자람), 이름·라벨·푸터·제목이 드래그 영역, Esc 닫기 |
| 중 7 해제 되살아남·포트 변경 | 도구별 `hookOptOut`, 포트/토큰이 바뀐 자기 훅은 `stale` 로 자동 교체 |
| 중 8 메인 배터리 기준 | 세 도구 모두 "남은 비율이 가장 적은 한도" 로 통일 |
| 중 9 폴링 구조 | 공급자별 독립 갱신 + 개별 타임아웃 + `finally`, Antigravity 미실행 시 3분 백오프, 훅 상태·SteelSeries 캐시, 트레이는 변경 시만 |
| 중 10 mock 노출 | `http:` 미리보기에서만 mock, 그 외엔 오류 표시 |
| 중 11 배포 | NSIS 설치 파일 + portable 병행, 로그인 시 자동 시작 옵션, `LSUIElement`, README 의 macOS 15 안내 수정 |
| 중 12 로그 | `logs/ai-battery.log` 회전 로그, 예외 기록, ⚙·트레이에서 열기 |
| 하 13~19 | bounds 저장 억제·모니터 변경 재배치, `second-instance` 가드, DOM 은 변경 시만 갱신·버튼 busy 유지·`dialog` 사용·select 보정, 워처 예외 처리·24시간 정리, README 경로·Node 20, Codex 폴더 없음 표시, 죽은 코드 제거, macOS 밝은 메뉴바용 테두리 |
| 테스트 | `test/run.js` 가 hooks · server · providers · settings · activity · watchers 를 실행 (단위 42개 + 통합 1개) |
| 추가 요청 | CLI 자동 연결(`src/cli.js`): 탐지 → 로그인 터미널 자동 1회 → 설치+로그인 버튼. 미연결 도구는 배터리 줄을 숨김 |

---

대상: `src/**`, `package.json`, `scripts/`, `test/`, `README.md` (Electron 45.1.0 · electron-builder 26.18.0)
방법: 전 소스 정독 + 독립 리뷰 에이전트 교차 검토 + 임시 홈 디렉터리에서 훅 설치기·서버 재현 테스트 + 이 PC의 실제 설정·트랜스크립트 키 확인(내용 미열람)

## 총평

구조와 보안 기본기는 탄탄합니다. 렌더러 샌드박스·CSP·IPC 최소 노출, 외부 도구 설정을 보수적으로 건드리는 설계, 워처의 오탐 방지 장치는 잘 되어 있습니다.
다만 **배포 전에 반드시 고쳐야 할 "상" 4건**이 있습니다. 모두 반나절 안에 고칠 수 있는 크기입니다.

그리고 버그는 아니지만 가장 큰 실사용 한계가 하나 있습니다.
**Claude 배터리는 Claude Code CLI 의 토큰이 살아 있는 동안만 표시됩니다.** 이 앱은 토큰을 갱신하지 않으므로(CLI 의 refresh 토큰을 무효화할 위험 때문에 의도적으로 뺐음), CLI 를 자주 쓰지 않는 사용자는 "토큰 만료" 를 자주 보게 됩니다. 데스크톱 앱만 쓰는 사용자(이 PC 포함)는 CLI 로그인을 한 번 해야 합니다. 이 한계는 README 첫 화면에 명시하는 것이 맞습니다.

---

## 상 (배포 전 필수)

### 1. macOS: 키체인 조회가 메인 프로세스를 동기 블로킹 + 8초 뒤 강제 종료 루프
- `src/providers/claude.js:18-23` — `execFileSync('security', …, { timeout: 8000 })` 를 **매 폴링(60초)마다 메인 스레드에서** 실행.
- 첫 실행 때 키체인 허용 창이 뜨면 UI·트레이·IPC 가 최대 8초 멈추고, 8초 안에 못 누르면 프로세스가 죽어 "로그인 필요" 로 표시된 뒤 60초 후 다시 창이 뜹니다. "항상 허용" 이 아니라 "허용" 을 누르면 매 분 반복됩니다.
- 수정: 비동기 `execFile` 로 바꾸고 `readCredentials` 를 async 로. 첫 호출 타임아웃은 60초 이상으로, 실패 시 5분 백오프. UI 에 "키체인 접근을 허용해 주세요" 상태를 별도 표시.

### 2. 창에 링크나 파일을 끌어다 놓으면 위젯이 외부 페이지로 바뀌고 `window.api` 가 노출됨
- `src/main.js:168-221` 에 `will-navigate` 처리 없음, `src/renderer/app.js` 에 `dragover`/`drop` preventDefault 없음, IPC 핸들러(`main.js:277-309`)에 sender 검증 없음.
- 항상 위에 떠 있는 위젯은 자연스러운 드롭 대상입니다. URL 이나 `.html` 을 떨어뜨리면 Chromium 기본 동작으로 그 페이지로 이동하고, preload 가 다시 실행돼 외부 페이지가 `api.hooks('claude','install')`, `api.setSettings`, `api.copy`(클립보드 덮어쓰기), `api.getState`(사용자명 포함 경로·설정)를 호출할 수 있습니다. 토큰은 노출되지 않지만 복구 수단이 없습니다.
- 수정: `win.webContents.on('will-navigate', e => e.preventDefault())`, 렌더러에서 `dragover`/`drop` 차단, IPC 에서 `event.senderFrame.url` 이 자체 `index.html` 인지 검증.

### 3. 사용자 설정 파일 쓰기가 비원자적이고, 중첩 배열이 있는 config.toml 을 깨뜨림 (재현됨)
- `src/hooks.js:23-27` — `copyFileSync` 후 `writeFileSync`. 쓰는 도중 크래시·정전이면 `~/.claude/settings.json` 이 잘린 채 남아 **Claude Code 자체가 기동하지 못합니다.**
- `src/hooks.js:131` — `^[ \t]*\[` 로 첫 테이블을 찾는데, 최상위 여러 줄 배열의 `[1, 2],` 행을 테이블로 오인합니다. 재현 결과 notify 줄이 배열 **안에** 삽입돼 유효하지 않은 TOML 이 됐고, 이 상태면 Codex 가 설정을 읽지 못합니다. (드문 구성이지만 결과가 치명적)
- 백업 `.bak-ai-battery` 가 매 쓰기마다 덮어써져 설치→해제 뒤에는 원본(설치 전) 백업이 사라집니다. 해제 시 CRLF 파일이 LF 로 바뀝니다.
- 수정: 임시 파일에 쓴 뒤 `renameSync`; 백업은 없을 때만 만들거나 타임스탬프 부여; TOML 은 제대로 된 파서(`@iarna/toml` 또는 `smol-toml`)로 읽고 `notify` 키만 설정 후 직렬화하거나, 최소한 삽입 위치를 "직전 줄이 `]` 또는 값 종료" 인 테이블 헤더로 한정; 원본 줄바꿈 종류 유지.

### 4. 로컬 훅 서버가 인증 없이 모든 POST 를 받음 → 가짜 알림·상태 위조
- `src/server.js:7-25`, 소비처 `src/main.js:316-333`. `Origin` 검사·공유 토큰·Content-Type 검사·속도 제한이 없습니다.
- 로컬의 어떤 프로세스나, 브라우저의 단순 요청(`text/plain`, `no-cors`)으로 `/hook/claude/notification` 에 `{"notification_type":"permission_prompt","message":"…"}` 를 보내면 **공격자 문구가 담긴 OS 알림** 이 울리고 Claude 줄이 "허가 대기" 로 바뀝니다. 최신 Chrome 은 로컬 네트워크 접근에 사용자 허가를 묻지만, 다른 브라우저·구버전은 그렇지 않습니다. 데이터 유출은 없고 영향은 "가짜 알림" 에 그치지만, 수정 비용이 몇 분이라 상으로 둡니다.
- 수정: 설치 시 userData 에 난수 토큰을 만들어 훅 명령에 `-H "X-AI-Battery: <token>"` 을 넣고 서버에서 검증. `Origin` 헤더가 있으면 403. `message` 는 200자로 자르고 표시용 텍스트는 그대로 쓰지 않기. 바디는 Buffer 로 모아 concat(현재 문자열 누적이라 멀티바이트 경계에서 깨질 수 있음). 경로 정규식에 `$` 앵커.

---

## 중 (사용성·신뢰성)

5. **"허가 대기" 표시가 20초 안에 사라짐** — `main.js:325` 가 `set('working','허가 대기 중')` 을 해도 `watchers.js:130-139` 의 `recompute()` (모든 `apply` 끝 + 20초 주기)가 트랜스크립트 기준 `'도구 실행 중'` 으로 덮어씁니다. 렌더러는 `/허가/` 문자열로 판정하므로 노란 깜빡임이 파란 "작업 중" 으로 돌아갑니다. → `Activity` 에 별도 `attention` 상태를 두고, 다음 트랜스크립트 변경(tool_result)이나 Stop 훅에서만 해제.

6. **창이 아래로만 자라 화면 밖으로 나감 + 드래그 영역이 좁음** — `main.js:303-307` 은 좌상단 고정으로 높이만 키웁니다. 위젯을 화면 하단에 두고 ⚙ 를 누르면 약 400px 로 커져 푸터(닫기 버튼)가 작업영역 밖으로 나가고 `overflow:hidden` 이라 스크롤도 안 됩니다. 설정 모드에서 끌 수 있는 곳은 8px 테두리뿐이라 트레이 메뉴로만 복구됩니다. → 리사이즈 때 `screen.getDisplayMatching(bounds).workArea` 로 y 를 클램프(아래가 넘치면 위로 밀기). 설정 패널의 제목(`h4`)과 빈 영역, 행의 이름 부분은 drag 로, 컨트롤만 no-drag 로. Esc 로 설정 닫기.

7. **수동 "해제" 가 다음 실행 때 되살아남 / 포트를 바꾸면 자기 notify 를 남의 것으로 오인** — `main.js:259-269` 의 `autoConnect` 는 `present && !installed` 면 무조건 설치하고, 수동 해제는 `autoHook` 을 바꾸지 않습니다. `hooks.js:117-118` 은 다른 포트의 자기 notify 를 `foreign` 으로 분류해 설치도 해제도 못 합니다(Claude 쪽 `strip()` 은 포트 무관이라 정상). → 수동 해제 시 도구별 opt-out 플래그 저장; `codexStatus` 는 `/hook/codex/` 포함이면 "ours(오래됨)" 로 보고 교체.

8. **메인 배터리 기준이 공급자마다 다름** — Claude(`providers/claude.js:75`)·Codex 는 항상 5시간 창, Antigravity 는 최소 잔량. 주간 12% · 5시간 90% 면 줄도 트레이(`main.js:73`)도 초록입니다. README 의 "가장 빨리 소모되는 한도" 와도 어긋납니다. → 잔량이 가장 적은 창을 main 으로(동률이면 짧은 창), 라벨로 어느 창인지 표시.

9. **폴링 구조** — `refreshUsage` 가 `Promise.allSettled` 로 가장 느린 공급자를 기다리므로 Antigravity 탐색(tasklist → PowerShell → netstat → 포트×프로토콜별 4초 타임아웃) 동안 Claude·Codex 도 "갱신 중". Antigravity 가 꺼져 있어도 매 분 `tasklist` 스폰. `state.refreshing` 을 `finally` 없이 내려서 중간에 예외가 나면 폴링이 영구 정지. `snapshot()` 마다 `settings.json`·`config.toml`·`coreProps.json` 을 동기 read+parse 하고 트레이 PNG 를 매번 재인코딩(`main.js:58-59, 76`). → 공급자별 독립 갱신·개별 타임아웃·`finally`; 훅 상태와 SteelSeries 주소는 설치/해제 시 또는 30초 캐시; 트레이는 값이 바뀔 때만 갱신.

10. **preload 가 실패하면 가짜 데이터가 그대로 보임** — `app.js:14` `window.api || mockApi()`. 패키징 문제로 preload 가 안 뜨면 사용자는 73%/91%/35% 와 "Max"/"Pro" 플랜을 진짜로 믿습니다. → `location.protocol === 'http:'` 일 때만 mock, 그 외엔 "내부 오류" 표시.

11. **배포 형태** — portable exe 는 실행마다 `%TEMP%` 에 110MB 를 풀어서 기동이 느리고 백신 스캔을 매번 받습니다. 시작 메뉴 바로가기가 없어 로그인 시 자동 시작을 넣기 어렵고, Windows 토스트가 portable 빌드에서 실제로 뜨는지 **직접 확인이 필요**합니다(안 뜨면 조용히 실패). → NSIS(oneClick, perUser) 로 바꾸고 `app.setLoginItemSettings` 로 "로그인 시 시작" 옵션 추가. macOS 는 서명이 없어 다른 사람이 내려받은 dmg 는 "손상됨" 으로 뜨고, macOS 15 부터는 README 의 "오른쪽 클릭 → 열기" 가 통하지 않습니다(시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기", 또는 `xattr -cr`). `extendInfo: { LSUIElement: 1 }` 이 없어 실행 시 Dock 아이콘이 잠깐 번쩍입니다.

12. **로그 파일이 없음** — `console.log` 만 있어 배포된 exe 에서 문제가 나면 진단할 수 없습니다. → userData 에 회전 로그 파일(`electron-log` 또는 직접 20줄짜리 로거).

---

## 하 (정리하면 좋은 것)

13. `resetPosition()` 뒤에도 `bounds` 가 `null` 로 남지 않음 — `setPosition` 이 `move` 이벤트를 내서 500ms 뒤 우상단 좌표가 다시 저장됩니다. 이 PC 의 설정 파일에도 사용자가 끌지 않았는데 `{x:2268, y:12}`(= 2560−280−12) 가 저장돼 있어 확인됐습니다. 해상도가 바뀌면 우상단을 따라가지 않습니다. 모니터 변경(`screen.on('display-metrics-changed')`)도 처리되지 않습니다.
14. `second-instance` 핸들러(`main.js:350`)가 `ready` 전에 호출되면 `new BrowserWindow` 예외. 느린 portable 첫 실행 중 두 번 더블클릭하면 가능. `if (!app.isReady()) return` 한 줄.
15. 렌더러: 15초마다 `innerHTML` 전면 재생성이라 배터리 `transition` 이 사실상 작동하지 않고, 진행 중인 훅 버튼의 `disabled` 가 풀려 중복 클릭이 가능하며, 호버 툴팁이 끊깁니다. `window.alert()` 는 Windows frameless 창에서 포커스를 깨는 알려진 Electron 이슈 → `dialog.showMessageBox`. `select` 에 없는 값(예: 15초로 클램프된 값)이면 빈칸.
16. `watchers.js:169-179` 의 `classify` 호출이 try 밖이라 `null` 한 줄에도 unhandled rejection. `files` Map 은 영구 증가(실사용 영향 미미). `maybe-done` 폴백 6초 > 중복 제거 창 5초라 `stop_reason` 이 비는 포맷에서는 두 번 알림(현재 트랜스크립트는 전 줄에 `stop_reason` 이 있어 발생하지 않음을 확인).
17. README 오류: 설정 파일 경로는 `%APPDATA%\AI Battery\settings.json` (productName 기준, 확인됨). `fs.watch({recursive:true})` 는 macOS 에서 Node 20+ 필요 → "Node 18 이상" 을 20 으로.
18. 설정 패널의 Codex 줄이 `~/.codex` 가 없어도 "기록 감시 ✓" 로 표시됨. `state.events`, `open:external` 은 쓰이지 않는 코드. `strip()` 은 우리 명령이 든 **그룹 전체**를 지우므로 사용자가 같은 그룹에 자기 훅을 넣어뒀다면 같이 사라짐(우리가 만드는 그룹은 분리돼 있어 보통은 무관).
19. macOS 트레이 아이콘이 템플릿 이미지가 아닌 컬러 16px 이라 밝은 메뉴바에서 대비가 낮음(배터리 색을 유지하려는 의도라면 테두리만 진하게).

---

## 테스트 공백

- `hooks.js` 테스트가 저장돼 있지 않음(세션 중 임시 스크립트로만 검증). 설치/해제 멱등성, 포트 변경, foreign notify, BOM/CRLF, 중첩 배열, 백업 내용을 `test/hooks.test.js` 로.
- `server.js`: 라우팅, 비JSON 바디, 1MB 초과, Origin 거부(4번 수정 후 회귀 테스트).
- 공급자 정규화 순수 함수(`codex.normalizeApi`/`fromRollouts`, `antigravity.normalize`, Claude 창 선택)와 `settings.js` 마이그레이션이 미테스트.
- `watchers.test.js` 는 고정 sleep 기반이라 느린 머신에서 불안정. 시딩(10분 이상 된 파일 미발화), `[Request interrupted`, Codex `turn_aborted`·child turn, 중복 제거 창이 미커버.

## 잘된 점

1. 보안 기본기: `contextIsolation` + `sandbox` + `nodeIntegration:false`, preload 는 고정 채널만, 엄격한 CSP, 동적 HTML 전부 `esc()`, `openExternal` 은 https 만.
2. 외부 도구 설정 편집이 보수적: 기존 Codex notify 를 건드리지 않고(이 PC 의 computer-use notify 를 정확히 foreign 으로 판정), Claude 훅은 별도 그룹으로 추가해 사용자 훅을 보존(재현 확인), `curl … || exit 0` + `-m 3` + `timeout 5` 로 앱이 꺼져 있어도 Claude/Codex 가 느려지지 않음.
3. 워처: tail 상한(192KB)·디바운스·시작 시 시딩·서브에이전트 제외·디렉터리 부재 재시도·`fs.watch` 오류 복구. 실제 rollout 키(`turn_attribution`, `root_turn_id`, `last_agent_message`)와 일치.
4. 실패가 UX 로 이어짐: `setup`/`notRunning` 플래그와 실행 가능한 안내, Codex 는 API 실패 시 rollout 폴백에 `stale`/`asOf` 표시, `allSettled` 로 한 공급자 실패가 나머지를 가리지 않음.
5. 운영 세부: 단일 인스턴스, 닫기→숨김과 `before-quit`, 트레이 객체 GC 안전, 저장 위치 가시성 검증, 설정 버전 마이그레이션, 의존성 없는 PNG 인코더.

## 추천 작업 순서

1. 상 1~4 (반나절): 키체인 비동기화, `will-navigate`/drop 차단 + IPC sender 검증, 원자적 쓰기 + TOML 파서, 훅 토큰 + Origin 거부.
2. 중 5~8 (반나절): attention 상태 분리, 리사이즈 클램프 + 드래그 영역, 해제 플래그, 메인 배터리 기준 통일.
3. 중 9~12: 폴링 구조·캐시, mock 가드, NSIS + 자동 시작 + README(mac 안내·설정 경로·Node 20), 로그 파일.
4. 테스트: hooks/server/정규화 함수 단위 테스트 추가.
