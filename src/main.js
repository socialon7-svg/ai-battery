'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, Notification, ipcMain, shell, screen, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Settings = require('./settings');
const { createLogger } = require('./log');
const { drawBattery } = require('./png');
const providers = {
  claude: require('./providers/claude'),
  codex: require('./providers/codex'),
  antigravity: require('./providers/antigravity'),
};
const { Activity, createClaudeWatcher, createCodexWatcher, createAntigravityWatcher } = require('./watchers');
const hooks = require('./hooks');
const cli = require('./cli');
const haptics = require('./haptics');
const { startServer } = require('./server');

const PORT = Number(process.env.AI_BATTERY_PORT) || 47831;
const NAMES = { claude: 'Claude Code', codex: 'ChatGPT · Codex', antigravity: 'Antigravity' };
const SHORT = { claude: 'Claude', codex: 'ChatGPT', antigravity: 'AG' };
const W = 280;        // widget width
const MARGIN = 12;    // gap from the screen corner
const TIMEOUTS = { claude: 15000, codex: 15000, antigravity: 25000 };
const ALERT_DEDUPE_MS = 10000; // hook + transcript (+ quiet fallback) may all report one turn

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  app.setAppUserModelId('dev.local.ai-battery');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  const userData = app.getPath('userData');
  const log = createLogger(path.join(userData, 'logs'));
  process.on('uncaughtException', (e) => log('uncaught exception:', e));
  process.on('unhandledRejection', (e) => log('unhandled rejection:', e));

  const settings = new Settings(path.join(userData, 'settings.json'));
  const token = () => settings.get().hookToken;
  const activities = { claude: new Activity('claude'), codex: new Activity('codex'), antigravity: new Activity('antigravity') };
  const state = { usage: {}, cli: cli.status(), lastRefresh: null, serverError: null };
  const inflight = new Set();
  let win = null;
  let tray = null;
  let pollTimer = null;
  let quitting = false;

  // Cheap caches for things snapshot() needs on every broadcast (file reads, process lookups).
  const memo = (ttl, fn) => {
    let at = 0, v;
    const f = () => { if (!at || Date.now() - at > ttl) { v = fn(); at = Date.now(); } return v; };
    f.invalidate = () => { at = 0; };
    return f;
  };
  const hookStatus = memo(10000, () => ({ claude: hooks.claudeStatus(PORT, token()), codex: hooks.codexStatus(PORT, token()) }));
  const steelseries = memo(60000, () => haptics.available());

  // ---- tray ----
  const outline = () => (process.platform === 'darwin' && !nativeTheme.shouldUseDarkColors ? [70, 76, 88] : undefined);
  const trayIcon = (remaining, working) => {
    const img = nativeImage.createEmpty();
    const o = { outline: outline() };
    img.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: drawBattery(16, remaining, working, o) });
    img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: drawBattery(32, remaining, working, o) });
    return img;
  };
  let trayKey = '';
  function updateTray() {
    if (!tray) return;
    const levels = Object.values(state.usage).filter((u) => u && u.ok).map((u) => u.main.remaining);
    const min = levels.length ? Math.min(...levels) : null;
    const working = Object.values(activities).some((a) => a.status === 'working');
    const key = `${min}|${working}|${nativeTheme.shouldUseDarkColors}`;
    if (key !== trayKey) { trayKey = key; tray.setImage(trayIcon(min, working)); }
    const parts = Object.keys(NAMES).filter((k) => connected(k)).map((k) => {
      const u = state.usage[k];
      const v = u && u.ok ? `${Math.round(u.main.remaining)}%` : '-';
      return `${SHORT[k]} ${v}${activities[k].status === 'working' ? '…' : ''}`;
    });
    tray.setToolTip(parts.length ? parts.join(' · ') : 'AI Battery · 연결된 도구 없음');
  }

  const connected = (k) => { const u = state.usage[k]; return !!(u && (u.ok || u.connected)); };

  function snapshot() {
    const activity = {};
    for (const k of Object.keys(activities)) activity[k] = activities[k].snapshot();
    return {
      usage: state.usage,
      activity,
      lastRefresh: state.lastRefresh,
      refreshing: inflight.size > 0,
      serverError: state.serverError,
      hooks: hookStatus(),
      cli: state.cli,
      credentials: { claude: providers.claude.credentialState() },
      haptics: { steelseries: steelseries() },
      port: PORT,
      platform: process.platform,
      logDir: log.dir,
      settings: settings.get(),
    };
  }

  function broadcast() {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
      updateTray();
    } catch (e) { log('broadcast failed:', e.message); }
  }

  // ---- usage polling (each provider independently, with its own timeout) ----
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('시간 초과')), ms).unref())]);

  async function refreshProvider(k) {
    if (inflight.has(k)) return;
    inflight.add(k);
    broadcast();
    try {
      const opts = k === 'antigravity' ? { active: activities.antigravity.status === 'working' } : undefined;
      state.usage[k] = await withTimeout(providers[k].fetchUsage(opts), TIMEOUTS[k]);
    } catch (e) {
      const prev = state.usage[k];
      state.usage[k] = { ok: false, connected: !!(prev && prev.connected), reason: e.message || '알 수 없는 오류' };
      log(`${k}: usage failed: ${e.message}`);
    } finally {
      inflight.delete(k);
      state.lastRefresh = Date.now();
      const u = state.usage[k];
      const summary = u.ok ? `${Math.round(u.main.remaining)}% left (${u.main.label})` : `${u.connected ? 'connected' : 'not connected'} · ${u.reason}`;
      if (summary !== lastSummary[k]) { lastSummary[k] = summary; log(`${k}: ${summary}`); }
      broadcast();
    }
  }
  const lastSummary = {};

  function refreshUsage() {
    state.cli = cli.status();
    return Promise.all(Object.keys(providers).map((k) => refreshProvider(k)));
  }

  function schedulePoll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(refreshUsage, Math.max(15, Number(settings.get().pollSeconds) || 60) * 1000);
  }

  // ---- alerts ----
  const lastAlert = {};
  function alert(provider, kind, body, force) {
    const now = Date.now();
    const key = `${provider}:${kind}`;
    if (!force && lastAlert[key] && now - lastAlert[key] < ALERT_DEDUPE_MS) return;
    lastAlert[key] = now;
    const s = settings.get();
    if (!force && s.alerts && s.alerts[provider] === false) return;
    const title = kind === 'attention' ? `${NAMES[provider]} 확인 필요` : `${NAMES[provider]} 작업 완료`;
    const clean = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const text = clean || (kind === 'attention' ? '허가가 필요합니다' : `${new Date(now).toTimeString().slice(0, 5)}에 끝났습니다`);
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title, body: text, silent: true });
        n.on('click', showWindow);
        n.show();
      }
    } catch (e) { log('notification failed:', e.message); }
    // The renderer plays the chime and rumbles gamepads; SteelSeries tactile devices are driven from here.
    if (win && !win.isDestroyed()) win.webContents.send('alert', { kind, provider });
    if (s.vibrate !== false) haptics.vibrate(kind).then((ok) => { if (ok) log('steelseries vibrate ok'); }).catch(() => {});
    broadcast();
  }

  for (const k of Object.keys(activities)) {
    activities[k].on('change', broadcast);
    activities[k].on('done', (info) => {
      alert(k, 'done', info.detail || '');
      setTimeout(() => refreshProvider(k), 4000); // quota just changed
    });
  }

  // ---- window placement ----
  let suppressMoveSave = 0;
  function topRight() {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - W - MARGIN, y: wa.y + MARGIN };
  }

  function savedPosition() {
    const b = settings.get().bounds;
    if (!b) return null;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + 40 > a.x && b.x + 40 < a.x + a.width && b.y + 20 > a.y && b.y + 20 < a.y + a.height;
    });
    return visible ? { x: b.x, y: b.y } : null;
  }

  // Programmatic moves must not be mistaken for the user dragging the widget.
  function place(x, y) {
    if (!win || win.isDestroyed()) return;
    suppressMoveSave = Date.now() + 1000;
    win.setPosition(Math.round(x), Math.round(y));
  }

  function applyAlwaysOnTop() {
    if (!win || win.isDestroyed()) return;
    const on = !!settings.get().alwaysOnTop;
    if (process.platform === 'darwin') win.setAlwaysOnTop(on, 'floating');
    else win.setAlwaysOnTop(on);
  }

  function resetPosition() {
    const p = topRight();
    place(p.x, p.y);
    settings.save({ bounds: null });
  }

  // After a monitor change: anchored widgets follow the corner, dragged ones come back if lost.
  function ensureOnScreen() {
    if (!win || win.isDestroyed()) return;
    if (!settings.get().bounds) { const p = topRight(); place(p.x, p.y); return; }
    if (!savedPosition()) resetPosition();
  }

  function createWindow() {
    // A saved position that is exactly the corner (older versions stored it) means "anchored".
    const b = settings.get().bounds;
    const tr = topRight();
    if (b && b.x === tr.x && b.y === tr.y) settings.save({ bounds: null });
    const pos = savedPosition() || topRight();
    suppressMoveSave = Date.now() + 3000; // the first show emits 'move' too; only the user's drags count
    win = new BrowserWindow({
      width: W,
      height: 150,
      x: pos.x,
      y: pos.y,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      show: false,
      title: 'AI Battery',
      backgroundColor: '#13161c',
      icon: nativeImage.createFromBuffer(drawBattery(64, 80, false)),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    applyAlwaysOnTop();
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    if (process.env.AI_BATTERY_SHOT) {
      // Debug aid: AI_BATTERY_SHOT=/path/out.png saves a screenshot of the window a few seconds after start.
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.AI_BATTERY_SHOT, img.toPNG());
          log('screenshot saved:', process.env.AI_BATTERY_SHOT, 'size', win.getContentSize().join('x'), 'pos', win.getPosition().join(','));
        } catch (e) { log('screenshot failed:', e.message); }
      }, 7000);
    }
    let moveTimer = null;
    win.on('move', () => {
      if (Date.now() < suppressMoveSave) return;
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        const [x, y] = win.getPosition();
        settings.save({ bounds: { x, y } });
      }, 500);
    });
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
    // The widget never navigates: dropped links/files and window.open requests are refused.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('will-redirect', (e) => e.preventDefault());
    win.webContents.on('will-attach-webview', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  function showWindow() {
    if (!app.isReady()) return;
    if (!win || win.isDestroyed()) createWindow();
    win.show();
    win.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  }

  function toggleWindow() {
    if (win && !win.isDestroyed() && win.isVisible() && (win.isFocused() || !!settings.get().alwaysOnTop)) win.hide();
    else showWindow();
  }

  function applyLoginItem() {
    try { app.setLoginItemSettings({ openAtLogin: !!settings.get().openAtLogin, openAsHidden: true }); }
    catch (e) { log('login item failed:', e.message); }
  }

  function trayMenu() {
    const s = settings.get();
    return Menu.buildFromTemplate([
      { label: '열기', click: showWindow },
      { label: '우측 상단으로 이동', click: () => { showWindow(); resetPosition(); } },
      { label: '지금 새로고침', click: refreshUsage },
      { type: 'separator' },
      { label: '알림 소리', type: 'checkbox', checked: !!s.sound, click: (mi) => { settings.save({ sound: mi.checked }); broadcast(); } },
      { label: '알림 진동', type: 'checkbox', checked: s.vibrate !== false, click: (mi) => { settings.save({ vibrate: mi.checked }); broadcast(); } },
      { label: '항상 위에 표시', type: 'checkbox', checked: !!s.alwaysOnTop, click: (mi) => { settings.save({ alwaysOnTop: mi.checked }); applyAlwaysOnTop(); broadcast(); } },
      { label: '로그인 시 자동 시작', type: 'checkbox', checked: !!s.openAtLogin, click: (mi) => { settings.save({ openAtLogin: mi.checked }); applyLoginItem(); broadcast(); } },
      { type: 'separator' },
      { label: '로그 폴더 열기', click: () => shell.openPath(log.dir) },
      { label: '종료', click: () => { quitting = true; app.quit(); } },
    ]);
  }

  function createTray() {
    tray = new Tray(trayIcon(null, false));
    tray.setToolTip('AI Battery');
    tray.on('click', toggleWindow);
    tray.on('double-click', showWindow);
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
    nativeTheme.on('updated', updateTray);
  }

  // ---- connecting to the other tools ----
  // Hooks / notify: installed (or refreshed after a port/token change) unless the user removed them by hand.
  function autoConnect() {
    const s = settings.get();
    if (!s.autoHook) return;
    try {
      const st = hooks.claudeStatus(PORT, token());
      if (st.present && !st.error && !st.installed && !s.hookOptOut.claude) { hooks.installClaude(PORT, token()); log(st.stale ? 'claude hooks refreshed' : 'claude hooks installed'); }
    } catch (e) { log('claude hook install failed:', e.message); }
    try {
      const st = hooks.codexStatus(PORT, token());
      if (st.present && !st.error && !st.installed && !st.foreign && !s.hookOptOut.codex) { hooks.installCodex(PORT, token()); log(st.stale ? 'codex notify refreshed' : 'codex notify installed'); }
    } catch (e) { log('codex notify install failed:', e.message); }
    hookStatus.invalidate();
  }

  function disconnectAll() {
    try { if (hooks.claudeStatus(PORT, token()).ours) hooks.uninstallClaude(PORT, token()); } catch (e) { log('claude hook remove failed:', e.message); }
    try { if (hooks.codexStatus(PORT, token()).ours) hooks.uninstallCodex(PORT, token()); } catch (e) { log('codex notify remove failed:', e.message); }
    hookStatus.invalidate();
  }

  // CLI login: when a CLI is installed but has no credentials, open its login once (per tool).
  function autoLogin() {
    const s = settings.get();
    if (!s.autoLogin) return;
    for (const tool of ['claude', 'codex']) {
      const u = state.usage[tool];
      if (!u) continue;
      if (u.connected) { if (s.loginPrompted[tool]) settings.save({ loginPrompted: { [tool]: false } }); continue; }
      if (s.loginPrompted[tool] || !state.cli[tool] || !state.cli[tool].cli) continue;
      try {
        cli.run(tool, 'login');
        settings.save({ loginPrompted: { [tool]: true } });
        log(`${tool}: opened login flow`);
      } catch (e) { log(`${tool}: login flow failed: ${e.message}`); }
    }
  }

  // Re-check a tool as soon as its credential file appears or changes (right after a login).
  function watchCredentials(dir, name, onChange) {
    let timer = null;
    const start = () => {
      try {
        if (!fs.existsSync(dir)) throw new Error('missing');
        const w = fs.watch(dir, (ev, f) => {
          if (f && f.toString() === name) { clearTimeout(timer); timer = setTimeout(onChange, 1500); }
        });
        w.on('error', () => { try { w.close(); } catch { /* ignore */ } setTimeout(start, 30000); });
      } catch { setTimeout(start, 60000); }
    };
    start();
  }

  // ---- IPC (only from our own renderer page) ----
  const trusted = (event) => {
    try {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
      const u = new URL(event.senderFrame.url);
      return u.protocol === 'file:' && /\/renderer\/index\.html$/.test(u.pathname) && event.senderFrame === win.webContents.mainFrame;
    } catch { return false; }
  };
  const guard = (fn) => (event, ...args) => (trusted(event) ? fn(event, ...args) : undefined);

  ipcMain.handle('state:get', guard(() => snapshot()));
  ipcMain.handle('usage:refresh', guard(async () => { await refreshUsage(); return snapshot(); }));
  ipcMain.handle('settings:set', guard((_e, patch) => {
    const before = settings.get();
    const after = settings.save(patch);
    if (before.alwaysOnTop !== after.alwaysOnTop) applyAlwaysOnTop();
    if (before.openAtLogin !== after.openAtLogin) applyLoginItem();
    if (before.autoHook !== after.autoHook) { if (after.autoHook) { settings.save({ hookOptOut: { claude: false, codex: false } }); autoConnect(); } else disconnectAll(); }
    if (before.pollSeconds !== after.pollSeconds) schedulePoll();
    broadcast();
    return settings.get();
  }));
  ipcMain.handle('hooks:set', guard((_e, { tool, action } = {}) => {
    try {
      if (tool === 'claude' && action === 'install') { hooks.installClaude(PORT, token()); settings.save({ hookOptOut: { claude: false } }); }
      else if (tool === 'claude' && action === 'uninstall') { hooks.uninstallClaude(PORT, token()); settings.save({ hookOptOut: { claude: true } }); }
      else if (tool === 'codex' && action === 'install') { hooks.installCodex(PORT, token()); settings.save({ hookOptOut: { codex: false } }); }
      else if (tool === 'codex' && action === 'uninstall') { hooks.uninstallCodex(PORT, token()); settings.save({ hookOptOut: { codex: true } }); }
      hookStatus.invalidate();
      broadcast();
      return { ok: true, hooks: hookStatus() };
    } catch (err) {
      hookStatus.invalidate();
      return { ok: false, error: err.message, hooks: hookStatus() };
    }
  }));
  ipcMain.handle('cli:run', guard((_e, { tool, action } = {}) => {
    try {
      if (!['claude', 'codex'].includes(tool) || !['install', 'login'].includes(action)) throw new Error('잘못된 요청');
      const r = cli.run(tool, action);
      if (r.open) shell.openExternal(r.open);
      settings.save({ loginPrompted: { [tool]: true } });
      log(`${tool}: ${action} started by user`);
      return r;
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }));
  ipcMain.handle('alert:test', guard(() => { alert('claude', 'done', '테스트 알림입니다', true); return true; }));
  ipcMain.handle('clipboard:write', guard((_e, text) => { if (typeof text === 'string' && text.length < 4096) clipboard.writeText(text); return true; }));
  ipcMain.handle('ui:error', guard(async (_e, message) => {
    if (!win || win.isDestroyed()) return;
    await dialog.showMessageBox(win, { type: 'warning', title: 'AI Battery', message: String(message || '').slice(0, 500), buttons: ['확인'] });
  }));
  ipcMain.handle('logs:open', guard(() => shell.openPath(log.dir)));
  ipcMain.on('window:resize', guard((_e, h) => {
    if (!win || win.isDestroyed()) return;
    const height = Math.max(60, Math.min(900, Math.round(Number(h) || 0)));
    const [x, y] = win.getPosition();
    const wa = screen.getDisplayMatching({ x, y, width: W, height }).workArea;
    let ny = y;
    if (y + height > wa.y + wa.height) ny = Math.max(wa.y, wa.y + wa.height - height); // grow upwards near the bottom edge
    if (win.getContentSize()[1] === height && ny === y) return;
    if (ny !== y) suppressMoveSave = Date.now() + 1000;
    win.setContentBounds({ x, y: ny, width: W, height });
  }));
  ipcMain.on('window:hide', guard(() => { if (win && !win.isDestroyed()) win.hide(); }));
  ipcMain.on('window:reset-position', guard(resetPosition));

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide(); // menu-bar style widget
    createTray();
    createWindow();
    log(`ai-battery ${app.getVersion()} started · userData ${userData}`);

    startServer({
      port: PORT,
      token: token(),
      log,
      onEvent: (ev) => {
        log('hook:', ev.provider, ev.kind);
        if (ev.provider === 'claude' && ev.kind === 'stop') {
          activities.claude.done({ detail: '', source: 'hook' });
        } else if (ev.provider === 'claude' && ev.kind === 'notification') {
          const p = ev.payload || {};
          const type = String(p.notification_type || '');
          const msg = String(p.message || '').slice(0, 200);
          if (type === 'permission_prompt' || /permission|허가|approv/i.test(msg)) {
            activities.claude.markAttention('허가 대기 중');
            alert('claude', 'attention', msg || '허가가 필요합니다');
          }
        } else if (ev.provider === 'codex' && ev.kind === 'stop') {
          const p = ev.payload || {};
          activities.codex.done({ detail: String(p['last-assistant-message'] || '').split('\n')[0].slice(0, 100), source: 'hook' });
        } else if (ev.provider === 'antigravity' && ev.kind === 'done') {
          activities.antigravity.done({ detail: '', source: 'hook' });
        }
      },
    }).then(() => log(`hook server listening on 127.0.0.1:${PORT}`))
      .catch((e) => {
        state.serverError = e.code === 'EADDRINUSE' ? `포트 ${PORT}가 이미 사용 중` : e.message;
        log('hook server error:', e.message);
        broadcast();
      });

    autoConnect();
    createClaudeWatcher(activities.claude, { log });
    createCodexWatcher(activities.codex, { log });
    createAntigravityWatcher(activities.antigravity, { log, quietSeconds: () => Number(settings.get().quietSeconds) || 20 });
    watchCredentials(path.dirname(providers.claude.credentialsFile()), path.basename(providers.claude.credentialsFile()), () => { log('claude: credentials changed'); hookStatus.invalidate(); refreshProvider('claude'); });
    watchCredentials(path.dirname(providers.codex.authFile()), path.basename(providers.codex.authFile()), () => { log('codex: credentials changed'); refreshProvider('codex'); });

    const onDisplays = (() => { let t = null; return () => { clearTimeout(t); t = setTimeout(ensureOnScreen, 800); }; })();
    screen.on('display-metrics-changed', onDisplays);
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);

    schedulePoll();
    refreshUsage().then(autoLogin);
  });

  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
}
