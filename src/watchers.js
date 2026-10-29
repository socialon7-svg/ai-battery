'use strict';
// Detects "working" / "finished" for each tool by watching the files they write locally.
//  - Claude Code : ~/.claude/projects/**/*.jsonl   (assistant entry with stop_reason end_turn = turn finished)
//  - Codex       : ~/.codex/sessions/**/rollout-*.jsonl (task_started / task_complete events)
//  - Antigravity : ~/.gemini/antigravity/{conversations,brain} (activity burst, then quiet = finished; heuristic)
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const ATTENTION_MAX_MS = 30 * 60 * 1000;

class Activity extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.status = 'idle'; // idle | working | done
    this.detail = '';
    this.since = Date.now();
    this.lastDoneAt = null;
    this.lastDoneDetail = '';
    // "attention" = the tool is waiting for the user (permission prompt). It is set by a hook and
    // survives the periodic transcript recompute until the transcript actually moves on.
    this.attention = false;
    this.attentionAt = 0;
    this.attentionDetail = '';
    this.attentionBase = '';
  }

  // `at` is the time of the evidence (file mtime). Transcript-driven updates older than the
  // attention mark, or that repeat the same state, do not clear it.
  set(status, detail = '', at = null) {
    if (this.attention) {
      const stale = Date.now() - this.attentionAt > ATTENTION_MAX_MS;
      const movedOn = status !== 'working' || (detail !== this.attentionBase && (at === null || at >= this.attentionAt));
      if (!stale && !movedOn) return;
      this.attention = false;
      this.attentionDetail = '';
    }
    if (status === this.status && detail === this.detail) return;
    const prev = this.status;
    this.status = status;
    this.detail = detail;
    this.since = Date.now();
    this.emit('change', { prev, status });
  }

  markAttention(detail = '허가 대기 중') {
    if (this.attention && this.attentionDetail === detail) return;
    this.attention = true;
    this.attentionAt = Date.now();
    this.attentionBase = this.status === 'working' ? this.detail : '';
    this.attentionDetail = detail;
    const prev = this.status;
    this.status = 'working';
    this.detail = detail;
    this.since = Date.now();
    this.emit('change', { prev, status: 'working' });
  }

  done(info = {}) {
    this.attention = false;
    this.attentionDetail = '';
    this.lastDoneAt = Date.now();
    this.lastDoneDetail = info.detail || '';
    this.set('done', info.detail || '');
    this.emit('done', info);
  }

  snapshot() {
    return {
      status: this.status, detail: this.detail, since: this.since,
      lastDoneAt: this.lastDoneAt, lastDoneDetail: this.lastDoneDetail,
      attention: this.attention, attentionDetail: this.attentionDetail,
    };
  }
}

const home = () => os.homedir();
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
const codexHome = () => process.env.CODEX_HOME || path.join(home(), '.codex');
const antigravityDir = () => path.join(home(), '.gemini', 'antigravity');

async function readTail(file, maxBytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }
    return text;
  } finally { await fh.close(); }
}

async function tailEntries(file, maxBytes) {
  const out = [];
  for (const line of (await readTail(file, maxBytes)).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
    } catch { /* partially written line */ }
  }
  return out;
}

// Recursive directory watcher that survives missing directories and errors.
function watchDir(dir, onChange, log = () => {}) {
  let watcher = null;
  let retry = null;
  let closed = false;
  const start = () => {
    if (closed) return;
    try {
      if (!fs.existsSync(dir)) throw new Error('directory missing');
      watcher = fs.watch(dir, { recursive: true }, (ev, name) => { if (name) onChange(path.join(dir, name.toString()), ev); });
      watcher.on('error', (e) => { log(`watch error on ${dir}: ${e.message}`); restart(); });
      log(`watching ${dir}`);
    } catch (e) {
      watcher = null;
      retry = setTimeout(start, 30000);
    }
  };
  const restart = () => {
    try { if (watcher) watcher.close(); } catch { /* ignore */ }
    watcher = null;
    clearTimeout(retry);
    retry = setTimeout(start, 5000);
  };
  start();
  return { close() { closed = true; clearTimeout(retry); try { if (watcher) watcher.close(); } catch { /* ignore */ } } };
}

function debouncer() {
  const timers = new Map();
  const fn = (key, ms, f) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); f(); }, ms));
  };
  fn.clear = () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  return fn;
}

