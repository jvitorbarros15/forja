// The runner: cycle, step executor, agent launcher and reaper. Each env is a temp git repo with a bare "origin";
// claude is the fake CLI, gh is a fake function and agents/launchers are stubbed unless a test runs one for real. No network.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../engine/config.mjs';
import { quota } from '../engine/models.mjs';
import { feedQueue, makeCtx, execStep, reapAgents, reapDead, run, runCycle, scanAgents, startAgent, writeIssue } from '../engine/runner.mjs';
import { paths, readJson } from '../engine/state.mjs';

const REPO = resolve(import.meta.dirname, '..').replaceAll('\\', '/'), FAKE = `${REPO}/test/fixtures/fake-cli.mjs`;
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const put = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rd = p => readFileSync(p, 'utf8');
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const now = () => new Date().toISOString();

const CONFIG = { repo: 'o/r', approvers: ['Owner'], language: 'en', vendors: { claude: { bin: FAKE } } };

function mkEnv(config = CONFIG) {
  const root = mkdtempSync(`${tmpdir()}/forja-run-`).replaceAll('\\', '/'), origin = `${root}/origin.git`, project = `${root}/proj`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  put(`${project}/README.md`, 'a\n');
  g(project, 'init', '-q', '-b', 'main');
  g(project, 'add', '-A');
  g(project, 'commit', '-qm', 'Add base');
  g(project, 'remote', 'add', 'origin', origin);
  g(project, 'push', '-q', '-u', 'origin', 'main');
  put(`${project}/.forja/config.json`, config);
  const cfg = loadConfig(project, { pluginRoot: REPO }), P = paths(cfg), logs = [], gh = (...a) => { calls.push(a); return handler(...a); };
  const calls = [];
  let handler = () => '';
  const E = { root, project, cfg, P, logs, calls, J: P.jobs, WT: P.wt, state: cfg.paths.state, on: h => { handler = h; } };
  E.opts = { gh, log: (...a) => logs.push(a.join(' ')), notify: t => (E.notes ??= []).push(t) };
  E.ctx = (o = {}) => makeCtx(cfg, { ...E.opts, ...o });
  return E;
}
const job = (E, n, patch = {}) => E.ctx().T.setJob(n, { stage: 'build', round: 1, running: [], ...patch });

