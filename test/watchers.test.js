// Exercises the watchers against synthetic transcript/rollout files in a temp home.
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
const claudeProj = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'proj-a');
const codexDay = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '28');
fs.mkdirSync(claudeProj, { recursive: true });
fs.mkdirSync(codexDay, { recursive: true });

const { Activity, createClaudeWatcher, createCodexWatcher, classifyClaude, classifyCodex } = require('../src/watchers');

const events = [];
const mk = (id) => {
  const a = new Activity(id);
  a.on('change', ({ prev, status }) => events.push(`${id}: ${prev} -> ${status} (${a.detail})`));
  a.on('done', (info) => events.push(`${id}: DONE! source=${info.source} detail="${info.detail}"`));
  return a;
};
const claude = mk('claude');
const codex = mk('codex');
const log = (...a) => events.push('log: ' + a.join(' '));
createClaudeWatcher(claude, { log });
createCodexWatcher(codex, { log });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (o) => JSON.stringify(o) + '\n';
const now = () => new Date().toISOString();

(async () => {
  await sleep(500);
  // ---- Claude: user prompt -> assistant tool_use -> tool_result -> assistant end_turn
  const cf = path.join(claudeProj, 'sess-1.jsonl');
  fs.appendFileSync(cf, line({ type: 'user', timestamp: now(), message: { role: 'user', content: 'do something' } }));
  await sleep(1200);
  fs.appendFileSync(cf, line({ type: 'assistant', timestamp: now(), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }));
  await sleep(1200);
  fs.appendFileSync(cf, line({ type: 'user', timestamp: now(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }));
  await sleep(1200);
  fs.appendFileSync(cf, line({ type: 'assistant', timestamp: now(), message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'done.' }], stop_reason: 'end_turn' } }));
  await sleep(1500);
  // a subagent transcript finishing must NOT fire
  const sub = path.join(claudeProj, 'sess-1', 'subagents', 'agent-x.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.appendFileSync(sub, line({ type: 'assistant', timestamp: now(), message: { id: 'msg_s', role: 'assistant', content: [{ type: 'text', text: 'sub done' }], stop_reason: 'end_turn' } }));
  await sleep(1500);

  // ---- Codex: task_started -> task_complete
  const rf = path.join(codexDay, 'rollout-2026-10-28T10-00-00-abc.jsonl');
  fs.appendFileSync(rf, line({ timestamp: now(), type: 'session_meta', payload: { id: 'abc' } }));
  fs.appendFileSync(rf, line({ timestamp: now(), type: 'event_msg', payload: { type: 'task_started', turn_attribution: { turn_id: 'T1', parent_turn_id: null } } }));
  await sleep(1200);
  fs.appendFileSync(rf, line({ timestamp: now(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1', root_turn_id: 'T1', last_agent_message: 'All tests pass.\nMore text' } }));
  await sleep(1500);

  // ---- Claude: maybe-done path (no stop_reason) should resolve to done after the quiet fallback
  const cf2 = path.join(claudeProj, 'sess-2.jsonl');
  fs.appendFileSync(cf2, line({ type: 'user', timestamp: now(), message: { role: 'user', content: 'hi' } }));
  await sleep(1000);
  fs.appendFileSync(cf2, line({ type: 'assistant', timestamp: now(), message: { id: 'msg_3', role: 'assistant', content: [{ type: 'text', text: 'streaming…' }], stop_reason: null } }));
  await sleep(8000);

  console.log(events.join('\n'));
  const okClaude = events.some((e) => e.startsWith('claude: DONE!'));
  const okCodex = events.some((e) => e.includes('codex: DONE!') && e.includes('All tests pass.'));
  const subFired = events.filter((e) => e.startsWith('claude: DONE!')).length;
  console.log('\nRESULT claude done fired:', okClaude, '| codex done fired:', okCodex, '| claude done count (expect 2: end_turn + quiet fallback):', subFired);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(okClaude && okCodex && subFired === 2 ? 0 : 1);
})();