async function walkRecent(dir, test, withinMs, maxDepth) {
  const out = [];
  const cutoff = Date.now() - withinMs;
  async function walk(d, depth) {
    if (depth > maxDepth) return;
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (test(p)) {
        try { const st = await fsp.stat(p); if (st.mtimeMs >= cutoff) out.push({ file: p, mtime: st.mtimeMs }); } catch { /* skip */ }
      }
    }
  }
  await walk(dir, 0);
  return out;
}

// Generic "turn" watcher: per-file state machine fed by classify(entries, file), which returns
// { status: 'working'|'done'|'maybe-done'|'idle', id, ts, detail, child }.
function createTurnWatcher(opts) {
  const { name, dir, match, classify, activity, log = () => {} } = opts;
  const quietFallbackMs = opts.quietFallbackMs || 6000;
  const STALE_MS = 15 * 60 * 1000;
  const FORGET_MS = 24 * 60 * 60 * 1000;
  const files = new Map();
  const debounce = debouncer();

  function recompute() {
    const now = Date.now();
    let top = null;
    for (const [file, st] of files) {
      if (now - st.mtime > FORGET_MS) { clearTimeout(st.quietTimer); files.delete(file); continue; }
      if (st.status === 'working' && !st.child && now - st.mtime < STALE_MS && (!top || st.mtime > top.mtime)) top = st;
    }
    if (top) activity.set('working', top.detail || '작업 중', top.mtime);
    else if (activity.status === 'working' && !activity.attention) activity.set('idle');
    else if (activity.status === 'working' && activity.attention && now - activity.attentionAt > ATTENTION_MAX_MS) activity.set('idle');
    else if (activity.status === 'done' && activity.lastDoneAt && now - activity.lastDoneAt > 10 * 60 * 1000) activity.set('idle');
  }

  function apply(file, cls, mtime, seeding) {
    const st = files.get(file) || { status: 'unknown', lastDoneId: null, detail: '', child: false, quietTimer: null, mtime: 0 };
    clearTimeout(st.quietTimer);
    st.quietTimer = null;
    st.mtime = mtime;
    st.detail = cls.detail || '';
    st.child = !!cls.child;
    let fire = false;
    if (cls.status === 'done') {
      const fresh = cls.ts && Date.now() - cls.ts < 30000;
      fire = !seeding && !cls.child && st.lastDoneId !== cls.id && (st.status === 'working' || (st.status === 'unknown' && fresh));
      st.lastDoneId = cls.id;
      st.status = 'done';
    } else if (cls.status === 'maybe-done') {
      // No stop_reason yet: either still streaming or an older format. Re-check after a quiet period.
      st.status = 'working';
      if (!seeding) st.quietTimer = setTimeout(() => evaluate(file, false, cls.id), quietFallbackMs);
    } else {
      st.status = cls.status; // working | idle
    }
    files.set(file, st);
    if (fire) {
      log(`${name}: turn finished (${path.basename(file)})`);
      activity.done({ detail: cls.detail || '', source: 'transcript', file });
    }
    recompute();
  }

  async function evaluate(file, seeding, confirmId) {
    let entries, mtime, cls;
    try {
      entries = await tailEntries(file, 192 * 1024);
      mtime = (await fsp.stat(file)).mtimeMs;
      cls = classify(entries, file);
    } catch (e) { log(`${name}: could not read ${path.basename(file)}: ${e.message}`); return; }
    if (!cls) return;
    if (confirmId !== undefined && cls.status === 'maybe-done' && cls.id === confirmId) cls.status = 'done';
    apply(file, cls, mtime, seeding);
  }

  const watcher = watchDir(dir, (file) => { if (match(file)) debounce(file, 700, () => evaluate(file, false)); }, log);
  // Seed from files touched in the last 10 minutes so the first change after startup isn't misread.
  walkRecent(dir, match, 10 * 60 * 1000, 6).then((list) => list.forEach(({ file }) => evaluate(file, true))).catch(() => {});
  const iv = setInterval(recompute, 20000);
  return {
    close() {
      watcher.close();
      clearInterval(iv);
      debounce.clear();
      for (const st of files.values()) clearTimeout(st.quietTimer);
    },
  };
}

// ---------- Claude Code ----------
const CLAUDE_LOCAL = /<command-name>|<local-command-stdout>|<local-command-caveat>|<command-message>|<bash-input>|<bash-stdout>|<bash-stderr>/;

