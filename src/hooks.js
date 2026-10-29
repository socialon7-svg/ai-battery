'use strict';
// Installs/removes the bits that make other tools tell this app when a turn ends:
//  - Claude Code: Stop + Notification hooks in ~/.claude/settings.json
//  - Codex:       `notify` command in ~/.codex/config.toml
// Both POST to the local server with curl (ships with Windows 10+ and macOS) and carry a shared
// token so nothing else on the machine can forge alerts. Files are written atomically, the
// original is backed up once, and the user's indentation / line endings are preserved.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MARK = '/hook/claude/';
const CODEX_MARK = '/hook/codex/';
const BAK = '.bak-ai-battery';

function claudeDir() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
function settingsFile() { return path.join(claudeDir(), 'settings.json'); }
function codexDir() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function codexConfig() { return path.join(codexDir(), 'config.toml'); }

// Works under both sh (macOS/Linux/Git Bash) and cmd.exe: `|| exit 0` keeps the hook from ever failing.
function command(port, token, kind) {
  return `curl -s -m 3 -X POST http://127.0.0.1:${port}/hook/claude/${kind} -H "Content-Type: application/json" -H "X-AI-Battery: ${token}" --data-binary @- || exit 0`;
}

// Codex runs `notify` with the JSON payload appended as the last argument, so ending the
// command with --data-binary makes curl send exactly that payload.
function codexNotify(port, token) {
  return ['curl', '-s', '-m', '3', '-X', 'POST', `http://127.0.0.1:${port}/hook/codex/stop`,
    '-H', 'Content-Type: application/json', '-H', `X-AI-Battery: ${token}`, '--data-binary'];
}

// ---------- file helpers ----------

const stripBom = (s) => s.replace(/^﻿/, '');
const eolOf = (raw) => (raw.includes('\r\n') ? '\r\n' : '\n');

function readText(file) {
  return fs.existsSync(file) ? stripBom(fs.readFileSync(file, 'utf8')) : null;
}

