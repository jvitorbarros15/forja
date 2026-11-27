// The forja CLI: gh is injected and PATH is stubbed with fake binaries; start/stop run a real server and a stand-in runner.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../engine/cli.mjs';
import { alive, killTree, spawnDetached } from '../engine/platform.mjs';
import { readJson } from '../engine/state.mjs';

const REPO = resolve(import.meta.dirname, '..').replaceAll('\\', '/');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const put = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
const tmp = () => mkdtempSync(`${tmpdir()}/forja-cli-`).replaceAll('\\', '/');
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const CONFIG = { repo: 'o/r', approvers: ['Owner'] };

function fakeBin(dir, ...names) {
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    put(`${dir}/${n}`, '#!/bin/sh\nexit 0\n');
    chmodSync(`${dir}/${n}`, 0o755);
    put(`${dir}/${n}.cmd`, '@exit /b 0\r\n');
  }
  return dir;
}

function mkProject(config = CONFIG) {
  const root = tmp(), project = `${root}/proj`;
  if (config) put(`${project}/.forja/config.json`, config);
  else mkdirSync(project, { recursive: true });
  return { root, project };
}

function mkRepo() {
  const root = tmp(), origin = `${root}/origin.git`, project = `${root}/proj`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  put(`${project}/README.md`, 'a\n');
  g(project, 'init', '-q', '-b', 'main');
  g(project, 'add', '-A');
  g(project, 'commit', '-qm', 'Add base');
  g(project, 'remote', 'add', 'origin', origin);
  g(project, 'push', '-q', '-u', 'origin', 'main');
  put(`${project}/.forja/config.json`, { ...CONFIG, server: { port: 43100 + Math.floor(Math.random() * 800), host: '127.0.0.1' } });
  return { root, project };
}

const idle = ['-e', 'setInterval(() => {}, 1e3)'];
const serverOrIdle = (ctx, argv) => spawnDetached(process.execPath, argv[0].endsWith('server.mjs') ? argv : idle, { cwd: ctx.cfg.paths.project });
const gone = (p, ms = 3000) => new Promise(async r => { for (let i = 0; i < ms / 100 && alive(p.pid, p.startedAt, 'node'); i++) await new Promise(x => setTimeout(x, 100)); r(!alive(p.pid, p.startedAt, 'node')); });

function harness(extra = {}) {
  const logs = [], errs = [], ghCalls = [];
  const o = { log: s => logs.push(s), err: s => errs.push(s), home: tmp(), gh: (...a) => { ghCalls.push(a); return extra.ghOut?.(...a) ?? ''; }, ...extra };
  delete o.ghOut;
  return { o, logs, errs, ghCalls, text: () => [...logs, ...errs].join('\n') };
}

const ANSWERS = { repo: 'o/r', approvers: ['Owner'], language: 'en', vendors: { codex: true }, models: { spec: ['claude:sonnet'] }, checks: { test: 'npm test' }, deployTest: 'npm run deploy:test' };

test('init writes minimal config and gitignore line', async () => {
  const { project } = mkProject(null), H = harness();
  put(`${project}/.gitignore`, 'node_modules/');
  assert.equal(await run(['init', '--project', project, '--answers', JSON.stringify(ANSWERS), '--no-gh'], H.o), 0);
  assert.deepEqual(readJson(`${project}/.forja/config.json`), {
    repo: 'o/r', approvers: ['Owner'], vendors: { codex: { enabled: true } }, checks: { test: 'npm test', deployTest: 'npm run deploy:test' },
  });
  assert.equal(readFileSync(`${project}/.gitignore`, 'utf8'), 'node_modules/\n.forja/state/\n');
  assert.equal(H.ghCalls.length, 0);
  assert.equal(await run(['init', '--project', project, '--answers', JSON.stringify(ANSWERS), '--no-gh'], H.o), 0);
  assert.equal(readFileSync(`${project}/.gitignore`, 'utf8'), 'node_modules/\n.forja/state/\n');
});

