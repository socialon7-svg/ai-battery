'use strict';
// Claude Code usage: official OAuth usage endpoint, using the credentials Claude Code CLI stores
// locally. The token is read, sent to api.anthropic.com only, and never refreshed or stored.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_BACKOFF_MS = 5 * 60 * 1000;

function claudeDir() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
function credentialsFile() { return path.join(claudeDir(), '.credentials.json'); }

// Last known credential state (no secrets) so the UI can say "logged in / expired / keychain".
const cred = { present: false, expiresAt: null, source: null, keychainBlockedUntil: 0, keychainError: null };

function parse(raw) {
  try {
    const c = JSON.parse(raw).claudeAiOauth;
    return c && typeof c.accessToken === 'string' ? c : null;
  } catch { return null; }
}

// macOS keychain lookup runs off the main thread; a denied/timed-out prompt backs off for a while
// instead of re-prompting (and freezing the UI) every poll.
function readKeychain() {
  return new Promise((resolve) => {
    const child = execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', timeout: 90000, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout || '').trim()));
    child.on('error', () => resolve(null));
  });
}

async function readCredentials() {
  const file = credentialsFile();
  if (fs.existsSync(file)) {
    const c = parse(fs.readFileSync(file, 'utf8'));
    Object.assign(cred, { present: !!c, expiresAt: c ? c.expiresAt || null : null, source: 'file' });
    return c;
  }
  if (process.platform !== 'darwin') {
    Object.assign(cred, { present: false, expiresAt: null, source: null });
    return null;
  }
  if (Date.now() < cred.keychainBlockedUntil) return null;
  const raw = await readKeychain();
  if (raw === null) {
    cred.keychainBlockedUntil = Date.now() + KEYCHAIN_BACKOFF_MS;
    cred.keychainError = '키체인 접근이 허용되지 않았습니다';
    Object.assign(cred, { present: false, expiresAt: null, source: null });
    return null;
  }
  cred.keychainError = null;
  const c = parse(raw);
  Object.assign(cred, { present: !!c, expiresAt: c ? c.expiresAt || null : null, source: 'keychain' });
  return c;
}

const credentialState = () => ({ ...cred });

const clamp = (v) => Math.max(0, Math.min(100, v));

// The battery shows whichever limit will block the user first: the lowest remaining share.
function pickMain(windows) {
  return windows.slice().sort((a, b) => (a.remaining - b.remaining) || (a.order - b.order))[0];
}

async function fetchUsage() {
  const c = await readCredentials();
  if (!c) {
    if (cred.keychainError && Date.now() < cred.keychainBlockedUntil) {
      return { ok: false, connected: true, keychain: true, reason: `${cred.keychainError}. 키체인 창에서 "항상 허용"을 누르면 5분 안에 표시됩니다.` };
    }
    return { ok: false, connected: false, setup: true, reason: 'Claude Code CLI 로그인이 필요합니다.' };
  }

  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${c.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'ai-battery/1.1',
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { ok: false, connected: true, reason: `네트워크 오류: ${e.message}` };
  }
  if (res.status === 401 || res.status === 403) {
    const expired = c.expiresAt && c.expiresAt < Date.now();
    return {
      ok: false, connected: true, expired: true,
      reason: expired ? '로그인 토큰이 만료되었습니다. 다시 로그인하면 갱신됩니다.' : '사용량 API가 거부했습니다. 다시 로그인해 보세요.',
    };
  }
  if (res.status === 429) return { ok: false, connected: true, reason: '요청이 너무 잦습니다. 잠시 후 다시 시도합니다.' };
  if (!res.ok) return { ok: false, connected: true, reason: `사용량 API 오류 (${res.status})` };

  let j;
  try { j = await res.json(); } catch { return { ok: false, connected: true, reason: '응답을 해석하지 못했습니다' }; }

  const windows = [];
  const push = (key, label) => {
    const w = j[key];
    if (w && typeof w.utilization === 'number') {
      windows.push({ key, label, order: windows.length, remaining: clamp(100 - w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null });
    }
  };
  push('five_hour', '5시간');
  push('seven_day', '주간');
  push('seven_day_opus', '주간 · Opus');
  push('seven_day_sonnet', '주간 · Sonnet');
  push('seven_day_oauth_apps', '주간 · 앱');
  if (!windows.length) return { ok: false, connected: true, reason: '응답에 사용량 정보가 없습니다' };

  const main = pickMain(windows);
  const plan = c.subscriptionType ? c.subscriptionType.charAt(0).toUpperCase() + c.subscriptionType.slice(1) : null;
  const strip = ({ order, ...w }) => w;
  return { ok: true, connected: true, main: strip(main), extra: windows.filter((w) => w !== main).map(strip), meta: { plan, source: 'api' } };
}

module.exports = { fetchUsage, readCredentials, credentialState, credentialsFile, pickMain };