function classifyClaude(entries, file) {
  const child = /[\\/]subagents[\\/]/i.test(file || '');
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (e.type === 'assistant') {
      const m = e.message || {};
      const blocks = Array.isArray(m.content) ? m.content : [];
      const id = m.id || e.uuid || String(i);
      if (m.stop_reason === 'tool_use' || blocks.some((b) => b && b.type === 'tool_use')) return { status: 'working', detail: '도구 실행 중', id, ts, child };
      if (m.stop_reason) return { status: 'done', id, ts, child };
      if (e.isApiErrorMessage) return { status: 'done', id, ts, child, detail: 'API 오류로 중단' };
      return { status: 'maybe-done', id, ts, child };
    }
    if (e.type === 'user') {
      if (e.isMeta) continue;
      const c = e.message && e.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('') : '';
      if (CLAUDE_LOCAL.test(text)) continue;
      if (/\[Request interrupted by user/.test(text)) return { status: 'idle', ts, child };
      const hasResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
      return { status: 'working', detail: hasResult ? '생각 중' : '응답 생성 중', ts, child };
    }
    if (e.type === 'api-request') return { status: 'working', detail: '응답 생성 중', ts, child };
  }
  return null;
}

function createClaudeWatcher(activity, opts = {}) {
  return createTurnWatcher({
    name: 'claude',
    dir: path.join(claudeDir(), 'projects'),
    match: (f) => /\.jsonl$/i.test(f),
    classify: classifyClaude,
    activity,
    log: opts.log,
  });
}

// ---------- Codex ----------
function classifyCodex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'event_msg') continue;
    const p = e.payload || {};
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    switch (p.type) {
      case 'task_complete':
        return {
          status: 'done',
          id: p.turn_id || String(i),
          child: !!(p.root_turn_id && p.turn_id && p.root_turn_id !== p.turn_id),
          detail: String(p.last_agent_message || '').trim().split('\n')[0].slice(0, 100),
          ts,
        };
      case 'task_started': {
        const a = p.turn_attribution || {};
        return { status: 'working', detail: '작업 중', child: !!a.parent_turn_id, ts };
      }
      case 'turn_aborted':
        return { status: 'idle', ts };
      case 'user_message':
        return { status: 'working', detail: '응답 생성 중', ts };
      default:
        continue;
    }
  }
  return null;
}

function createCodexWatcher(activity, opts = {}) {
  return createTurnWatcher({
    name: 'codex',
    dir: path.join(codexHome(), 'sessions'),
    match: (f) => /rollout-.*\.jsonl$/i.test(f),
    classify: classifyCodex,
    activity,
    log: opts.log,
  });
}

// ---------- Antigravity (heuristic) ----------
function createAntigravityWatcher(activity, opts = {}) {
  const log = opts.log || (() => {});
  const quietSeconds = typeof opts.quietSeconds === 'function' ? opts.quietSeconds : () => 20;
  const INTERESTING = /[\\/](conversations|brain)[\\/]/i;
  let last = 0, burstStart = 0, writes = 0, timer = null;

  function check() {
    const now = Date.now();
    const quiet = quietSeconds() * 1000;
    if (now - last < quiet) { timer = setTimeout(check, quiet - (now - last)); return; }
    const duration = last - burstStart;
    if (duration >= 4000 && writes >= 3) {
      log(`antigravity: quiet after ${Math.round(duration / 1000)}s of activity`);
      activity.done({ detail: '', source: 'heuristic' });
    } else {
      activity.set('idle');
    }
    burstStart = 0;
    writes = 0;
  }

  const watcher = watchDir(antigravityDir(), (file) => {
    if (!INTERESTING.test(file)) return;
    const now = Date.now();
    if (!burstStart) burstStart = now;
    last = now;
    writes++;
    activity.set('working', '에이전트 작업 중 (추정)', now);
    clearTimeout(timer);
    timer = setTimeout(check, quietSeconds() * 1000);
  }, log);

  const iv = setInterval(() => {
    if (activity.status === 'done' && activity.lastDoneAt && Date.now() - activity.lastDoneAt > 10 * 60 * 1000) activity.set('idle');
  }, 30000);

  return { close() { watcher.close(); clearInterval(iv); clearTimeout(timer); } };
}

module.exports = { Activity, createClaudeWatcher, createCodexWatcher, createAntigravityWatcher, classifyClaude, classifyCodex, tailEntries };