test('init recognizes an existing rooted ignore line for the state folder', async () => {
  for (const line of ['/.forja/state/', '/.forja/state', '.forja/state']) {
    const { project } = mkProject(null), H = harness();
    put(`${project}/.gitignore`, `node_modules/\n${line}\n`);
    assert.equal(await run(['init', '--project', project, '--answers', JSON.stringify(ANSWERS), '--no-gh'], H.o), 0);
    assert.equal(readFileSync(`${project}/.gitignore`, 'utf8'), `node_modules/\n${line}\n`, line);
  }
});

test('init writes defaultBranch only when it is not main', async () => {
  const { project } = mkProject(null), H = harness();
  assert.equal(await run(['init', '--project', project, '--answers', JSON.stringify({ ...ANSWERS, defaultBranch: 'master' }), '--no-gh'], H.o), 0);
  assert.equal(readJson(`${project}/.forja/config.json`).defaultBranch, 'master');
  assert.equal(await run(['init', '--project', project, '--answers', JSON.stringify({ ...ANSWERS, defaultBranch: 'bad branch' }), '--no-gh'], H.o), 1);
});

test('detect reports the repo default branch, from origin/HEAD first and gh as the fallback', async () => {
  const { project } = mkProject(null), H = harness({ ghOut: (...a) => (a[0] === 'repo' ? 'trunk\n' : '') });
  g(project, 'init', '-q', '-b', 'master');
  g(project, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  H.o.env = { PATH: '' };
  assert.equal(await run(['detect', '--project', project], H.o), 0);
  assert.equal(JSON.parse(H.logs.join('\n')).defaultBranch, 'trunk');
  assert.deepEqual(H.ghCalls.find(a => a[0] === 'repo').slice(0, 3), ['repo', 'view', 'o/r']);
  g(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
  const H2 = harness({ ghOut: () => { throw new Error('offline'); } });
  H2.o.env = { PATH: '' };
  assert.equal(await run(['detect', '--project', project], H2.o), 0);
  assert.equal(JSON.parse(H2.logs.join('\n')).defaultBranch, 'master');
});

test('init reads an answers file and creates the labels', async () => {
  const { root, project } = mkProject(null), H = harness();
  put(`${root}/answers.json`, { repo: 'o/r', approvers: ['Owner'] });
  assert.equal(await run(['init', '--project', project, '--answers-file', `${root}/answers.json`], H.o), 0);
  assert.deepEqual(readJson(`${project}/.forja/config.json`), { repo: 'o/r', approvers: ['Owner'] });
  assert.equal(readFileSync(`${project}/.gitignore`, 'utf8'), '.forja/state/\n');
  assert.deepEqual(H.ghCalls.map(a => a[2]), ['forja', 'forja:spec', 'forja:build', 'forja:review', 'forja:needs-you', 'forja:done']);
  assert.ok(H.ghCalls.every(a => a[0] === 'label' && a[1] === 'create' && a.includes('--force') && a.includes('o/r')));
});

test('init rejects invalid answers without writing', async () => {
  const { project } = mkProject(null), H = harness();
  assert.equal(await run(['init', '--project', project, '--answers', JSON.stringify({ repo: 'o/r', approvers: [] }), '--no-gh'], H.o), 1);
  assert.match(H.text(), /approvers/);
  assert.equal(existsSync(`${project}/.forja/config.json`), false);
  assert.equal(existsSync(`${project}/.gitignore`), false);
  assert.equal(await run(['init', '--project', project, '--answers', JSON.stringify({ ...ANSWERS, bogus: 1 }), '--no-gh'], H.o), 2);
  assert.equal(await run(['init', '--project', project, '--answers', '{nope', '--no-gh'], H.o), 2);
  assert.equal(existsSync(`${project}/.forja/config.json`), false);
});

test('doctor fails on missing claude bin', async () => {
  const { project } = mkProject(), H = harness({ ghOut: () => "Token scopes: 'gist', 'repo'\n" });
  H.o.env = { PATH: fakeBin(tmp(), 'git', 'gh') };
  assert.equal(await run(['doctor', '--project', project], H.o), 1);
  assert.match(H.text(), /\[FAIL\] claude CLI not found/);
  assert.match(H.text(), /\[ok\] git is on PATH/);
  assert.match(H.text(), /\[ok\] gh is logged in/);
  assert.match(H.text(), /\[ok\] \.forja\/config\.json is valid/);
});

test('doctor passes with every tool present and fails on a missing check command', async () => {
  const { project } = mkProject(), H = harness({ ghOut: () => "Token scopes: 'repo'\n" });
  H.o.env = { PATH: fakeBin(tmp(), 'git', 'gh', 'claude', 'node') };
  assert.equal(await run(['doctor', '--project', project], H.o), 0, H.text());
  assert.match(H.text(), /All required checks passed/);

  put(`${project}/.forja/config.json`, { ...CONFIG, checks: { test: 'nonexistent-tool-xyz run' }, vendors: { codex: { enabled: true, bin: 'codex-missing' } } });
  const H2 = harness({ ghOut: () => '' });
  H2.o.env = H.o.env;
  assert.equal(await run(['doctor', '--project', project], H2.o), 1);
  assert.match(H2.text(), /\[FAIL\] checks\.test: nonexistent-tool-xyz was not found/);
  assert.match(H2.text(), /\[FAIL\] vendor codex is enabled but codex-missing was not found/);
});

test('doctor fails when gh is not logged in', async () => {
  const { project } = mkProject(), H = harness({ ghOut: () => { throw new Error('not logged in'); } });
  H.o.env = { PATH: fakeBin(tmp(), 'git', 'gh', 'claude') };
  assert.equal(await run(['doctor', '--project', project], H.o), 1);
  assert.match(H.text(), /\[FAIL\] gh is not logged in/);
});

test('detect reads package scripts', async () => {
  const { project } = mkProject(null), H = harness({ ghOut: (...a) => (a[0] === 'api' ? 'me\n' : "Token scopes: 'gist', 'repo'\n") });
  g(project, 'init', '-q', '-b', 'main');
  g(project, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  put(`${project}/package.json`, { scripts: { test: 'node --test', build: 'tsc' } });
  H.o.env = { PATH: fakeBin(tmp(), 'git', 'gh', 'codex') };
  assert.equal(await run(['detect', '--project', project], H.o), 0);
  const d = JSON.parse(H.logs.join('\n'));
  assert.deepEqual(d.scripts, { test: 'node --test', build: 'tsc' });
  assert.equal(d.repo, 'o/r');
  assert.equal(d.ghUser, 'me');
  assert.deepEqual(d.ghScopes, ['gist', 'repo']);
  assert.equal(d.node, process.versions.node);
  assert.deepEqual(Object.keys(d.clis), ['git', 'gh', 'claude', 'codex', 'gemini', 'agy', 'ollama', 'playwright']);
  assert.deepEqual([d.clis.git, d.clis.gh, d.clis.codex, d.clis.claude], [true, true, true, false]);
  assert.equal(d.config, null);
});

test('detect works on a bare folder', async () => {
  const { project } = mkProject(null), H = harness({ ghOut: () => { throw new Error('no gh'); } });
  H.o.env = { PATH: '' };
  assert.equal(await run(['detect', '--project', project], H.o), 0);
  const d = JSON.parse(H.logs.join('\n'));
  assert.deepEqual([d.repo, d.ghUser, d.ghScopes, d.scripts], [null, null, [], {}]);
});

test('start launches server and runner, status reads them, stop kills only them', async () => {
  const { root, project } = mkRepo();
  const launched = [], H = harness();
  H.o.launch = (ctx, argv) => {
    launched.push(argv);
    return spawnDetached(process.execPath, argv[0].endsWith('server.mjs') ? argv : ['-e', 'setInterval(() => {}, 1e3)'], { cwd: ctx.cfg.paths.project });
  };
  const state = `${project}/.forja/state`;
  try {
    assert.equal(await run(['start', '--project', project], H.o), 0, H.text());
    assert.match(H.text(), /Dashboard: http:\/\/127\.0\.0\.1:\d+\//);
    assert.ok(launched[0][0].endsWith('server.mjs') && launched[1][0].endsWith('runner.mjs'));
    assert.deepEqual(launched[1].slice(launched[1].indexOf('--every')), ['--every', '15']);
    const pids = readJson(`${state}/pids.json`), srv = readJson(`${state}/server.json`);
    assert.deepEqual(Object.keys(pids), ['server', 'runner']);
    assert.ok(alive(pids.server.pid, pids.server.startedAt, 'node') && alive(pids.runner.pid, pids.runner.startedAt, 'node'));
    assert.ok(srv.port >= 1 && srv.host === '127.0.0.1');

    const again = harness({ launch: H.o.launch });
    assert.equal(await run(['start', '--project', project], again.o), 0);
    assert.match(again.text(), /already running/);
    assert.equal(launched.length, 2);

    put(`${state}/runner.json`, { pid: pids.runner.pid, at: new Date().toISOString(), error: null, waiting: [{ issue: 3, stage: 'build', on: 'quota' }], quota: { claude: { h5: 2, week: 9, limitedUntil: null } } });
    put(`${state}/board.json`, { jobs: [{ issue: 3, stage: 'build' }, { issue: 4, stage: 'needs-you', title: 'Add x' }] });
    const st = harness({ launch: H.o.launch });
    assert.equal(await run(['status', '--project', project], st.o), 0);
    assert.match(st.text(), /Runner: running, heartbeat \d+s ago/);
    assert.match(st.text(), /Dashboard: http/);
    assert.match(st.text(), /#3 build on quota/);
    assert.match(st.text(), /Quota claude: 2 calls in 5 h, 9 in 7 d/);
    assert.match(st.text(), /Jobs: build 1, needs-you 1/);
    assert.match(st.text(), /Needs you: #4 \(needs-you\) Add x/);

    const stop = harness({ launch: H.o.launch });
    assert.equal(await run(['stop', '--project', project], stop.o), 0);
    assert.match(stop.text(), /Stopped server/);
    assert.match(stop.text(), /Stopped runner/);
    assert.equal(alive(pids.server.pid, pids.server.startedAt, 'node'), false);
    assert.equal(alive(pids.runner.pid, pids.runner.startedAt, 'node'), false);
    assert.equal(existsSync(`${state}/pids.json`), false);
    const down = harness({ launch: H.o.launch });
    assert.equal(await run(['stop', '--project', project], down.o), 0);
    assert.match(down.text(), /server is not running/);
  } finally {
    await run(['stop', '--project', project], harness().o);
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('stop leaves a pid alone when its identity does not match', async () => {
  const { project } = mkProject(), H = harness(), state = `${project}/.forja/state`;
  const c = spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1e3)']);
  try {
    put(`${state}/pids.json`, { server: { pid: c.pid, startedAt: '2001-01-01T00:00:00.000Z' }, runner: { pid: c.pid, startedAt: '2001-01-01T00:00:00.000Z' } });
    assert.equal(await run(['stop', '--project', project], H.o), 0);
    assert.match(H.text(), /server is not running/);
    assert.ok(alive(c.pid, new Date().toISOString(), 'node'));
  } finally { process.kill(c.pid); }
});

test('unknown command prints usage', async () => {
  const H = harness();
  assert.equal(await run(['nope', '--project', REPO], H.o), 2);
  assert.match(H.text(), /usage/);
});

test('stop kills the runner and its launcher but leaves the agents it started', async () => {
  const { root, project } = mkRepo(), H = harness(), state = `${project}/.forja/state`, childFile = `${root}/child.pid`;
  const script = `const fs=require('fs'),{spawn}=require('child_process');fs.writeFileSync(${JSON.stringify(`${state}/.runner.lock`)},String(process.pid));const c=spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{detached:true,stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(childFile)},String(c.pid));c.unref();setInterval(()=>{},1e3)`;
  H.o.launch = (ctx, argv) => {
    if (argv[0].endsWith('server.mjs')) return serverOrIdle(ctx, argv);
    const c = spawn(process.execPath, [`${REPO}/engine/runner.mjs`, '--launch', '-e', script], { detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
    return c;
  };
  let child;
  try {
    assert.equal(await run(['start', '--project', project], H.o), 0, H.text());
    for (let i = 0; i < 100 && !existsSync(childFile); i++) await new Promise(r => setTimeout(r, 50));
    child = { pid: Number(readFileSync(childFile, 'utf8')), startedAt: new Date(Date.now() - 5000).toISOString() };
    const pids = readJson(`${state}/pids.json`), realPid = Number(readFileSync(`${state}/.runner.lock`, 'utf8'));
    assert.notEqual(realPid, pids.runner.pid);
    assert.equal(await run(['stop', '--project', project], harness().o), 0);
    assert.equal(await gone(pids.runner), true);
    assert.equal(await gone({ pid: realPid, startedAt: pids.runner.startedAt }), true);
    assert.equal(alive(child.pid, child.startedAt, 'node'), true);
    assert.equal(existsSync(`${state}/.runner.lock`), false);
  } finally {
    if (child) killTree(child.pid);
    await run(['stop', '--project', project], harness().o);
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('start restarts only the process that is down', async () => {
  const { root, project } = mkRepo(), H = harness(), state = `${project}/.forja/state`, launched = [];
  H.o.launch = (ctx, argv) => { launched.push(argv[0]); return serverOrIdle(ctx, argv); };
  try {
    assert.equal(await run(['start', '--project', project], H.o), 0, H.text());
    const before = readJson(`${state}/pids.json`);
    killTree(before.server.pid);
    assert.equal(await gone(before.server), true);
    assert.equal(await run(['start', '--project', project], harness({ launch: H.o.launch }).o), 0);
    const after = readJson(`${state}/pids.json`);
    assert.deepEqual(launched.map(f => f.replaceAll('\\', '/').split('/').pop()), ['server.mjs', 'runner.mjs', 'server.mjs']);
    assert.deepEqual(after.runner, before.runner);
    assert.notEqual(after.server.pid, before.server.pid);
    assert.equal(alive(after.runner.pid, after.runner.startedAt, 'node'), true);
  } finally {
    await run(['stop', '--project', project], harness().o);
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('start cleans up what it launched when the server never comes up', async () => {
  const { root, project } = mkRepo(), H = harness({ startWaitMs: 300 }), state = `${project}/.forja/state`, spawned = [];
  H.o.launch = (ctx, argv) => {
    const c = spawnDetached(process.execPath, argv[0].endsWith('server.mjs') ? ['-e', '0'] : idle, { cwd: ctx.cfg.paths.project });
    spawned.push({ pid: c.pid, startedAt: new Date().toISOString() });
    return c;
  };
  try {
    assert.equal(await run(['start', '--project', project], H.o), 1);
    assert.match(H.text(), /did not start/);
    assert.equal(existsSync(`${state}/pids.json`), false);
    assert.equal(await gone(spawned[1]), true);
  } finally {
    for (const p of spawned) killTree(p.pid);
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('init merges the answers onto an existing config', async () => {
  const { project } = mkProject({ ...CONFIG, language: 'pt-BR', limits: { rounds: 5 }, models: { spec: ['claude:opus'] } }), H = harness();
  const answers = { repo: 'o/r', approvers: ['Owner', 'Two'], language: 'en', checks: { test: 'npm test' } };
  assert.equal(await run(['init', '--project', project, '--answers', JSON.stringify(answers), '--no-gh'], H.o), 0);
  assert.deepEqual(readJson(`${project}/.forja/config.json`), { repo: 'o/r', approvers: ['Owner', 'Two'], checks: { test: 'npm test' }, limits: { rounds: 5 }, models: { spec: ['claude:opus'] } });
});
