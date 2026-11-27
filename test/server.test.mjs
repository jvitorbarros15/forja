// The dashboard server on ephemeral ports, with gh and triage injected; nothing touches the network.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../engine/config.mjs';
import { serve } from '../engine/server.mjs';
import { paths } from '../engine/state.mjs';

const REPO = resolve(import.meta.dirname, '..').replaceAll('\\', '/');
const put = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };

function mkEnv(config = {}) {
  const project = mkdtempSync(`${tmpdir()}/forja-srv-`).replaceAll('\\', '/');
  put(`${project}/.forja/config.json`, { repo: 'o/r', approvers: ['Owner'], ...config });
  const cfg = loadConfig(project, { pluginRoot: REPO });
  return { project, cfg, P: paths(cfg) };
}

const call = (port, method, path, { body, headers = {}, host = '127.0.0.1' } = {}) => new Promise((ok, no) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host, port, method, path, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
    let text = '';
    res.on('data', c => { text += c; });
    res.on('end', () => ok({ status: res.statusCode, text, json: () => JSON.parse(text) }));
  });
  r.on('error', no);
  r.end(data);
});

async function withServer(config, opts, fn) {
  const E = mkEnv(config), s = await serve(E.cfg, { port: 0, ...opts });
  try { await fn(s, E); } finally { await s.close(); }
}

test('server falls back to next free port', async () => {
  const E = mkEnv(), blocker = net.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port, s = await serve(E.cfg, { port: busy });
  try {
    assert.ok(s.port > busy && s.port <= busy + 20, `port ${s.port} for busy ${busy}`);
    const info = JSON.parse(readFileSync(`${E.cfg.paths.state}/server.json`, 'utf8'));
    assert.deepEqual(Object.keys(info), ['pid', 'port', 'host', 'startedAt']);
    assert.equal(info.pid, process.pid);
    assert.equal(info.port, s.port);
    assert.equal(info.host, '127.0.0.1');
    assert.equal((await call(s.port, 'GET', '/api/jobs')).status, 200);
  } finally { await s.close(); blocker.close(); }
  assert.equal(existsSync(`${E.cfg.paths.state}/server.json`), false);
});

test('api/config hides nothing secret and lists tiers', async () => {
  const config = { vendors: { codex: { enabled: true, bin: '/secret/bin/codex' } }, privacy: { denyRead: ['**/.env*'], promptRules: ['no secrets'] }, reviewers: { a11y: { agent: 'x.md' } } };
  await withServer(config, {}, async (s, E) => {
    const r = await call(s.port, 'GET', '/api/config'), c = r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(c), ['repo', 'approvers', 'language', 'defaultBranch', 'deploy', 'tiers', 'reviewKinds', 'vendors', 'strings']);
    assert.equal(c.repo, 'o/r');
    assert.deepEqual([c.defaultBranch, c.deploy], ['main', false]);
    assert.deepEqual(c.approvers, ['Owner']);
    assert.deepEqual(c.tiers.map(x => Object.keys(x)), [['id', 'describe', 'approval'], ['id', 'describe', 'approval'], ['id', 'describe', 'approval']]);
    assert.deepEqual(c.tiers.map(x => x.id), ['A', 'B', 'C']);
    assert.ok(c.reviewKinds.includes('security') && c.reviewKinds.includes('a11y'));
    assert.deepEqual(c.vendors, ['claude', 'codex']);
    assert.equal(typeof c.strings, 'object');
    assert.doesNotMatch(JSON.stringify({ ...c, strings: undefined }), /denyRead|promptRules|no secrets|token|\/secret\/bin/i);
  });
  await withServer({ defaultBranch: 'trunk', checks: { deploy: 'npm run ship' } }, {}, async s => {
    const c = (await call(s.port, 'GET', '/api/config')).json();
    assert.deepEqual([c.defaultBranch, c.deploy], ['trunk', true]);
    assert.doesNotMatch(JSON.stringify(c), /npm run ship/);
  });
});

