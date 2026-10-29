(() => {
  'use strict';
  const PROVIDERS = [
    { id: 'claude', name: 'Claude', full: 'Claude Code' },
    { id: 'codex', name: 'ChatGPT', full: 'ChatGPT · Codex' },
    { id: 'antigravity', name: 'Antigravity', full: 'Antigravity' },
  ];
  const $ = (s) => document.querySelector(s);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  // Without the preload bridge there is nothing real to show. The mock exists only for the
  // browser preview (test/serve-ui.js), never inside Electron.
  const api = window.api || (location.protocol === 'http:' ? mockApi() : null);
  if (!api) {
    document.body.innerHTML = '<div class="fatal">내부 오류: preload를 불러오지 못했습니다. 앱을 다시 설치해 주세요.</div>';
    return;
  }

  let state = null;
  let open = null;          // provider whose detail row is expanded
  let settingsOpen = false;
  const busy = new Set();   // "hook:claude:install" etc. while a request is running
  const lastHtml = new Map();

  function lvl(r) {
    if (r == null || Number.isNaN(r)) return 'unknown';
    if (r <= 20) return 'low';
    if (r <= 50) return 'warn';
    return 'ok';
  }
  function fmtDur(ms) {
    if (ms <= 0) return '곧';
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    if (d > 0) return `${d}일 ${h}시간`;
    if (h > 0) return `${h}시간 ${m}분`;
    return `${Math.max(1, m)}분`;
  }
  const fmtReset = (at) => (at ? `${fmtDur(at - Date.now())} 후 리셋` : '');
  function fmtAgo(at) {
    const s = Math.round((Date.now() - at) / 1000);
    if (s < 60) return '방금';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    return `${Math.floor(s / 3600)}시간 전`;
  }
  function fmtTime(at) {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const isAttention = (a) => !!(a && a.attention);
  function actText(a) {
    if (!a) return '대기';
    if (isAttention(a)) return a.attentionDetail || '허가 대기';
    if (a.status === 'working') return a.detail || '작업 중';
    if (a.status === 'done') return `완료 · ${fmtAgo(a.lastDoneAt || a.since)}`;
    return '대기';
  }

  // "Connected" = we have a credential / a live process for the tool, even if the API call failed.
  const usage = (id) => (state && state.usage ? state.usage[id] : null);
  const isConnected = (id) => { const u = usage(id); return !!(u && (u.ok || u.connected)); };
  const loaded = () => !!(state && state.usage && PROVIDERS.every((p) => state.usage[p.id]));

  const setHtml = (sel, html) => {
    if (lastHtml.get(sel) === html) return;
    lastHtml.set(sel, html);
    $(sel).innerHTML = html;
  };

  function markText(u) {
    if (u.expired) return '만료';
    if (u.keychain) return '키체인';
    return '?';
  }

  function rowHtml(p) {
    const u = usage(p.id);
    const a = (state.activity && state.activity[p.id]) || {};
    const ok = !!(u && u.ok);
    const r = ok ? Math.round(u.main.remaining) : null;
    const justDone = a.status === 'done' && a.lastDoneAt && Date.now() - a.lastDoneAt < 60000;
    const cls = ['row', `lvl-${lvl(ok ? u.main.remaining : null)}`,
      a.status === 'working' ? 'working' : '', a.status === 'done' ? 'done' : '',
      justDone ? 'just-done' : '', isAttention(a) ? 'attention' : '', open === p.id ? 'open' : ''].filter(Boolean).join(' ');
    const tip = ok
      ? `${p.full} · ${u.main.label} ${r}% 남음 · ${fmtReset(u.main.resetsAt)} · ${actText(a)}`
      : `${p.full} · ${u ? u.reason : '불러오는 중…'}`;
    const bat = ok
      ? `<div class="bat"><div class="fill" style="width:${r}%"></div></div>`
      : `<div class="bat unknown"><div class="mark">${markText(u)}</div></div>`;
    return `<div class="${cls}" data-id="${p.id}" title="${esc(tip)}">
      <i class="st"></i><span class="name">${esc(p.name)}</span>${bat}<b class="pct">${ok ? `${r}%` : '–'}</b></div>${open === p.id ? detailHtml(p, u, a) : ''}`;
  }

  function detailHtml(p, u, a) {
    const out = [];
    const act = isAttention(a) ? (a.attentionDetail || '허가 대기 중')
      : a.status === 'working' ? `작업 중${a.detail ? ' · ' + a.detail : ''}`
        : a.status === 'done' ? `완료 · ${fmtAgo(a.lastDoneAt || a.since)}${a.lastDoneDetail ? ' · ' + a.lastDoneDetail : ''}` : '대기 중';
    const plan = u && u.ok && u.meta && u.meta.plan ? `<span class="muted">${esc(u.meta.plan)}</span>` : '';
    out.push(`<div class="l act"><span>${esc(act)}</span>${plan}</div>`);
    if (u && u.ok) {
      const label = p.id === 'antigravity' ? `${u.main.label} · 가장 많이 쓴 모델` : `${u.main.label} 한도`;
      const why = u.extra && u.extra.length ? '남은 비율이 가장 적은 한도를 배터리로 보여줍니다' : '';
      out.push(`<div class="l" title="${esc(why)}"><span>${esc(label)}</span><b>${esc(fmtReset(u.main.resetsAt))}</b></div>`);
      if (u.meta && u.meta.stale) out.push(`<div class="warn">${fmtTime(u.meta.asOf)} 기록 기준 · ${esc(u.meta.note || '')}</div>`);
      if (u.extra && u.extra.length) {
        out.push(`<ul class="extra">${u.extra.map((x) => `<li class="lvl-${lvl(x.remaining)}" title="${esc(fmtReset(x.resetsAt))}"><span>${esc(x.label)}</span><div class="mini"><i style="width:${Math.round(x.remaining)}%"></i></div><b>${Math.round(x.remaining)}%</b></li>`).join('')}</ul>`);
      }
    } else {
      out.push(`<div>${esc(u ? u.reason : '불러오는 중…')}</div>`);
      if (u && (u.expired || u.setup) && (p.id === 'claude' || p.id === 'codex')) {
        out.push(`<div class="actions">${cliButton(p.id, 'login', '다시 로그인')}</div>`);
      }
    }
    return `<div class="detail" data-id="${p.id}">${out.join('')}</div>`;
  }

  const key = (kind, tool, action) => `${kind}:${tool}:${action}`;
  const actButton = (kind, tool, action, label, primary) =>
    `<button class="btn act ${primary ? 'primary' : ''}" data-kind="${kind}" data-tool="${tool}" data-action="${action}" ${busy.has(key(kind, tool, action)) ? 'disabled' : ''}>${busy.has(key(kind, tool, action)) ? '…' : esc(label)}</button>`;
  const cliButton = (tool, action, label, primary) => actButton('cli', tool, action, label, primary);
  const hookButton = (tool, action, label) => actButton('hook', tool, action, label);

  function gamepads() {
    try { return Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter((g) => g && g.vibrationActuator); } catch { return []; }
  }

  // Settings → 연동: one line per tool with its state and the single next action.
  function linksHtml() {
    const hk = state.hooks || {};
    const cl = state.cli || {};
    const rows = [];

    { // Claude Code
      const u = usage('claude') || {};
      const h = hk.claude || {};
      const c = cl.claude || {};
      let s; const b = [];
      if (h.error) { s = '<span class="warn">settings.json 오류</span> 훅 설정 불가'; }
      else if (isConnected('claude')) {
        const hookS = h.installed ? '훅 ✓' : h.stale ? '훅 갱신 필요' : '훅 없음 · 기록 감시만';
        s = `<span class="ok">연결됨 ✓</span> ${hookS}`;
        b.push(h.installed ? hookButton('claude', 'uninstall', '훅 해제') : hookButton('claude', 'install', '훅 연결'));
        if (u.expired) b.unshift(cliButton('claude', 'login', '로그인', true));
      } else if (c.cli) { s = '<span class="warn">로그인 필요</span> CLI 있음'; b.push(cliButton('claude', 'login', '로그인', true)); }
      else { s = '<span class="muted">CLI 없음</span> 설치하면 연결됩니다'; b.push(cliButton('claude', 'install', '설치 + 로그인', true)); }
      rows.push(['Claude Code', s, b]);
    }
    { // Codex
      const u = usage('codex') || {};
      const x = hk.codex || {};
      const c = cl.codex || {};
      let s; const b = [];
      if (isConnected('codex')) {
        const n = x.installed ? '알림 ✓' : x.foreign ? '기록 감시 · notify는 다른 앱' : x.error ? '설정 파일 오류' : '기록 감시';
        s = `<span class="ok">연결됨 ✓</span> ${n}`;
        if (!x.foreign && !x.error) b.push(x.installed ? hookButton('codex', 'uninstall', '알림 해제') : hookButton('codex', 'install', '알림 연결'));
        if (u.expired) b.unshift(cliButton('codex', 'login', '로그인', true));
      } else if (c.cli) { s = '<span class="warn">로그인 필요</span> CLI 있음'; b.push(cliButton('codex', 'login', '로그인', true)); }
      else if (c.canInstall) { s = '<span class="muted">CLI 없음</span> 설치하면 연결됩니다'; b.push(cliButton('codex', 'install', '설치 + 로그인', true)); }
      else { s = '<span class="muted">CLI 없음</span> Codex 앱 로그인도 인식됩니다'; b.push(cliButton('codex', 'install', '설치 안내')); }
      rows.push(['Codex', s, b]);
    }
    { // Antigravity
      const u = usage('antigravity') || {};
      const s = u.ok ? '<span class="ok">연결됨 ✓</span>' : u.notInstalled ? '<span class="muted">설치 안 됨</span>'
        : u.notRunning ? '<span class="muted">꺼짐</span> 실행하면 자동 표시' : u.connected ? '<span class="warn">응답 없음</span>' : '<span class="muted">확인 중</span>';
      rows.push(['Antigravity', s, []]);
    }
    {
      const pads = gamepads().length;
      const ss = state.haptics && state.haptics.steelseries;
      rows.push(['진동 장치', `${pads ? `<span class="ok">게임패드 ${pads}개</span>` : '게임패드 없음'} · ${ss ? '<span class="ok">SteelSeries ✓</span>' : 'SteelSeries 없음'}`, []]);
    }
    return rows.map(([n, s, b]) => `<div class="link"><span class="n">${n}</span><span class="s">${s}</span><span class="b">${b.join('')}</span></div>`).join('');
  }

  function emptyHtml() {
    if (!loaded()) return '<div class="empty">불러오는 중…</div>';
    return '<div class="empty"><b>연결된 도구가 없습니다</b><span>Claude Code · Codex 는 CLI 로그인, Antigravity 는 실행 중일 때 표시됩니다.</span><button class="btn primary" id="btn-connect">연동 설정 열기</button></div>';
  }

  function setSelect(sel, value) {
    const el = $(sel);
    const v = String(value);
    if (![...el.options].some((o) => o.value === v)) {
      const o = document.createElement('option');
      o.value = v; o.textContent = `${v}초`;
      el.appendChild(o);
    }
    el.value = v;
  }

  function render() {
    if (!state) return;
    const visible = PROVIDERS.filter((p) => isConnected(p.id));
    setHtml('#rows', visible.length ? visible.map(rowHtml).join('') : emptyHtml());
    $('#rows').hidden = settingsOpen;
    $('#settings').hidden = !settingsOpen;
    if (settingsOpen) {
      const s = state.settings || {};
      $('#s-sound').checked = !!s.sound;
      $('#s-vibrate').checked = !!s.vibrate;
      $('#s-top').checked = !!s.alwaysOnTop;
      $('#s-openatlogin').checked = !!s.openAtLogin;
      $('#s-autohook').checked = s.autoHook !== false;
      $('#s-autologin').checked = s.autoLogin !== false;
      setSelect('#s-poll', s.pollSeconds || 60);
      setSelect('#s-quiet', s.quietSeconds || 20);
      setHtml('#alert-chips', PROVIDERS.map((p) => `<button class="chip ${!(s.alerts && s.alerts[p.id] === false) ? 'on' : ''}" data-id="${p.id}">${esc(p.name)}</button>`).join(''));
      setHtml('#links', linksHtml());
    }
    $('#foot-left').textContent = state.serverError ? `수신 서버 오류: ${state.serverError}`
      : state.refreshing ? '갱신 중…' : state.lastRefresh ? `갱신 ${fmtTime(state.lastRefresh)}` : '불러오는 중…';
    $('#btn-refresh').classList.toggle('spin', !!state.refreshing);
    $('#btn-settings').classList.toggle('on', settingsOpen);
    fit();
  }

  // The window follows the content height (main process resizes it).
  function fit() {
    requestAnimationFrame(() => api.resize(Math.ceil($('#app').getBoundingClientRect().height)));
  }

  // Soft chime synthesised with Web Audio (no sound files needed).
  function chime(kind) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = ctx.currentTime + 0.02;
      const notes = kind === 'attention' ? [[880, 0], [880, 0.2], [880, 0.4]] : [[784, 0], [1046.5, 0.15], [1318.5, 0.3]];
      for (const [f, dt] of notes) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.3, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.6);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + dt);
        o.stop(t0 + dt + 0.65);
      }
      setTimeout(() => ctx.close(), 2000);
    } catch { /* no audio device */ }
  }

  // Rumble on anything the Gamepad API exposes with a vibration actuator (controllers, some haptic mice).
  async function rumble(kind) {
    const pulses = kind === 'attention' ? [160, 160, 160] : [420];
    for (const gp of gamepads()) {
      try {
        for (let i = 0; i < pulses.length; i++) {
          await gp.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration: pulses[i], strongMagnitude: 1, weakMagnitude: 0.7 });
          if (i < pulses.length - 1) await new Promise((r) => setTimeout(r, 120));
        }
      } catch { /* device gone */ }
    }
  }

  // ---- wiring ----
  const setS = (patch) => api.setSettings(patch).then((st) => { if (st) { state.settings = st; render(); } });
  $('#btn-refresh').addEventListener('click', () => api.refresh());
  $('#btn-settings').addEventListener('click', () => { settingsOpen = !settingsOpen; render(); });
  $('#btn-close-settings').addEventListener('click', () => { settingsOpen = false; render(); });
  $('#btn-hide').addEventListener('click', () => api.hide());
  $('#btn-pos').addEventListener('click', () => api.resetPosition());
  $('#btn-logs').addEventListener('click', () => api.openLogs());
  $('#btn-test').addEventListener('click', () => api.testAlert());
  $('#s-sound').addEventListener('change', (e) => setS({ sound: e.target.checked }));
  $('#s-vibrate').addEventListener('change', (e) => setS({ vibrate: e.target.checked }));
  $('#s-top').addEventListener('change', (e) => setS({ alwaysOnTop: e.target.checked }));
  $('#s-openatlogin').addEventListener('change', (e) => setS({ openAtLogin: e.target.checked }));
  $('#s-autohook').addEventListener('change', (e) => setS({ autoHook: e.target.checked }));
  $('#s-autologin').addEventListener('change', (e) => setS({ autoLogin: e.target.checked }));
  $('#s-poll').addEventListener('change', (e) => setS({ pollSeconds: Number(e.target.value) }));
  $('#s-quiet').addEventListener('change', (e) => setS({ quietSeconds: Number(e.target.value) }));

  async function runAction(btn) {
    const { kind, tool, action } = btn.dataset;
    const k = key(kind, tool, action);
    if (busy.has(k)) return;
    busy.add(k);
    render();
    try {
      if (kind === 'hook') {
        const r = await api.hooks(tool, action);
        if (r && !r.ok) api.showError(`연결 설정 실패: ${r.error}`);
        if (r && r.hooks) state.hooks = r.hooks;
      } else if (kind === 'cli') {
        const r = await api.cli(tool, action);
        if (r && r.message && !r.ok) api.showError(r.message);
      }
    } finally {
      busy.delete(k);
      render();
    }
  }

  document.addEventListener('click', async (e) => {
    const act = e.target.closest('.act');
    if (act) return runAction(act);
    if (e.target.closest('#btn-connect')) { settingsOpen = true; return render(); }
    const chip = e.target.closest('.chip');
    if (chip) {
      const s = state.settings || {};
      const on = !(s.alerts && s.alerts[chip.dataset.id] === false);
      return setS({ alerts: { [chip.dataset.id]: !on } });
    }
    const row = e.target.closest('.row');
    if (row) { open = open === row.dataset.id ? null : row.dataset.id; render(); }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (settingsOpen) { settingsOpen = false; render(); } else if (open) { open = null; render(); }
  });
  // Dropping a link or file on the widget must never navigate it anywhere.
  for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.preventDefault());

  window.addEventListener('gamepadconnected', () => { if (settingsOpen) render(); });
  window.addEventListener('gamepaddisconnected', () => { if (settingsOpen) render(); });

  api.onState((s) => { state = s; render(); });
  api.onAlert((info) => {
    const s = (state && state.settings) || {};
    const kind = (info && info.kind) || 'done';
    if (s.sound !== false) chime(kind);
    if (s.vibrate !== false) rumble(kind);
  });
  api.getState().then((s) => { state = s; render(); });
  setInterval(render, 15000); // keeps "N분 전" / reset countdowns fresh (DOM is only touched when the text changes)

  // Browser preview without Electron: fake data so the UI can be designed and tested on its own.
  function mockApi() {
    const now = Date.now();
    const mock = {
      usage: {
        claude: { ok: true, connected: true, main: { label: '주간 · Opus', remaining: 12, resetsAt: now + 3.2 * 864e5 }, extra: [{ label: '5시간', remaining: 73, resetsAt: now + 72 * 60000 }, { label: '주간', remaining: 41, resetsAt: now + 3.2 * 864e5 }], meta: { plan: 'Max' } },
        codex: { ok: false, connected: false, setup: true, reason: 'Codex 로그인 필요' },
        antigravity: { ok: true, connected: true, main: { label: 'Claude Opus 5.5', remaining: 35, resetsAt: now + 3 * 36e5 }, extra: [{ label: 'Gemini 4 Argon', remaining: 100, resetsAt: now + 5 * 864e5 }], meta: { plan: 'Google AI Pro' } },
      },
      activity: {
        claude: { status: 'working', detail: '도구 실행 중', since: now - 30000, attention: true, attentionDetail: '허가 대기 중' },
        codex: { status: 'idle', since: now },
        antigravity: { status: 'done', lastDoneAt: now - 120000, since: now - 120000, lastDoneDetail: '' },
      },
      settings: { sound: true, vibrate: true, alwaysOnTop: true, autoHook: true, autoLogin: true, openAtLogin: false, pollSeconds: 60, quietSeconds: 20, alerts: { claude: true, codex: true, antigravity: true } },
      hooks: { claude: { installed: true }, codex: { installed: false, foreign: true } },
      cli: { claude: { cli: 'claude' }, codex: { cli: null, canInstall: true } },
      haptics: { steelseries: false },
      lastRefresh: now, refreshing: false, port: 47831, platform: 'win32', serverError: null,
    };
    let cb = () => {};
    return {
      getState: async () => mock,
      refresh: async () => { mock.refreshing = true; cb(mock); setTimeout(() => { mock.refreshing = false; mock.lastRefresh = Date.now(); cb(mock); }, 800); return mock; },
      setSettings: async (p) => { Object.assign(mock.settings, p, { alerts: { ...mock.settings.alerts, ...(p.alerts || {}) } }); return mock.settings; },
      hooks: async (tool, a) => { mock.hooks[tool] = { installed: a === 'install' }; return { ok: true, hooks: mock.hooks }; },
      cli: async (tool) => { mock.usage[tool] = { ok: false, connected: true, expired: true, reason: '로그인 창을 열었습니다 (mock)' }; cb(mock); return { ok: true, message: 'mock' }; },
      testAlert: async () => { chime('done'); rumble('done'); },
      copy: async (t) => navigator.clipboard && navigator.clipboard.writeText(t),
      showError: async (m) => window.alert(m),
      openLogs: async () => {},
      resize: () => {},
      hide: () => {},
      resetPosition: () => {},
      onState: (f) => { cb = f; },
      onAlert: () => {},
    };
  }
})();
