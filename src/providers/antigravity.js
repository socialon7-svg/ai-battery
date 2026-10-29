'use strict';
// Antigravity usage: asks the IDE's local language server (same call the IDE itself makes)
// for per-model quota. Requires Antigravity to be running.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');

const PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const BODY = JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } });
const NOT_RUNNING_BACKOFF_MS = 3 * 60 * 1000;

const installDir = () => path.join(os.homedir(), '.gemini', 'antigravity');
const installed = () => { try { return fs.existsSync(installDir()); } catch { return false; } };

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 10000 },
    (err, stdout) => resolve(stdout || ''));
});

async function findProcesses() {
  if (process.platform === 'win32') {
    // Fast pre-check so we don't spawn PowerShell when nothing is running.
    const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
    if (!/"language_server/i.test(tl)) return [];
    const ps = "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%'\" | ForEach-Object { $_.ProcessId.ToString() + ' :: ' + $_.CommandLine }";
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes(' :: ')).map((l) => {
      const i = l.indexOf(' :: ');
      return { pid: l.slice(0, i), cmd: l.slice(i + 4) };
    });
  }
  const out = await run('ps', ['-axo', 'pid=,command=']);
  return out.split('\n').map((l) => l.trim()).filter((l) => /language_server/.test(l)).map((l) => {
    const m = /^(\d+)\s+(.*)$/.exec(l);
    return m ? { pid: m[1], cmd: m[2] } : null;
  }).filter(Boolean);
}

async function listeningPorts(pid) {
  const ports = new Set();
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'tcp']);
    for (const line of out.split(/\r?\n/)) {
      const c = line.trim().split(/\s+/);
      if (c.length >= 5 && /LISTEN/i.test(c[3]) && c[4] === pid) ports.add(Number(c[1].split(':').pop()));
    }
  } else {
    const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid]);
    for (const line of out.split('\n')) {
      const m = /:(\d+)\s+\(LISTEN\)/.exec(line);
      if (m) ports.add(Number(m[1]));
    }
  }
  return [...ports].filter((p) => p > 0).sort((a, b) => a - b);
}

function parseCsrf(cmd) {
  const m = /--csrf_token(?:=|\s+)(\S+)/.exec(cmd);
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

async function discover() {
  const procs = (await findProcesses()).filter((p) => /antigravity/i.test(p.cmd));
  for (const p of procs) {
    const token = parseCsrf(p.cmd);
    if (!token) continue;
    const ports = await listeningPorts(p.pid);
    if (ports.length) return { pid: p.pid, token, ports };
  }
  return null;
}

function post(proto, port, token) {
  return new Promise((resolve) => {
    const mod = proto === 'https' ? https : http;
    const req = mod.request({
      host: '127.0.0.1', port, path: PATH, method: 'POST', rejectUnauthorized: false, timeout: 4000,
      headers: { 'Content-Type': 'application/json', 'X-Codeium-Csrf-Token': token, 'Content-Length': Buffer.byteLength(BODY) },
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', (e) => resolve({ err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }); });
    req.end(BODY);
  });
}

let cache = null; // { port, proto, token }
let notRunningUntil = 0;

// `active` = the file watcher just saw Antigravity write something, so skip the backoff.
async function getUserStatus({ active } = {}) {
  if (cache) {
    const r = await post(cache.proto, cache.port, cache.token);
    if (r.status === 200) return JSON.parse(r.body);
    cache = null;
  }
  if (!active && Date.now() < notRunningUntil) return null;
  const d = await discover();
  if (!d) { notRunningUntil = Date.now() + NOT_RUNNING_BACKOFF_MS; return null; }
  notRunningUntil = 0;
  for (const port of d.ports) {
    for (const proto of ['https', 'http']) {
      const r = await post(proto, port, d.token);
      if (r.status === 200) {
        cache = { port, proto, token: d.token };
        return JSON.parse(r.body);
      }
    }
  }
  throw new Error('Antigravity 언어 서버를 찾았지만 응답이 없습니다');
}

const clamp = (v) => Math.max(0, Math.min(100, v));
// "Gemini 3 Pro (High)" -> "Gemini 3 Pro": models in one family share a quota pool.
function familyOf(label) { return String(label).replace(/\s*\([^)]*\)\s*$/, '').trim(); }

function normalize(j) {
  const us = (j && j.userStatus) || {};
  const cfgs = (us.cascadeModelConfigData && us.cascadeModelConfigData.clientModelConfigs) || [];
  const fam = new Map();
  cfgs.forEach((m, i) => {
    const q = m && m.quotaInfo;
    if (!q || (q.remainingFraction === undefined && !q.resetTime)) return;
    // proto3 JSON omits zero values, so a missing remainingFraction next to a resetTime means "used up".
    const remaining = clamp(100 * (q.remainingFraction === undefined ? 0 : Number(q.remainingFraction)));
    const resetsAt = q.resetTime ? Date.parse(q.resetTime) : null;
    const name = familyOf(m.label || m.modelId || `모델 ${i + 1}`);
    const cur = fam.get(name);
    if (!cur) fam.set(name, { label: name, remaining, resetsAt, order: i, recommended: !!m.isRecommended });
    else if (remaining < cur.remaining) { cur.remaining = remaining; cur.resetsAt = resetsAt; }
  });
  // The server's model order is not stable between calls, so sort by name for a steady list,
  // and pick the most-used pool (ties: recommended model first, then name) as the main battery.
  const list = [...fam.values()].sort((a, b) => a.label.localeCompare(b.label));
  if (!list.length) return null;
  const main = list.slice().sort((a, b) =>
    (a.remaining - b.remaining) || ((b.recommended ? 1 : 0) - (a.recommended ? 1 : 0)) || a.label.localeCompare(b.label))[0];
  const plan = (us.userTier && us.userTier.name) || (us.planStatus && us.planStatus.planInfo && us.planStatus.planInfo.planName) || null;
  return {
    ok: true,
    connected: true,
    main: { label: main.label, remaining: main.remaining, resetsAt: main.resetsAt },
    extra: list.filter((x) => x !== main).map((x) => ({ label: x.label, remaining: x.remaining, resetsAt: x.resetsAt })),
    meta: { plan, source: 'language-server', models: cfgs.length },
  };
}

async function fetchUsage(opts = {}) {
  if (!installed()) return { ok: false, connected: false, notInstalled: true, reason: 'Antigravity가 설치되어 있지 않습니다.' };
  try {
    const j = await getUserStatus(opts);
    if (!j) return { ok: false, connected: false, notRunning: true, reason: 'Antigravity가 실행 중이 아닙니다. 실행하면 자동으로 표시됩니다.' };
    const n = normalize(j);
    if (!n) return { ok: false, connected: true, reason: '응답에 쿼터 정보가 없습니다' };
    return n;
  } catch (e) {
    return { ok: false, connected: true, reason: e.message };
  }
}

module.exports = { fetchUsage, normalize, familyOf, installed };