test('post command from foreign origin is refused', async () => {
  await withServer({}, {}, async (s, E) => {
    const body = { jobId: '5', action: 'approve' }, mine = `http://127.0.0.1:${s.port}`;
    const foreign = await call(s.port, 'POST', '/api/commands', { body, headers: { origin: 'http://evil.example' } });
    assert.equal(foreign.status, 403);
    const cross = await call(s.port, 'POST', '/api/commands', { body, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(cross.status, 403);
    const host = await call(s.port, 'GET', '/api/jobs', { headers: { host: 'evil.example' } });
    assert.equal(host.status, 403);
    assert.equal(existsSync(E.P.commands), false);

    const ok = await call(s.port, 'POST', '/api/commands', { body: { ...body, note: 'go' }, headers: { origin: mine } });
    assert.equal(ok.status, 201);
    const [c] = JSON.parse(readFileSync(E.P.commands, 'utf8'));
    assert.deepEqual({ ...c, at: 0, id: 0 }, { id: 0, jobId: '5', action: 'approve', note: 'go', status: 'pending', at: 0 });
    const again = await call(s.port, 'POST', '/api/commands', { body, headers: { origin: mine } });
    assert.deepEqual(again.json(), { id: c.id, deduped: true });
    assert.equal((await call(s.port, 'POST', '/api/commands', { body: { jobId: '5', action: 'aprovar' }, headers: { origin: mine } })).status, 400);
    assert.equal((await call(s.port, 'POST', '/api/commands', { body: { jobId: '../x', action: 'redo' }, headers: { origin: mine } })).status, 400);
  });
});

test('serves the page, job docs and runner heartbeat', async () => {
  const page = `${mkdtempSync(`${tmpdir()}/forja-page-`)}/index.html`;
  writeFileSync(page, '<h1>hi</h1>');
  await withServer({}, { page }, async (s, E) => {
    put(`${E.P.docs}/7.json`, { issue: 7, stage: 'build' });
    put(E.P.runner, { pid: process.pid, at: new Date().toISOString(), waiting: [] });
    const home = await call(s.port, 'GET', '/');
    assert.equal(home.status, 200);
    assert.equal(home.text, '<h1>hi</h1>');
    assert.deepEqual((await call(s.port, 'GET', '/api/jobs')).json(), [{ issue: 7, stage: 'build' }]);
    assert.equal((await call(s.port, 'GET', '/api/runner')).json().alive, true);
    assert.equal((await call(s.port, 'GET', '/api/nope')).status, 404);
  });
  await withServer({}, { page: `${page}.missing` }, async s => assert.equal((await call(s.port, 'GET', '/')).status, 404));
});

test('issues, queue and triage go through the injected gh and triage', async () => {
  const calls = [], list = [
    { number: 7, title: 'Add search', body: 'Depends on: #3', updatedAt: '2026-01-02', labels: [{ name: 'bug' }] },
    { number: 8, title: 'Add export', body: '', updatedAt: '2026-01-01', labels: [{ name: 'forja' }] },
  ];
  const gh = async args => {
    calls.push(args);
    if (args[1] === 'list' && args.includes('--search')) return '[]';
    if (args[1] === 'list') return JSON.stringify(list);
    if (args[1] === 'create') return 'https://github.com/o/r/issues/42\n';
    throw new Error('unexpected');
  };
  const triage = async text => ({ tier: text.startsWith('Add search') ? 'B' : 'A', bucket: 'factory', reason: 'r' });
  await withServer({}, { gh, triage }, async (s, E) => {
    const og = { origin: `http://127.0.0.1:${s.port}` };
    const view = (await call(s.port, 'GET', '/api/issues')).json();
    assert.deepEqual(view.items.map(i => [i.number, i.state]), [[7, 'free'], [8, 'forja']]);
    assert.equal((await call(s.port, 'POST', '/api/queue', { body: { number: 8, action: 'add' }, headers: og })).status, 409);
    assert.equal((await call(s.port, 'POST', '/api/queue', { body: { number: 99, action: 'add' }, headers: og })).status, 404);
    const q = await call(s.port, 'POST', '/api/queue', { body: { number: 7, action: 'add' }, headers: og });
    assert.equal(q.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(E.P.queue, 'utf8')), [7]);
    assert.deepEqual(q.json().items.map(i => [i.number, i.deps]), [[7, [{ n: 3, open: false }]]]);
    assert.equal((await call(s.port, 'GET', '/api/issues')).json().items[0].state, 'queue');

    const t = await call(s.port, 'POST', '/api/triage', { body: { title: 'Add search', body: 'x' }, headers: og });
    assert.equal(t.json().tier, 'B');
    const made = await call(s.port, 'POST', '/api/issues', { body: { title: 'Add dark mode', body: 'please', intake: true }, headers: og });
    assert.deepEqual(made.json(), { number: 42, url: 'https://github.com/o/r/issues/42' });
    assert.ok(calls.some(a => a[1] === 'create' && a.includes('--label') && a.includes('forja')));
    assert.equal((await call(s.port, 'POST', '/api/issues', { body: { title: 'short', body: '', intake: true }, headers: og })).status, 400);
  });
});

test('every POST route refuses a foreign origin before touching gh or state', async () => {
  const calls = [];
  await withServer({}, { gh: async a => { calls.push(a); return '[]'; }, triage: async () => ({ tier: 'A' }) }, async (s, E) => {
    const headers = { origin: 'http://evil.example' };
    const bodies = { '/api/queue': { number: 7, action: 'add' }, '/api/issues': { title: 'Add dark mode', body: '', intake: true }, '/api/triage': { title: 'Add dark mode' }, '/api/commands': { jobId: '5', action: 'approve' } };
    for (const [path, body] of Object.entries(bodies)) assert.equal((await call(s.port, 'POST', path, { body, headers })).status, 403, path);
    assert.equal((await call(s.port, 'POST', '/api/queue', { body: bodies['/api/queue'], headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(E.P.queue), false);
    assert.equal(existsSync(E.P.commands), false);
  });
});

test('post body over the cap is refused with 413', async () => {
  await withServer({}, {}, async (s, E) => {
    const headers = { origin: `http://127.0.0.1:${s.port}` };
    const big = await call(s.port, 'POST', '/api/commands', { body: { jobId: '5', action: 'redo', note: 'x'.repeat(5000) }, headers });
    assert.equal(big.status, 413);
    assert.equal(existsSync(E.P.commands), false);
    const bigQueue = await call(s.port, 'POST', '/api/queue', { body: { number: 1, action: 'add', pad: 'x'.repeat(5000) }, headers });
    assert.equal(bigQueue.status, 413);
    assert.equal((await call(s.port, 'POST', '/api/commands', { body: { jobId: '5', action: 'redo', note: 'ok' }, headers })).status, 201);
  });
});

test('a non-local host requires the token', async t => {
  const E = mkEnv();
  let s;
  try { s = await serve(E.cfg, { port: 0, host: '127.0.0.2' }); } catch (e) { if (e.code === 'EADDRNOTAVAIL') return t.skip('127.0.0.2 is not available here'); throw e; }
  try {
    const at = (path, o = {}) => call(s.port, o.method ?? 'GET', path, { host: '127.0.0.2', ...o });
    assert.match(s.token, /^[0-9a-f]{48}$/);
    assert.equal(readFileSync(`${E.cfg.paths.state}/.server-token`, 'utf8').trim(), s.token);
    assert.equal((await at('/api/jobs')).status, 401);
    assert.equal((await at('/api/jobs?t=wrong')).status, 401);
    assert.equal((await at('/api/jobs', { headers: { 'x-forja-token': 'wrong' } })).status, 401);
    assert.equal((await at('/api/events')).status, 401);
    assert.equal((await at(`/api/jobs?t=${s.token}`)).status, 200);
    assert.equal((await at('/api/jobs', { headers: { 'x-forja-token': s.token } })).status, 200);
    const body = { jobId: '5', action: 'approve' };
    assert.equal((await at('/api/commands', { method: 'POST', body })).status, 401);
    assert.equal((await at('/api/commands', { method: 'POST', body, headers: { 'x-forja-token': s.token, origin: 'http://evil.example' } })).status, 403);
    assert.equal((await at('/api/commands', { method: 'POST', body, headers: { 'x-forja-token': s.token, origin: `http://127.0.0.2:${s.port}` } })).status, 201);
  } finally { await s.close(); }
});

test('a board lock held too long answers 503 and the server keeps running', async () => {
  await withServer({}, {}, async (s, E) => {
    put(`${E.P.commands}.lock`, '');
    const r = await call(s.port, 'POST', '/api/commands', { body: { jobId: '5', action: 'approve' } });
    assert.equal(r.status, 503);
    assert.match(r.json().error, /busy/i);
    assert.equal((await call(s.port, 'GET', '/api/jobs')).status, 200);
  });
});
