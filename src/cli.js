'use strict';
// Finds the Claude Code / Codex CLIs, and opens a terminal window that installs them (official
// installers) or runs their login flow. The login itself happens in the user's browser; this
// module never sees or stores any credential — it only launches the vendor's own command.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const home = () => os.homedir();
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';

const KNOWN = {
  claude: win
    ? [path.join(home(), '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')]
    : [path.join(home(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home(), '.npm-global', 'bin', 'claude')],
  codex: win
    ? [path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'), path.join(home(), '.local', 'bin', 'codex.exe')]
    : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home(), '.npm-global', 'bin', 'codex'), path.join(home(), '.local', 'bin', 'codex')],
};

const cache = new Map(); // tool -> { at, path }

function which(name) {
  try {
    const r = spawnSync(win ? 'where' : 'which', [name], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    if (r.status !== 0) return null;
    const first = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first || null;
  } catch { return null; }
}

// Returns the executable path or null. Cached for 30s because `where`/`which` spawn a process.
function find(tool, fresh) {
  const c = cache.get(tool);
  if (!fresh && c && Date.now() - c.at < 30000) return c.path;
  let p = (KNOWN[tool] || []).find((f) => { try { return fs.existsSync(f); } catch { return false; } }) || null;
  if (!p) p = which(tool);
  cache.set(tool, { at: Date.now(), path: p });
  return p;
}

const hasNpm = () => !!which('npm');
const hasBrew = () => mac && !!which('brew');

// Quote a path for cmd.exe / sh.
const q = (s) => (win ? `"${s}"` : `'${String(s).replace(/'/g, `'\\''`)}'`);

// What the terminal should run. Install chains straight into login so one click does both.
function script(tool, action) {
  const exe = find(tool, true);
  if (tool === 'claude') {
    const bin = win ? path.join(home(), '.local', 'bin', 'claude.exe') : path.join(home(), '.local', 'bin', 'claude');
    const login = (b) => `${q(b)} auth login || ${q(b)}`; // older CLIs: plain `claude` runs the login onboarding
    if (action === 'login' && exe) return login(exe);
    if (win) return `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex" && ${login(bin)}`;
    return `curl -fsSL https://claude.ai/install.sh | bash && ${login(bin)}`;
  }
  if (tool === 'codex') {
    if (action === 'login' && exe) return `${q(exe)} login`;
    if (hasBrew()) return 'brew install codex && codex login';
    if (hasNpm()) return 'npm install -g @openai/codex && codex login';
    return null; // no package manager: caller opens the download page instead
  }
  return null;
}

const TITLES = { claude: 'Claude Code', codex: 'Codex' };

// Opens a visible terminal so the user can see the installer / pick a login method.
function openTerminal(title, cmd) {
  if (win) {
    // cmd.exe would interpret && / || of the inner command itself, so hand it a script file instead.
    const dir = path.join(os.tmpdir(), 'ai-battery');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.cmd`);
    fs.writeFileSync(file, `@echo off\r\nchcp 65001 >nul\r\ntitle ${title}\r\n${cmd}\r\n`);
    const child = spawn('cmd.exe', ['/c', 'start', `"${title}"`, 'cmd', '/k', `"${file}"`],
      { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: false });
    child.unref();
    return;
  }
  if (mac) {
    const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const child = spawn('osascript', ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${esc}"`, '-e', 'end tell'],
      { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  const term = which('x-terminal-emulator') || which('gnome-terminal') || which('xterm');
  if (!term) throw new Error('터미널을 찾지 못했습니다');
  spawn(term, ['-e', `bash -lc ${q(cmd + '; exec bash')}`], { detached: true, stdio: 'ignore' }).unref();
}

// action: 'install' (install + login) | 'login'. Returns a short Korean status for the UI.
function run(tool, action) {
  if (!TITLES[tool]) throw new Error('알 수 없는 도구');
  const cmd = script(tool, action);
  if (!cmd) {
    if (tool === 'codex') return { ok: false, open: 'https://github.com/openai/codex#installing-and-running-codex-cli', message: 'npm 또는 Homebrew가 없어 Codex CLI를 자동 설치할 수 없습니다. 안내 페이지를 엽니다.' };
    throw new Error('설치 명령을 만들지 못했습니다');
  }
  openTerminal(`AI Battery - ${TITLES[tool]} ${action === 'login' ? 'login' : 'setup'}`, cmd);
  return { ok: true, message: action === 'login' ? '터미널에서 로그인 방식을 고르면 브라우저가 열립니다.' : '터미널에서 설치가 끝나면 로그인 창이 이어집니다.' };
}

function status() {
  return {
    claude: { cli: find('claude') },
    codex: { cli: find('codex'), canInstall: hasBrew() || hasNpm() },
  };
}

module.exports = { find, run, status, script, openTerminal, KNOWN };