function backupOnce(file) {
  if (fs.existsSync(file) && !fs.existsSync(file + BAK)) fs.copyFileSync(file, file + BAK);
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupOnce(file);
  const tmp = `${file}.ai-battery-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ---------- Claude Code ----------

function detectIndent(raw) {
  const m = /\n([ \t]+)"/.exec(raw || '');
  return m ? m[1] : '  ';
}

function readClaude() {
  const raw = readText(settingsFile());
  if (raw === null || !raw.trim()) return { obj: {}, indent: '  ', eol: '\n' };
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('settings.json 최상위가 객체가 아닙니다');
  return { obj, indent: detectIndent(raw), eol: eolOf(raw) };
}

function writeClaude({ obj, indent, eol }) {
  const text = JSON.stringify(obj, null, indent).replace(/\n/g, eol) + eol;
  atomicWrite(settingsFile(), text);
}

const isOurHook = (h) => h && typeof h.command === 'string' && h.command.includes(MARK);

// Removes only our own entries; the user's hooks in the same group survive.
function stripOurs(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurHook(h)) } : g))
    .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
}

function hasCommand(groups, cmd) {
  return Array.isArray(groups) && groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && h.command === cmd));
}

function hasOurs(groups) {
  return Array.isArray(groups) && groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurHook));
}

// installed: both hooks point at this port+token. stale: ours but for an old port/token.
function claudeStatus(port, token) {
  const present = fs.existsSync(claudeDir());
  const file = settingsFile();
  try {
    const h = readClaude().obj.hooks || {};
    const stop = hasCommand(h.Stop, command(port, token, 'stop'));
    const notification = hasCommand(h.Notification, command(port, token, 'notification'));
    const ours = hasOurs(h.Stop) || hasOurs(h.Notification);
    const installed = stop && notification;
    return { installed, stale: ours && !installed, ours, present, file };
  } catch (e) {
    return { installed: false, stale: false, ours: false, present, file, error: e.message };
  }
}

function installClaude(port, token) {
  const doc = readClaude();
  const s = doc.obj;
  s.hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  for (const [event, kind] of [['Stop', 'stop'], ['Notification', 'notification']]) {
    const arr = stripOurs(s.hooks[event]);
    arr.push({ hooks: [{ type: 'command', command: command(port, token, kind), timeout: 5 }] });
    s.hooks[event] = arr;
  }
  writeClaude(doc);
  return claudeStatus(port, token);
}

function uninstallClaude(port, token) {
  const doc = readClaude();
  const s = doc.obj;
  if (s.hooks && typeof s.hooks === 'object') {
    for (const event of ['Stop', 'Notification']) {
      if (!(event in s.hooks)) continue;
      const arr = stripOurs(s.hooks[event]);
      if (arr.length) s.hooks[event] = arr; else delete s.hooks[event];
    }
    if (!Object.keys(s.hooks).length) delete s.hooks;
    writeClaude(doc);
  }
  return claudeStatus(port, token);
}

// ---------- Codex ----------

// Line-level TOML scan that knows enough syntax to be safe: strings and comments are skipped,
// bracket depth is tracked so a `[1, 2],` line inside a multi-line array is not mistaken for a
// table header, and only top-level (depth 0, before the first table) `notify` keys count.
function scanToml(raw) {
  const lines = raw.split(/\r?\n/);
  let depth = 0;
  let multi = null; // open multi-line string delimiter: """ or '''
  let notify = null;
  let tableAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let s = line;
    const startedInString = !!multi;
    if (multi) {
      const j = s.indexOf(multi);
      if (j < 0) continue;
      s = s.slice(j + 3);
      multi = null;
    }
    let code = '';
    for (let k = 0; k < s.length;) {
      const ch = s[k];
      if (ch === '#') break;
      if (s.startsWith('"""', k) || s.startsWith("'''", k)) {
        const d = s.slice(k, k + 3);
        const j = s.indexOf(d, k + 3);
        if (j < 0) { multi = d; break; }
        k = j + 3;
        continue;
      }
      if (ch === '"') { k++; while (k < s.length && s[k] !== '"') k += s[k] === '\\' ? 2 : 1; k++; continue; }
      if (ch === "'") { k++; while (k < s.length && s[k] !== "'") k++; k++; continue; }
      code += ch;
      k++;
    }
    const t = line.trim();
    if (depth === 0 && !startedInString) {
      if (/^\[/.test(t)) { tableAt = i; break; }
      if (!notify && /^notify\s*=/.test(t)) notify = { index: i, line };
    }
    for (const ch of code) {
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return { lines, notify, tableAt: tableAt < 0 ? lines.length : tableAt };
}

function codexStatus(port, token) {
  const present = fs.existsSync(codexDir());
  const file = codexConfig();
  try {
    const raw = readText(file);
    if (raw === null) return { installed: false, stale: false, ours: false, foreign: false, present, file };
    const { notify } = scanToml(raw);
    if (!notify) return { installed: false, stale: false, ours: false, foreign: false, present, file };
    const ours = notify.line.includes(CODEX_MARK);
    const installed = ours && notify.line.trim() === notifyLine(port, token);
    return { installed, stale: ours && !installed, ours, foreign: !ours, present, file };
  } catch (e) {
    return { installed: false, stale: false, ours: false, foreign: false, present, file, error: e.message };
  }
}

function notifyLine(port, token) {
  return `notify = ${JSON.stringify(codexNotify(port, token))}`; // a JSON string array is valid TOML
}

function installCodex(port, token) {
  const st = codexStatus(port, token);
  if (st.installed) return st;
  if (st.foreign) throw new Error('Codex config.toml에 이미 다른 notify 설정이 있어 그대로 두었습니다. 완료는 세션 기록 감시로 감지합니다.');
  const file = codexConfig();
  const raw = readText(file) || '';
  const eol = eolOf(raw);
  const { lines, notify, tableAt } = scanToml(raw);
  let at = tableAt;
  if (notify) { lines.splice(notify.index, 1); at = notify.index; } // replace our stale line in place
  else { while (at > 0 && /^\s*(#.*)?$/.test(lines[at - 1])) at--; } // before the comment block of the first table
  lines.splice(at, 0, notifyLine(port, token));
  let text = lines.join(eol);
  if (!text.endsWith(eol)) text += eol;
  atomicWrite(file, text);
  return codexStatus(port, token);
}

function uninstallCodex(port, token) {
  const file = codexConfig();
  const raw = readText(file);
  if (raw === null) return codexStatus(port, token);
  const { lines, notify } = scanToml(raw);
  if (!notify || !notify.line.includes(CODEX_MARK)) return codexStatus(port, token);
  lines.splice(notify.index, 1);
  atomicWrite(file, lines.join(eolOf(raw)));
  return codexStatus(port, token);
}

module.exports = {
  claudeStatus, installClaude, uninstallClaude,
  codexStatus, installCodex, uninstallCodex,
  command, codexNotify, scanToml, stripOurs, MARK, CODEX_MARK, BAK,
};
