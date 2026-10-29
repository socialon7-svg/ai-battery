'use strict';
// ChatGPT (Codex CLI / Codex app) usage. Primary: ChatGPT usage endpoint with the Codex login token.
// Fallback: the most recent `token_count` event recorded in ~/.codex/sessions rollouts.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function authFile() { return path.join(codexHome(), 'auth.json'); }

function readAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    return j.tokens && typeof j.tokens.access_token === 'string' ? j.tokens : null;
  } catch { return null; }
}

const clamp = (v) => Math.max(0, Math.min(100, v));

function labelForMinutes(m) {
  if (!m || m <= 0) return '한도';
  if (m === 300) return '5시간';
  if (m === 10080) return '주간';
  if (m === 1440) return '일간';
  if (m % 1440 === 0) return `${m / 1440}일`;
  if (m % 60 === 0) return `${m / 60}시간`;
  return `${m}분`;
}

function planLabel(p) {
  if (!p) return null;
  const map = { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
  return map[p] || p;
}

// Main battery = the limit that blocks first (lowest remaining); ties go to the shorter window.
function pickMain(windows) {
  return windows.slice().sort((a, b) => (a.remaining - b.remaining) || ((a.minutes || 1e9) - (b.minutes || 1e9)))[0];
}

function pack(windows, meta) {
  const main = pickMain(windows);
  return { ok: true, connected: true, main, extra: windows.filter((w) => w !== main), meta };
}

function normalizeApi(j) {
  const rl = j && j.rate_limit;
  if (!rl) return null;
  const windows = [];
  const push = (w) => {
    if (w && typeof w.used_percent === 'number') {
      const mins = w.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : 0;
      const resetsAt = w.reset_at ? w.reset_at * 1000 : (w.reset_after_seconds ? Date.now() + w.reset_after_seconds * 1000 : null);
      windows.push({ label: labelForMinutes(mins), minutes: mins, remaining: clamp(100 - w.used_percent), resetsAt });
    }
  };
  push(rl.primary_window);
  push(rl.secondary_window);
  if (!windows.length) return null;
  return pack(windows, { plan: planLabel(j.plan_type), source: 'api', limitReached: !!rl.limit_reached });
}

async function newestRollouts(limit) {
  const root = path.join(codexHome(), 'sessions');
  const out = [];
  const dirsDesc = async (d) => {
    try { return (await fsp.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse(); }
    catch { return []; }
  };
  let days = 0;
  outer:
  for (const y of (await dirsDesc(root)).slice(0, 2)) {
    for (const m of (await dirsDesc(path.join(root, y))).slice(0, 3)) {
      for (const d of (await dirsDesc(path.join(root, y, m))).slice(0, 7)) {
        const day = path.join(root, y, m, d);
        let names = [];
        try { names = (await fsp.readdir(day)).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl')); } catch { /* skip */ }
        for (const n of names) {
          const f = path.join(day, n);
          try { out.push({ file: f, mtime: (await fsp.stat(f)).mtimeMs }); } catch { /* skip */ }
        }
        if (++days >= 3 && out.length >= limit) break outer;
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

async function readTail(file, maxBytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}

// Pure: turns the newest rate_limits snapshot (with its timestamp) into a usage result.
function normalizeRollout(rl, ts, now = Date.now()) {
  const windows = [];
  const push = (w) => {
    if (w && typeof w.used_percent === 'number') {
      const mins = w.window_minutes || 0;
      let resetsAt = w.resets_at ? w.resets_at * 1000 : (w.resets_in_seconds ? ts + w.resets_in_seconds * 1000 : null);
      let remaining = clamp(100 - w.used_percent);
      let reset = false;
      if (resetsAt && resetsAt < now) { remaining = 100; reset = true; resetsAt = null; }
      windows.push({ label: labelForMinutes(mins), minutes: mins, remaining, resetsAt, reset });
    }
  };
  push(rl.primary);
  push(rl.secondary);
  if (!windows.length) return null;
  return pack(windows, { plan: planLabel(rl.plan_type), source: 'rollout', stale: true, asOf: ts });
}

async function fromRollouts() {
  let best = null;
  for (const { file } of await newestRollouts(3)) {
    let text;
    try { text = await readTail(file, 512 * 1024); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"') || !lines[i].includes('"rate_limits"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        const rl = e.payload && e.payload.rate_limits;
        if (!rl) continue;
        const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
        if (!best || ts > best.ts) best = { ts, rl };
      } catch { /* partial line */ }
      break;
    }
  }
  return best ? normalizeRollout(best.rl, best.ts) : null;
}

async function fetchUsage() {
  const auth = readAuth();
  if (!auth) return { ok: false, connected: false, setup: true, reason: 'Codex CLI 또는 Codex 앱에 ChatGPT 계정으로 로그인하면 표시됩니다.' };
  let apiErr = null;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        'ChatGPT-Account-Id': auth.account_id || '',
        'User-Agent': 'ai-battery/1.1',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const n = normalizeApi(await res.json());
      if (n) return n;
      apiErr = '응답 형식 불명';
    } else {
      apiErr = res.status === 401 ? '토큰 만료' : `API ${res.status}`;
    }
  } catch (e) { apiErr = e.message; }
  const fb = await fromRollouts();
  if (fb) { fb.meta.note = `실시간 조회 실패 (${apiErr})`; return fb; }
  return {
    ok: false, connected: true, expired: apiErr === '토큰 만료',
    reason: `사용량을 가져오지 못했습니다 (${apiErr}). 터미널에서 codex 를 한 번 실행하면 토큰이 갱신됩니다.`,
  };
}

module.exports = { fetchUsage, normalizeApi, normalizeRollout, pickMain, authFile, labelForMinutes };