test('dry-run once prints steps without writing board', async () => {
  const E = mkEnv();
  E.on((...a) => (a[0] === 'issue' && a[1] === 'list' ? '[{"number":5,"title":"Add thing"}]' : a[0] === 'api' ? 'owner\n' : ''));
  assert.equal(await run(['--project', E.project, '--dry-run'], E.opts), 0);
  const out = E.logs.join('\n');
  assert.match(out, /step pickup #5/);
  assert.match(out, /agent spec \(sonnet\)/);
  assert.equal(existsSync(E.P.board), false);
  assert.equal(existsSync(E.P.runner), false);
  assert.equal(existsSync(`${E.state}/.runner.lock`), false);
});

test('bad config is reported in heartbeat and cycle continues', async () => {
  const E = mkEnv();
  E.on((...a) => (a[0] === 'issue' && a[1] === 'list' ? '[]' : ''));
  put(`${E.project}/.forja/config.json`, { ...CONFIG, approvers: [] });
  const bad = await runCycle(E.project, E.opts);
  assert.match(bad.error, /approvers/);
  assert.match(readJson(E.P.runner).error, /approvers/);
  put(`${E.project}/.forja/config.json`, CONFIG);
  const ok = await runCycle(E.project, E.opts);
  assert.equal(ok.error, null);
  assert.equal(readJson(E.P.runner).error, null);
  assert.deepEqual(readJson(E.P.runner).waiting, []);
});

test('scanAgents marks dead worker gone and frees slot', () => {
  const E = mkEnv(), at = now(), dead = deadPid();
  const w = (id, role, round, pid, extra = {}) => ({ id, role, round, pid, vendor: 'claude', status: 'running', startedAt: at, ...extra });
  const j = {
    issue: 7, round: 2, running: ['builder', 'code', 'approver'],
    workers: [w('builder-2', 'builder', 2, dead), w('review-code-2', 'review-code', 2, process.pid), w('approver-1', 'approver', 1, process.pid), w('build-2-codex:x', 'build', 2, dead, { vendor: 'codex' })],
  };
  const s = scanAgents(E.cfg, j);
  assert.deepEqual(s.gone.map(x => x.id), ['builder-2']);
  assert.deepEqual(s.old.map(x => x.id), ['approver-1']);
  assert.deepEqual([...s.held], ['code']);
  assert.deepEqual(s.stale, ['builder', 'approver']);

  const ctx = E.ctx();
  job(E, 7, { running: ['builder'], workers: [w('builder-1', 'builder', 1, dead)], round: 1 });
  put(`${E.J(7)}/agent-builder.json`, { id: 'builder-1', agent: 'builder', model: 'sonnet', issue: 7, round: 1, out: `${E.J(7)}/builder.md` });
  reapAgents(ctx);
  const b = readJson(E.P.board).jobs[0];
  assert.deepEqual(b.running, []);
  assert.equal(b.workers[0].status, 'failed');
  assert.deepEqual(b.agentRetry, ['builder']);
});

test('execStep write and run steps', () => {
  const E = mkEnv(), ctx = E.ctx();
  const r = execStep(ctx, { issue: 3, step: 'open-pr', after: true, set: { stage: 'pr' }, event: 'PR opened', do: [{ write: `${E.J(3)}/round-1/owner.md`, text: 'fix it' }, { run: 'node -p 7', sets: 'pr' }] });
  assert.equal(r.ok, true);
  assert.equal(rd(`${E.J(3)}/round-1/owner.md`), 'fix it');
  const b = readJson(E.P.board).jobs[0];
  assert.equal(b.stage, 'pr');
  assert.equal(b.pr, '7');
  assert.equal(b.events.at(-1).text, 'PR opened');

  const bad = execStep(ctx, { issue: 3, step: 'open-pr', after: true, set: { stage: 'merged' }, do: [{ run: 'node -e "process.exit(2)"' }] });
  assert.equal(bad.retry, true);
  assert.equal(bad.ok, false);
  const after = readJson(E.P.board).jobs[0];
  assert.equal(after.stage, 'pr');
  assert.equal(after.stepFails.n, 1);
  assert.ok(after.retryAt);
});

test('execStep sets deploy command running before the call and parses quoted bg paths', () => {
  const E = mkEnv(), seen = [];
  put(E.P.commands, [{ id: 'c1', status: 'pending', action: 'deploy', jobId: 'all' }]);
  const ctx = E.ctx({ launch: (_, argv) => { seen.push({ argv, status: readJson(E.P.commands)[0].status }); return { pid: 1 }; } });
  const r = execStep(ctx, { issue: null, command: 'c1', step: 'deploy', after: true, do: [{ bg: 'node "C:/with space/engine/call.mjs" --project "C:/my proj" deploy 1 2' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ argv: ['C:/with space/engine/call.mjs', '--project', 'C:/my proj', 'deploy', '1', '2'], status: 'running' }]);
  assert.equal(readJson(E.P.commands)[0].status, 'running');
});

test('second runner on same project exits with lock error', async () => {
  const E = mkEnv(), errs = [], holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  E.on((...a) => (a[0] === 'issue' && a[1] === 'list' ? '[]' : ''));
  try {
    put(`${E.state}/.runner.lock`, String(holder.pid));
    assert.equal(await run(['--project', E.project, '--once'], { ...E.opts, err: m => errs.push(m) }), 1);
    assert.match(errs[0], /already running/);
    assert.equal(rd(`${E.state}/.runner.lock`), String(holder.pid));
  } finally { holder.kill(); }
  await new Promise(r => holder.on('close', r));
  assert.equal(await run(['--project', E.project, '--once'], E.opts), 0);
  assert.equal(existsSync(`${E.state}/.runner.lock`), false);
  assert.equal(readJson(E.P.runner).error, null);
});

test('issue.md carries the body only for an approver, case-insensitively', () => {
  const E = mkEnv(), view = author => E.on(() => JSON.stringify({ title: 'T', body: 'secret body', author: { login: author } }));
  view('OWNER');
  writeIssue(E.ctx(), 4);
  assert.equal(rd(`${E.J(4)}/issue.md`), '# T\n\nsecret body\n');
  view('stranger');
  writeIssue(E.ctx(), 4);
  const text = rd(`${E.J(4)}/issue.md`);
  assert.match(text, /^# T\n\n\(body omitted/);
  assert.doesNotMatch(text, /secret/);
});

test('startAgent resolves cwd at launch, writes reviewer diff and syncs main before a spec', () => {
  const E = mkEnv(), launched = [], ctx = E.ctx({ launch: (_, argv) => { launched.push(argv); return { pid: process.pid }; } });
  const a = (agent, issue, extra = {}) => ({ agent, model: 'sonnet', issue, round: 1, out: `${E.J(issue)}/x.md`, cwd: 'ignored', prompt: 'p', ...extra });
  const agentFile = (issue, slot) => readJson(`${E.J(issue)}/agent-${slot}.json`);
  job(E, 12);
  E.on(() => JSON.stringify({ title: 'T', body: 'b', author: { login: 'owner' } }));
  startAgent(ctx, 12, a('spec', 12));
  assert.ok(existsSync(`${E.cfg.paths.main}/README.md`));
  assert.equal(agentFile(12, 'spec').cwd, E.cfg.paths.main);
  assert.ok(existsSync(`${E.J(12)}/issue.md`));
  assert.deepEqual(launched[0].slice(1), ['--agent', `${E.J(12)}/agent-spec.json`, '--project', E.project]);

  job(E, 11);
  startAgent(ctx, 11, a('approver', 11));
  assert.equal(agentFile(11, 'approver').cwd, E.cfg.paths.main);
  g(E.project, 'worktree', 'add', '-q', E.WT(11), '-b', 'forja/11-x', 'origin/main');
  put(`${E.WT(11)}/src.txt`, 'new\n');
  g(E.WT(11), 'add', '-A');
  g(E.WT(11), 'commit', '-qm', 'Add src');
  startAgent(ctx, 11, a('review-code', 11));
  assert.equal(agentFile(11, 'code').cwd, E.WT(11));
  assert.match(rd(`${E.J(11)}/round-1/diff.patch`), /\+\+\+ b\/src\.txt/);
  const w = readJson(E.P.board).jobs.find(x => x.issue === 11).workers.find(x => x.role === 'review-code');
  assert.deepEqual([w.status, w.vendor, w.round, w.pid], ['running', 'claude', 1, process.pid]);
});

async function withFake(vars, fn) {
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const k of Object.keys(vars)) delete process.env[k]; }
}
const launchReal = async (E, n, agent) => {
  const ctx = E.ctx({ once: true });
  if (!existsSync(E.cfg.paths.main)) g(E.project, 'worktree', 'add', '-q', '--detach', E.cfg.paths.main, 'origin/main');
  startAgent(ctx, n, { agent, model: 'sonnet', issue: n, round: 1, out: `${E.J(n)}/decision.md`, cwd: E.cfg.paths.main, prompt: 'hello' });
  await Promise.all([...ctx.pending]);
};

test('an agent process writes its output file and frees its slot in one board write', async () => {
  const E = mkEnv(), log = `${E.root}/fake.log`;
  job(E, 9, { stage: 'approve', running: ['approver'] });
  await withFake({ FAKE_TEXT: 'APPROVE\nTier: B\nPR title: Add x', FAKE_LOG: log }, () => launchReal(E, 9, 'approver'));
  assert.equal(rd(`${E.J(9)}/decision.md`), 'APPROVE\nTier: B\nPR title: Add x\n');
  const b = readJson(E.P.board).jobs[0], w = b.workers.find(x => x.id === 'approver-1');
  assert.deepEqual(b.running, []);
  assert.deepEqual([w.status, w.tokens], ['ok', { input: 3, output: 4, total: 7 }]);
  assert.equal(JSON.parse(rd(log).trim().split('\n')[0]).cwd.replaceAll('\\', '/'), E.cfg.paths.main);
});

test('a Claude limit hit is logged to the quota file and spends no retry', async () => {
  const E = mkEnv();
  job(E, 9, { stage: 'approve', running: ['approver'] });
  await withFake({ FAKE_LIMIT: '1' }, () => launchReal(E, 9, 'approver'));
  const b = readJson(E.P.board).jobs[0];
  assert.deepEqual(b.running, []);
  assert.equal(b.limitWaits, 1);
  assert.deepEqual(b.agentRetry ?? [], []);
  assert.ok(quota(E.state).claude.limitedUntil);
  assert.equal(existsSync(`${E.J(9)}/decision.md`), false);
});

test('reapDead closes a dead deploy run, its cards and its command', () => {
  const E = mkEnv();
  job(E, 7, { stage: 'merged' });
  put(`${E.state}/run-deploy.json`, { kind: 'deploy', status: 'running', pid: deadPid(), startedAt: now(), issues: [7], ids: ['7'] });
  put(E.P.commands, [{ id: 'c1', status: 'running', action: 'deploy', jobId: '7' }, { id: 'c2', status: 'running', action: 'deploy-test', jobId: '7' }]);
  reapDead(E.ctx());
  assert.equal(readJson(`${E.state}/run-deploy.json`).status, 'failed');
  assert.match(readJson(E.P.board).jobs[0].events.at(-1).text, /Deploy failed/);
  assert.deepEqual(readJson(E.P.commands).map(c => c.status), ['failed', 'running']);
});

test('feedQueue labels the first issue whose dependencies are closed', () => {
  const E = mkEnv(), view = { 20: { state: 'OPEN', body: 'Depends on: #5', labels: [] }, 5: { state: 'OPEN' }, 21: { state: 'OPEN', body: '', labels: [] } };
  put(E.P.queue, [20, 21]);
  E.on((...a) => (a[0] === 'issue' && a[1] === 'list' ? '[{"number":1}]' : a[1] === 'view' ? JSON.stringify(view[a[2]]) : ''));
  feedQueue(E.ctx());
  assert.deepEqual(E.calls.at(-1).slice(0, 3), ['issue', 'edit', '21']);
  assert.ok(E.calls.at(-1).includes('forja'));
  assert.deepEqual(readJson(E.P.queue), [20]);
});
