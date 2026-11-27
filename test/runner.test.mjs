// The runner: cycle, step executor, agent launcher and reaper. Each env is a temp git repo with a bare "origin";
// claude is the fake CLI, gh is a fake function and agents/launchers are stubbed unless a test runs one for real. No network.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../engine/config.mjs';
import { quota } from '../engine/models.mjs';
import { acquireLock, argError, cycle, feedQueue, launch, makeCtx, execStep, reapAgents, reapDead, run, runCycle, scanAgents, startAgent, writeIssue } from '../engine/runner.mjs';
import { paths, readJson } from '../engine/state.mjs';
import { ensureMain } from '../engine/worktree.mjs';

const REPO = resolve(import.meta.dirname, '..').replaceAll('\\', '/'), FAKE = `${REPO}/test/fixtures/fake-cli.mjs`;
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const put = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rd = p => readFileSync(p, 'utf8');
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const now = () => new Date().toISOString();

const CONFIG = { repo: 'o/r', approvers: ['Owner'], language: 'en', vendors: { claude: { bin: FAKE } } };

function mkEnv(config = CONFIG) {
  const root = mkdtempSync(`${tmpdir()}/forja-run-`).replaceAll('\\', '/'), origin = `${root}/origin.git`, project = `${root}/proj`, br = config.defaultBranch ?? 'main';
  execFileSync('git', ['init', '-q', '--bare', '-b', br, origin]);
  put(`${project}/README.md`, 'a\n');
  put(`${project}/.forja/config.json`, config);
  g(project, 'init', '-q', '-b', br);
  g(project, 'add', '-A');
  g(project, 'commit', '-qm', 'Add base');
  g(project, 'remote', 'add', 'origin', origin);
  g(project, 'push', '-q', '-u', 'origin', br);
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

test('a cycle reads the merged config: a changed forja-main is reset first, except while a deploy runs', async () => {
  const E = mkEnv();
  ensureMain(E.cfg);
  E.on((...a) => (a[0] === 'issue' && a[1] === 'list' ? '[]' : ''));
  const file = `${E.cfg.paths.main}/.forja/config.json`, tampered = () => put(file, { ...CONFIG, approvers: [] });
  tampered();
  put(`${E.state}/run-deploy.json`, { kind: 'deploy', status: 'running', pid: process.pid, startedAt: now() });
  const held = await runCycle(E.project, E.opts);
  assert.match(held.error, /approvers/);
  rmSync(`${E.state}/run-deploy.json`);
  const ok = await runCycle(E.project, E.opts);
  assert.equal(ok.error, null);
  assert.deepEqual(readJson(file).approvers, ['Owner']);
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

test('reapAgents kills an old-round agent and its claude child, only when the start time verifies', { timeout: 60e3 }, async () => {
  const E = mkEnv(), ctx = E.ctx(), spawnFake = () => spawn(process.execPath, [FAKE], { stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = c => new Promise(r => c.on('close', r)), alive = c => c.exitCode === null && c.signalCode === null;
  const [a, ac, b, bc] = [spawnFake(), spawnFake(), spawnFake(), spawnFake()];
  try {
    const w = (id, p, c, startedAt) => ({ id, role: 'approver', vendor: 'claude', status: 'running', round: 1, pid: p.pid, cpid: c.pid, startedAt });
    job(E, 8, { stage: 'approve', round: 2, running: ['approver'], workers: [w('approver-1', a, ac, now())] });
    reapAgents(ctx);
    await Promise.race([Promise.all([closed(a), closed(ac)]), new Promise((_, no) => setTimeout(() => no(new Error('not killed')), 5000))]);
    assert.equal(readJson(E.P.board).jobs[0].workers[0].status, 'failed');

    job(E, 9, { stage: 'approve', round: 2, running: ['approver'], workers: [w('approver-1', b, bc, '2000-01-01T00:00:00.000Z')] });
    reapAgents(ctx);
    assert.ok(alive(b) && alive(bc));
  } finally { for (const c of [a, ac, b, bc]) c.kill(); }
});

test('bad --every or --issue exits 1 instead of spinning', async () => {
  const E = mkEnv(), errs = [];
  for (const bad of [['--every'], ['--every', 'x'], ['--every', '0'], ['--issue', 'x'], ['--issue']]) {
    assert.equal(await run(['--project', E.project, '--once', ...bad], { ...E.opts, err: m => errs.push(m) }), 1, bad.join(' '));
  }
  assert.match(errs[0], /--every/);
  assert.match(errs.at(-1), /--issue/);
});

test('argError accepts valid --every and --issue and rejects the rest', () => {
  assert.equal(argError(15, null), null);
  assert.equal(argError(0.5, '7'), null);
  assert.equal(argError(15, '123'), null);
  for (const [every, only] of [[NaN, null], [0, null], [-1, null], [Infinity, null], [15, 'dd'], [15, ''], [15, '7x'], [15, '-7']]) assert.ok(argError(every, only), `${every} ${only}`);
});

test('execStep write and run steps', () => {
  const E = mkEnv(), ctx = E.ctx();
  const r = execStep(ctx, { issue: 3, step: 'open-pr', after: true, set: { stage: 'pr' }, event: 'PR opened', do: [{ write: `${E.J(3)}/round-1/owner.md`, text: 'fix it' }, { run: [process.execPath, '-p', '7'], sets: 'pr' }] });
  assert.equal(r.ok, true);
  assert.equal(rd(`${E.J(3)}/round-1/owner.md`), 'fix it');
  const b = readJson(E.P.board).jobs[0];
  assert.equal(b.stage, 'pr');
  assert.equal(b.pr, 7);
  assert.equal(b.events.at(-1).text, 'PR opened');

  const bad = execStep(ctx, { issue: 3, step: 'open-pr', after: true, set: { stage: 'merged' }, do: [{ run: [process.execPath, '-e', 'process.exit(2)'] }] });
  assert.equal(bad.retry, true);
  assert.equal(bad.ok, false);
  const after = readJson(E.P.board).jobs[0];
  assert.equal(after.stage, 'pr');
  assert.equal(after.stepFails.n, 1);
  assert.ok(after.retryAt);
});

test('execStep sets deploy command running before the call and passes bg arguments untouched', () => {
  const E = mkEnv(), seen = [];
  put(E.P.commands, [{ id: 'c1', status: 'pending', action: 'deploy', jobId: 'all' }]);
  const ctx = E.ctx({ launch: (_, argv) => { seen.push({ argv, status: readJson(E.P.commands)[0].status }); return { pid: 1 }; } });
  const r = execStep(ctx, { issue: null, command: 'c1', step: 'deploy', after: true, do: [{ bg: [process.execPath, 'C:/with space/engine/call.mjs', '--project', 'C:/my proj', 'deploy', '1', '2'] }] });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ argv: ['C:/with space/engine/call.mjs', '--project', 'C:/my proj', 'deploy', '1', '2'], status: 'running' }]);
  assert.equal(readJson(E.P.commands)[0].status, 'running');
});

test('second runner on same project exits with lock error', { timeout: 60e3 }, async () => {
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

for (const br of ['main', 'master']) test(`startAgent resolves cwd at launch, writes reviewer diff and syncs main before a spec (${br})`, () => {
  const E = mkEnv({ ...CONFIG, defaultBranch: br }), launched = [], ctx = E.ctx({ launch: (_, argv) => { launched.push(argv); return { pid: process.pid }; } });
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
  g(E.project, 'worktree', 'add', '-q', E.WT(11), '-b', 'forja/11-x', `origin/${br}`);
  put(`${E.WT(11)}/src.txt`, 'new\n');
  g(E.WT(11), 'add', '-A');
  g(E.WT(11), 'commit', '-qm', 'Add src');
  startAgent(ctx, 11, a('review-code', 11));
  assert.equal(agentFile(11, 'code').cwd, E.WT(11));
  assert.equal(agentFile(11, 'code').commit, g(E.WT(11), 'rev-parse', 'HEAD').trim());
  assert.equal('commit' in agentFile(11, 'approver'), false);
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

test('starting a spec agent syncs forja-main without running the dependency install', () => {
  const E = mkEnv({ ...CONFIG, checks: { install: `node -e "require('fs').writeFileSync('installed.txt','x')"` } }), ctx = E.ctx({ launch: () => ({ pid: process.pid }) });
  job(E, 12);
  E.on(() => JSON.stringify({ title: 'T', body: 'b', author: { login: 'owner' } }));
  startAgent(ctx, 12, { agent: 'spec', model: 'sonnet', issue: 12, round: 1, out: `${E.J(12)}/spec.md`, cwd: 'x', prompt: 'p' });
  assert.ok(existsSync(`${E.cfg.paths.main}/README.md`));
  assert.equal(existsSync(`${E.cfg.paths.main}/installed.txt`), false);
});

test('launch sends the process output to logFile, also through the Windows launcher', { timeout: 60e3 }, async () => {
  const E = mkEnv(), logFile = `${E.root}/state/logs/runner.log`, script = `${E.root}/say.mjs`;
  put(script, 'console.log("hello out"); console.error("hello err");');
  launch({ cfg: E.cfg, once: false }, [script], { logFile });
  let log = '';
  for (let i = 0; i < 100 && !(/hello out/.test(log) && /hello err/.test(log)); i++) { await new Promise(r => setTimeout(r, 100)); log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''; }
  assert.match(log, /hello out/);
  assert.match(log, /hello err/);
});

test('an agent process writes its output file and frees its slot in one board write', { timeout: 60e3 }, async () => {
  const E = mkEnv(), log = `${E.root}/fake.log`;
  job(E, 9, { stage: 'approve', running: ['approver'] });
  await withFake({ FAKE_TEXT: 'APPROVE\nTier: B\nPR title: Add x', FAKE_LOG: log }, () => launchReal(E, 9, 'approver'));
  assert.equal(rd(`${E.J(9)}/decision.md`), 'APPROVE\nTier: B\nPR title: Add x\n');
  const b = readJson(E.P.board).jobs[0], w = b.workers.find(x => x.id === 'approver-1');
  assert.deepEqual(b.running, []);
  assert.deepEqual([w.status, w.tokens], ['ok', { input: 3, output: 4, total: 7 }]);
  assert.equal(realpathSync(JSON.parse(rd(log).trim().split('\n')[0]).cwd), realpathSync(E.cfg.paths.main));
});

test('a Claude limit hit is logged to the quota file and spends no retry', { timeout: 60e3 }, async () => {
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

test('a Claude reviewer that dirties the worktree fails without writing its review file', { timeout: 60e3 }, async () => {
  const E = mkEnv();
  g(E.project, 'worktree', 'add', '-q', E.WT(15), '-b', 'forja/15-x', 'origin/main');
  const runReview = async (vars) => {
    const ctx = E.ctx({ once: true });
    job(E, 15, { stage: 'review', round: 1, running: ['code'] });
    await withFake(vars, async () => {
      startAgent(ctx, 15, { agent: 'review-code', model: 'sonnet', issue: 15, round: 1, out: `${E.J(15)}/round-1/review-code.md`, cwd: E.WT(15), prompt: 'review' });
      await Promise.all([...ctx.pending]);
    });
  };
  await runReview({ FAKE_TEXT: 'VERDICT: PASS\n- ok', FAKE_WRITE: 'sneaky.txt::x' });
  assert.equal(existsSync(`${E.J(15)}/round-1/review-code.md`), false);
  let b = readJson(E.P.board).jobs.find(x => x.issue === 15);
  assert.equal(b.workers.find(w => w.id === 'review-code-1').status, 'failed');
  assert.deepEqual(b.agentRetry, ['code']);
  assert.match(b.events.at(-1).text, /changed the worktree/);

  rmSync(`${E.WT(15)}/sneaky.txt`);
  await runReview({ FAKE_TEXT: 'VERDICT: PASS\n- ok' });
  assert.match(rd(`${E.J(15)}/round-1/review-code.md`), /^VERDICT: PASS\nCommit: [0-9a-f]{40}\n- ok\n$/);
  b = readJson(E.P.board).jobs.find(x => x.issue === 15);
  assert.equal(b.workers.find(w => w.id === 'review-code-1').status, 'ok');
});

test('execStep ignores a failing optional run step so a round-0 redo still writes owner.md and continues', () => {
  const E = mkEnv(), ctx = E.ctx(), noteFile = `${E.J(16)}/owner.md`;
  job(E, 16, { stage: 'needs-you', round: 0 });
  const r = execStep(ctx, {
    issue: 16, step: 'redo', set: { stage: 'spec' }, event: 'redo',
    do: [{ run: [process.execPath, '-e', 'process.exit(1)'], optional: true }, { write: noteFile, text: 'owner note' }],
  });
  assert.equal(r.ok, true);
  assert.equal(rd(noteFile), 'owner note');
  assert.equal(readJson(E.P.board).jobs.find(x => x.issue === 16).stage, 'spec');
  assert.ok(E.logs.some(l => l.startsWith('run ignored:')));
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

test('a step whose board write hits a busy lock does not stop the cycle or lose the other steps', async () => {
  const E = mkEnv(), file = `${E.J(40)}/after.md`;
  const T = { tick: () => ({ steps: [{ issue: 39, step: 'x', set: { note: 'a' } }, { issue: 40, step: 'y', do: [{ write: file, text: 'ran' }] }], waiting: [], ignored: [] }), setJob: () => { throw new Error('board lock busy'); } };
  await cycle(E.ctx({ T }));
  assert.equal(rd(file), 'ran');
  assert.ok(E.logs.some(l => /step x #39 not recorded: board lock busy/.test(l)));
});

test('a run step passes every argument to the program as it is, with no shell in between', () => {
  const E = mkEnv(), ctx = E.ctx(), tricky = 'x & echo hi | "q" %PATH% $(id) `id` ; ^ < >';
  const r = execStep(ctx, { issue: 3, step: 'open-pr', after: true, set: { stage: 'pr' }, do: [{ run: [process.execPath, '-p', 'process.argv[1]', tricky], sets: 'pr' }] });
  assert.equal(r.ok, true);
  assert.equal(readJson(E.P.board).jobs[0].pr, tricky);
  const bad = execStep(ctx, { issue: 3, step: 'x', after: true, do: [{ bg: ['sh', '-c', 'echo hi'] }] });
  assert.equal(bad.ok, false);
  assert.match(bad.note, /bg is not a node command/);
});

test('the runner follows the merged config in forja-main, not a broken checkout copy', async () => {
  const E = mkEnv();
  E.on((...a) => (a[0] === 'issue' && a[1] === 'list' ? '[]' : ''));
  put(`${E.cfg.paths.main}/.forja/config.json`, CONFIG);
  put(`${E.project}/.forja/config.json`, { ...CONFIG, approvers: [] });
  assert.equal((await runCycle(E.project, E.opts)).error, null);
  put(`${E.cfg.paths.main}/.forja/config.json`, { ...CONFIG, approvers: [] });
  assert.match((await runCycle(E.project, E.opts)).error, /approvers/);
});

test('reapDead closes a command whose run ended while the board was busy, but not one that started after that run', () => {
  const E = mkEnv(), ctx = E.ctx(), ended = new Date(Date.now() - 60e3).toISOString();
  put(`${E.state}/run-deploy.json`, { kind: 'deploy', pid: 1, startedAt: ended, endedAt: ended, status: 'ok', issues: [41], ids: ['41'] });
  put(E.P.commands, [
    { id: 'old', status: 'running', action: 'deploy', jobId: '41', runAt: new Date(Date.now() - 120e3).toISOString() },
    { id: 'fresh', status: 'running', action: 'deploy', jobId: '41', runAt: new Date().toISOString() },
    { id: 'other', status: 'running', action: 'deploy', jobId: '99', runAt: new Date(Date.now() - 120e3).toISOString() },
  ]);
  reapDead(ctx);
  assert.deepEqual(readJson(E.P.commands).map(c => c.status), ['done', 'running', 'running']);
  assert.equal(readJson(E.P.commands)[0].doneAt, ended);
});

test('reapDead keeps going when the commands file is busy: a dead run is still closed and the next cycle closes its command', () => {
  const E = mkEnv(), ctx = E.ctx(), at = new Date(Date.now() - 60e3).toISOString();
  put(`${E.state}/run-deploy-test.json`, { kind: 'deploy-test', pid: deadPid(), startedAt: at, status: 'running', issues: [43], ids: ['43'] });
  put(E.P.commands, [{ id: 'c', status: 'running', action: 'deploy-test', jobId: '43', runAt: at }]);
  put(`${E.P.commands}.lock`, '');
  assert.doesNotThrow(() => reapDead(ctx));
  assert.equal(readJson(`${E.state}/run-deploy-test.json`).status, 'failed');
  assert.ok(E.logs.some(l => /commands not updated: board lock busy/.test(l)));
  assert.equal(readJson(E.P.commands)[0].status, 'running');
  rmSync(`${E.P.commands}.lock`, { force: true });
  reapDead(ctx);
  assert.equal(readJson(E.P.commands)[0].status, 'failed');
});

test('feedQueue updates queue.json under its lock without overwriting concurrent edits', () => {
  const E = mkEnv(), view = { 20: { state: 'CLOSED', body: '', labels: [] }, 21: { state: 'OPEN', body: '', labels: [] } };
  put(E.P.queue, [20, 21]);
  const lock = `${E.P.queue}.lock`;
  put(lock, '0');
  utimesSync(lock, 0, 0);
  E.on((...a) => {
    if (a[0] === 'issue' && a[1] === 'list') return '[]';
    if (a[1] === 'view') {
      if (a[2] === '21') put(E.P.queue, [...readJson(E.P.queue, []), 99]);
      return JSON.stringify(view[a[2]]);
    }
    return '';
  });
  feedQueue(E.ctx());
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readJson(E.P.queue), [99]);
});

test('acquireLock is atomic across concurrent processes and takes over a dead PID lock', { timeout: 60e3 }, async () => {
  const E = mkEnv(), lock = `${E.state}/.runner.lock`;
  put(lock, String(deadPid()));
  const release = acquireLock(lock, (_, v) => `already running ${v.pid}`);
  assert.equal(rd(lock), String(process.pid));
  release();
  assert.equal(existsSync(lock), false);

  const mod = new URL('../engine/runner.mjs', import.meta.url).href;
  const code = `const { acquireLock } = await import(${JSON.stringify(mod)});
    try {
      const rel = acquireLock(${JSON.stringify(lock)}, (_, v) => 'already running ' + v.pid);
      console.log('ok');
      process.stdin.resume();
      process.stdin.on('end', () => { rel(); process.exit(0); });
    } catch (e) { console.log('err:' + e.message); }`;
  const kids = [1, 2, 3, 4].map(() => spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] }));
  const line = c => new Promise((ok, bad) => {
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; if (out.includes('\n')) ok(out.trim()); });
    c.stderr.on('data', d => (err += d));
    c.on('close', () => ok(out.trim() || `stderr:${err.trim()}`));
    c.on('error', bad);
  });
  try {
    const outs = await Promise.all(kids.map(line));
    assert.equal(outs.filter(o => o === 'ok').length, 1, outs.join(', '));
    assert.equal(outs.filter(o => o.startsWith('err:already running')).length, 3, outs.join(', '));
  } finally {
    for (const c of kids) c.stdin.end();
    await Promise.all(kids.map(c => new Promise(r => (c.exitCode !== null ? r() : c.on('close', r)))));
  }
  assert.equal(existsSync(lock), false);
});
