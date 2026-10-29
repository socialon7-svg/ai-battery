'use strict';
// Tiny validated JSON settings store kept in Electron's userData folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 3;
const TOOLS = ['claude', 'codex', 'antigravity'];
const DEFAULTS = {
  v: VERSION,
  sound: true,
  vibrate: true,
  alwaysOnTop: true,
  autoHook: true,        // install Claude Code hooks / Codex notify on start
  autoLogin: true,       // open the CLI login once when a CLI is installed but not logged in
  openAtLogin: false,    // start with the OS session
  pollSeconds: 60,
  quietSeconds: 20,
  alerts: { claude: true, codex: true, antigravity: true },
  hookOptOut: { claude: false, codex: false },      // user removed the hook by hand: don't auto-reinstall
  loginPrompted: { claude: false, codex: false },   // auto login flow already opened once
  hookToken: null,       // shared secret between the installed hooks and the local server
  bounds: null,          // { x, y } where the user last dragged the widget; null = top-right corner
};

const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const int = (v, d, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const flags = (v, d, keys) => {
  const out = { ...d };
  if (v && typeof v === 'object') for (const k of keys) if (typeof v[k] === 'boolean') out[k] = v[k];
  return out;
};

function sanitize(raw, base) {
  const j = raw && typeof raw === 'object' ? raw : {};
  return {
    v: VERSION,
    sound: bool(j.sound, base.sound),
    vibrate: bool(j.vibrate, base.vibrate),
    alwaysOnTop: bool(j.alwaysOnTop, base.alwaysOnTop),
    autoHook: bool(j.autoHook, base.autoHook),
    autoLogin: bool(j.autoLogin, base.autoLogin),
    openAtLogin: bool(j.openAtLogin, base.openAtLogin),
    pollSeconds: int(j.pollSeconds, base.pollSeconds, 15, 3600),
    quietSeconds: int(j.quietSeconds, base.quietSeconds, 5, 300),
    alerts: flags(j.alerts, base.alerts, TOOLS),
    hookOptOut: flags(j.hookOptOut, base.hookOptOut, ['claude', 'codex']),
    loginPrompted: flags(j.loginPrompted, base.loginPrompted, ['claude', 'codex']),
    hookToken: typeof j.hookToken === 'string' && /^[a-f0-9]{16,64}$/.test(j.hookToken) ? j.hookToken : base.hookToken,
    bounds: j.bounds === null ? null
      : j.bounds && Number.isFinite(j.bounds.x) && Number.isFinite(j.bounds.y) ? { x: Math.round(j.bounds.x), y: Math.round(j.bounds.y) }
        : base.bounds,
  };
}

class Settings {
  constructor(file) {
    this.file = file;
    this.data = sanitize({}, DEFAULTS);
    let loaded = null;
    try { loaded = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run or corrupt: defaults */ }
    if (loaded) {
      this.data = sanitize(loaded, this.data);
      if (!loaded.v || loaded.v < 2) this.data.alwaysOnTop = true; // v1 was a normal window; v2+ is a corner widget
    }
    if (!this.data.hookToken) this.data.hookToken = crypto.randomBytes(16).toString('hex');
    if (!loaded || loaded.v !== VERSION || !loaded.hookToken) this.write();
  }

  get() { return this.data; }

  // Merges a partial patch; unknown keys are dropped and values are validated.
  save(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const merged = { ...this.data, ...p };
    if (p.alerts) merged.alerts = { ...this.data.alerts, ...p.alerts };
    if (p.hookOptOut) merged.hookOptOut = { ...this.data.hookOptOut, ...p.hookOptOut };
    if (p.loginPrompted) merged.loginPrompted = { ...this.data.loginPrompted, ...p.loginPrompted };
    this.data = sanitize(merged, this.data);
    this.write();
    return this.data;
  }

  write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch { /* read-only disk: keep running with in-memory settings */ }
  }
}

Settings.DEFAULTS = DEFAULTS;
Settings.VERSION = VERSION;
module.exports = Settings;
