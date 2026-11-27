// Local dashboard server: node:http only, no dependencies.
//   node server.mjs --project <dir> [--port 4317] [--host 127.0.0.1]
// A non-local host requires the token in state/.server-token. A busy port moves up to the next free one (20 tries).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strings, t } from './i18n.mjs';
import { alive } from './platform.mjs';
import { loadProjectConfig } from './config.mjs';
import { locked, paths, read, readJson, writeJson } from './state.mjs';
import { ID_RE } from './tick.mjs';
import { chat } from './triage.mjs';

const SELF = fileURLToPath(import.meta.url), PAGE = fileURLToPath(new URL('./dashboard/index.html', import.meta.url));
const ACTIONS = ['approve', 'redo', 'deploy', 'deploy-test', 'pause', 'resume'], MAX_BODY = 4096, MAX_NOTE = 500, MAX_ISSUE_BODY = 64 * 1024;
const QUEUE_ACTIONS = ['add', 'remove', 'up', 'down'], LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'], LIST_TTL = 10 * 60e3, PORT_TRIES = 20;
const RUNS = { 'run-deploy.json': 'deploy', 'run-deploy-test.json': 'test' };

const rj = (p, d) => { try { return readJson(p, d); } catch { return d; } };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const shown = host => (host.includes(':') ? `[${host}]` : host);
const defaultGh = args => new Promise((ok, no) => execFile('gh', args, { timeout: 60e3, windowsHide: true, maxBuffer: 1 << 20 }, (e, out, err) => (e ? no(new Error(String(err || e.message).trim().slice(0, 300))) : ok(String(out).trim()))));
const snippet = b => String(b ?? '').replace(/<[^>]*>|[`#*>_\[\]]/g, ' ').replace(/[\x00-\x1f\x7f]+|\s+/g, ' ').trim().slice(0, 200);

export function dashboardUrl(state) {
  const s = rj(`${state}/server.json`, null);
  if (!s) return null;
  const token = LOCAL_HOSTS.includes(s.host) ? '' : read(`${state}/.server-token`).trim();
  return `http://${shown(['0.0.0.0', '::'].includes(s.host) ? 'localhost' : s.host)}:${s.port}/${token ? `?t=${token}` : ''}`;
}

export async function serve(cfg, o = {}) {
  const P = paths(cfg), state = cfg.paths.state, L = (k, v) => t(cfg.language, k, v), R = cfg.repo;
  const host = o.host ?? cfg.server.host, local = LOCAL_HOSTS.includes(host), gh = o.gh ?? defaultGh, page = o.page ?? PAGE;
  const triageOn = !!(o.triage || (cfg.vendors.ollama?.enabled && cfg.vendors.ollama.triageModel));
  const decide = o.triage ?? ((text, signal) => chat(cfg, text, signal));
  const runFile = f => `${state}/${f}`, QUEUE_MAX = cfg.queue.max, TCACHE = `${state}/triage-cache.json`;
  mkdirSync(P.docs, { recursive: true });

  let token = null;
  if (!local) {
    const file = `${state}/.server-token`;
    token = read(file).trim() || null;
    if (!token) { token = randomBytes(24).toString('hex'); writeFileSync(file, `${token}\n`); }
  }

  const jobs = () => readdirSync(P.docs).filter(f => f.endsWith('.json')).map(f => rj(`${P.docs}/${f}`, null)).filter(Boolean);
  const commands = () => { const c = rj(P.commands, []); return Array.isArray(c) ? c : []; };
  const runner = () => {
    const r = rj(P.runner, null);
    return r ? { ...r, alive: alive(r.pid, r.at, 'node') } : null;
  };
  // What the page may know about the last deploy and the last deploy test: the plain note, never the raw output kept in `detail`.
  const deploys = () => Object.fromEntries(Object.entries(RUNS).map(([file, key]) => {
    const r = rj(runFile(file), null);
    return [key, r && { status: r.status, startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null, note: String(r.note ?? '').slice(0, 600), ids: (r.ids ?? (r.of ? [r.of] : r.issues ?? [])).map(String), tries: r.tries ?? 1, transient: !!r.transient }];
  }));
  const config = () => ({
    repo: R, approvers: cfg.approvers, language: cfg.language, defaultBranch: cfg.defaultBranch, deploy: !!cfg.checks.deploy,
    tiers: cfg.tiers.map(x => ({ id: x.id, describe: x.describe, approval: x.approval })),
    reviewKinds: Object.keys(cfg.models.review),
    vendors: ['claude', ...Object.entries(cfg.vendors).filter(([, v]) => v.enabled).map(([n]) => n)],
    strings: strings(cfg.language, 'ui.'),
  });

  function addCommand(body) {
    const jobId = String(body?.jobId ?? '').trim(), action = body?.action;
    if (!ID_RE.test(jobId)) return [400, { error: L('server.badJob') }];
    if (!ACTIONS.includes(action)) return [400, { error: L('server.badAction', { actions: ACTIONS.join('|') }) }];
    const note = String(body.note ?? '').slice(0, MAX_NOTE);
    return locked(P.commands, () => {
      const all = commands(), dup = all.find(c => c.status === 'pending' && String(c.jobId) === jobId && c.action === action);
      if (dup) return [200, { id: dup.id, deduped: true }];
      let ms = Date.now(), id = `local-${ms}`;
      while (all.some(c => c.id === id)) id = `local-${++ms}`;
      all.push({ id, jobId, action, note, status: 'pending', at: new Date(ms).toISOString() });
      writeJson(P.commands, all);
      return [201, { id }];
    });
  }

  const creating = new Set();
  async function createIssue(body) {
    const title = typeof body?.title === 'string' ? body.title.trim() : '', text = typeof body?.body === 'string' ? body.body : '';
    if (title.length < 8 || title.length > 120) return [400, { error: L('server.titleLen') }];
    if ([...title].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 0x2028 || c.charCodeAt(0) === 0x2029)) return [400, { error: L('server.titleLine') }];
    if (text.length > 8000) return [400, { error: L('server.bodyLen') }];
    if (typeof body.intake !== 'boolean') return [400, { error: L('server.intakeBool') }];
    if (creating.has(title)) return [409, { error: L('server.creating') }];
    creating.add(title);
    try {
      const found = JSON.parse((await gh(['issue', 'list', '-R', R, '--state', 'open', '--search', `"${title.replace(/"/g, ' ')}" in:title`, '--json', 'number,title,url', '--limit', '30']).catch(() => '[]')) || '[]');
      const dup = found.find(i => i.title === title);
      if (dup) return [200, { number: dup.number, url: dup.url, deduped: true }];
      const dir = mkdtempSync(`${tmpdir()}/forja-issue-`), file = `${dir}/body.md`;
      try {
        writeFileSync(file, text, 'utf8');
        const out = await gh(['issue', 'create', '-R', R, '--title', title, '--body-file', file, ...(body.intake ? ['--label', cfg.intakeLabel] : [])]);
        const url = out.split(/\s+/).find(w => /^https:\/\/github\.com\/.+\/issues\/\d+$/.test(w));
        if (!url) return [502, { error: L('server.noIssueUrl') }];
        return [201, { number: Number(url.split('/').pop()), url }];
      } finally { rmSync(dir, { recursive: true, force: true }); }
    } catch (e) {
      return [502, { error: L('server.ghIssueFail', { why: e.message || 'gh' }) }];
    } finally { creating.delete(title); }
  }

  const queueIds = () => { const q = rj(P.queue, []); return Array.isArray(q) ? q.filter(n => Number.isInteger(n) && n > 0) : []; };
  const saveQueue = q => locked(P.queue, () => writeJson(P.queue, q));
  const factoryIssues = () => new Set(rj(P.board, { jobs: [] }).jobs.filter(j => Number.isInteger(Number(j.issue)) && !['merged', 'deployed'].includes(j.stage)).map(j => Number(j.issue)));
  const inFactory = i => i.labels.some(l => l === cfg.intakeLabel || l.startsWith('forja:'));

  let list = { at: 0, byNum: new Map() }, listing = null;
  function openIssues(force) {
    if (!force && Date.now() - list.at < LIST_TTL) return Promise.resolve(list.byNum);
    listing ??= gh(['issue', 'list', '-R', R, '--state', 'open', '--limit', '500', '--json', 'number,title,body,updatedAt,labels'])
      .then(out => {
        const byNum = new Map(JSON.parse(out).map(i => [i.number, { number: i.number, title: i.title, body: i.body ?? '', updatedAt: i.updatedAt, labels: i.labels.map(l => String(l.name).slice(0, 40)).slice(0, 8), deps: [...(i.body?.match(/^Depends on: (.+)$/m)?.[1] ?? '').matchAll(/#(\d+)/g)].map(m => Number(m[1])) }]));
        list = { at: Date.now(), byNum };
        return byNum;
      })
      .catch(e => { if (!list.at) throw e; list.at = Date.now() - LIST_TTL + 30e3; return list.byNum; })
      .finally(() => { listing = null; });
    return listing;
  }

  let tcache = rj(TCACHE, {}), tchain = Promise.resolve(), tFailedAt = 0;
  const tpending = new Set();
  function triageFor(i) {
    if (!triageOn) return null;
    const c = tcache[i.number];
    if (c && c.updatedAt === i.updatedAt) return c;
    if (!tpending.has(i.number) && Date.now() - tFailedAt > 60e3) {
      tpending.add(i.number);
      tchain = tchain.then(async () => {
        try {
          const r = await decide(`${i.title}\n\n${i.body}`.slice(0, 8000));
          if (!r || r.tier === '?') throw new Error('no triage');
          tcache = Object.fromEntries(Object.entries({ ...tcache, [i.number]: { updatedAt: i.updatedAt, tier: r.tier, bucket: r.bucket, reason: r.reason } }).filter(([n]) => list.byNum.has(Number(n))));
          writeJson(TCACHE, tcache);
        } catch { tFailedAt = Date.now(); } finally { tpending.delete(i.number); }
        send('queue', {});
      });
    }
    return null;
  }

  async function queueView() {
    let issues, warn = null;
    try { issues = await openIssues(); } catch { issues = new Map(); warn = L('server.ghDown'); }
    const items = queueIds().map(number => {
      const i = issues.get(number);
      if (!i) return { number, title: null, closed: !warn, deps: [], ready: true, triage: null, triagePending: false };
      const triage = triageFor(i), deps = i.deps.map(n => ({ n, open: issues.has(n) }));
      return { number, title: i.title, closed: false, deps, ready: !deps.some(d => d.open), triage: triage && { tier: triage.tier, bucket: triage.bucket }, triagePending: !triage && tpending.has(number) };
    });
    return { items, inFactory: factoryIssues().size, max: QUEUE_MAX, warn };
  }

  async function mutateQueue(body) {
    const n = body?.number, action = body?.action;
    if (!Number.isInteger(n) || n < 1 || n > 1e7) return [400, { error: L('server.badNumber') }];
    if (!QUEUE_ACTIONS.includes(action)) return [400, { error: L('server.badQueueAction') }];
    const idx = body?.index;
    if (idx !== undefined && (action !== 'add' || !Number.isInteger(idx) || idx < 0 || idx > 1e4)) return [400, { error: L('server.badIndex') }];
    if (action === 'add') {
      if (queueIds().includes(n)) return [409, { error: L('server.inQueue', { n }) }];
      let i;
      try { i = (await openIssues()).get(n) ?? (await openIssues(true)).get(n); } catch { return [502, { error: L('server.ghCheck') }]; }
      if (!i) return [404, { error: L('server.noIssue', { n }) }];
      if (inFactory(i)) return [409, { error: L('server.inFactory', { n, label: cfg.intakeLabel }) }];
    }
    const q = queueIds(), at = q.indexOf(n);
    if (action === 'add') { if (at < 0) q.splice(idx === undefined ? q.length : Math.min(idx, q.length), 0, n); }
    else if (at < 0) return action === 'remove' ? [200, await queueView()] : [404, { error: L('server.notInQueue', { n }) }];
    else if (action === 'remove') q.splice(at, 1);
    else { const to = at + (action === 'up' ? -1 : 1); if (to >= 0 && to < q.length) [q[at], q[to]] = [q[to], q[at]]; }
    saveQueue(q);
    return [200, await queueView()];
  }

  async function issuesView(refresh) {
    let issues, warn = null;
    try { issues = await openIssues(refresh); } catch { return [502, { error: L('server.ghList') }]; }
    if (refresh && list.at < Date.now() - LIST_TTL + 60e3) warn = L('server.ghStale');
    const queued = new Set(queueIds()), running = factoryIssues();
    const items = [...issues.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(i => {
      const c = tcache[i.number], triage = c && c.updatedAt === i.updatedAt ? { tier: c.tier, bucket: c.bucket } : null;
      const st = inFactory(i) || running.has(i.number) ? 'forja' : queued.has(i.number) ? 'queue' : 'free';
      return { number: i.number, title: i.title, labels: i.labels, updatedAt: i.updatedAt, state: st, snippet: snippet(i.body), triage };
    });
    return [200, { items, at: new Date(list.at).toISOString(), warn }];
  }

  const triaging = new Map();
  async function triageHttp(body, req, res) {
    const title = typeof body?.title === 'string' ? body.title.trim() : '', text = typeof body?.body === 'string' ? body.body : '';
    if (!title) return [400, { error: L('server.noTitle') }];
    if (title.length + text.length > 8000) return [400, { error: L('server.textBig') }];
    if (!triageOn) return [200, { tier: '?' }];
    const who = req.socket.remoteAddress ?? '?', ac = new AbortController(), t0 = Date.now();
    triaging.get(who)?.abort();
    triaging.set(who, ac);
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const r = await decide(`${title}\n\n${text}`, AbortSignal.any([ac.signal, AbortSignal.timeout(20e3)]));
      return [200, r ? { tier: r.tier, bucket: r.bucket, reason: r.reason, ms: Date.now() - t0 } : { tier: '?' }];
    } catch { return [200, { tier: '?' }]; } finally { if (triaging.get(who) === ac) triaging.delete(who); }
  }

  let origins = [];
  function postJson(req, res, max, handle) {
    const og = req.headers.origin;
    const sameOrigin = og && token && (() => { try { return new URL(og).host === req.headers.host; } catch { return false; } })();
    if (og && !origins.includes(og) && !sameOrigin) return json(res, 403, { error: L('server.badOrigin') });
    if (!og && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return json(res, 403, { error: L('server.badOrigin') });
    if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: L('server.needJson') });
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size <= max) return chunks.push(c);
      // The answer goes out first and the rest is discarded up to a limit: destroying at once can reset the connection before the client reads the 413.
      if (!res.headersSent) { res.setHeader('connection', 'close'); json(res, 413, { error: L('server.tooBig') }); }
      if (size > max * 16) req.destroy();
    });
    req.on('end', async () => {
      if (size > max) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: L('server.badJson') }); }
      // A throw here (a board lock held too long, a disk error) must answer, not become an unhandled rejection that ends the server.
      let code, out;
      try { [code, out] = await handle(body, req, res); } catch (e) { [code, out] = /lock busy/.test(e?.message) ? [503, { error: L('server.busy') }] : [500, { error: L('server.failed') }]; }
      if (!res.headersSent) json(res, code, out);
    });
  }

  const clients = new Set();
  const send = (event, data) => { for (const r of clients) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  const watched = ['board.json', 'commands.json', 'runner.json', 'queue.json', ...Object.keys(RUNS)], changed = new Set(), watchers = [];
  let timer = null;
  function flush() {
    timer = null;
    const files = [...changed]; changed.clear();
    for (const f of files) {
      if (f === 'board.json') send('board', {});
      else if (f === 'queue.json') send('queue', {});
      else if (f === 'commands.json') send('commands', commands());
      else if (f === 'runner.json') send('runner', runner());
      else if (RUNS[f]) send('deploy', deploys());
      else if (f.endsWith('.json')) { const d = rj(`${P.docs}/${f}`, null); if (d) send('job', d); }
    }
  }
  const bump = f => { if (f) { changed.add(String(f)); timer ??= setTimeout(flush, 150); } };
  watchers.push(watch(P.docs, (_, f) => bump(f)), watch(state, (_, f) => { if (watched.includes(f)) bump(f); }));
  const ping = setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 25e3);
  ping.unref();

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (local) {
      const h = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(h)) return json(res, 403, { error: L('server.badHost') });
    }
    if (token && url.searchParams.get('t') !== token && req.headers['x-forja-token'] !== token) return json(res, 401, { error: L('server.token') });
    const get = req.method === 'GET', is = p => url.pathname === p;

    if (get && (is('/') || is('/index.html'))) {
      if (!existsSync(page)) return json(res, 404, { error: L('server.notFound') });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync(page));
    }
    if (get && is('/api/config')) return json(res, 200, config());
    if (get && is('/api/jobs')) return json(res, 200, jobs());
    if (get && is('/api/commands')) return json(res, 200, commands());
    if (get && is('/api/runner')) return json(res, 200, runner());
    if (get && is('/api/deploy')) return json(res, 200, deploys());
    if (get && is('/api/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (get && is('/api/issues')) return issuesView(url.searchParams.get('refresh') === '1').then(([c, b]) => json(res, c, b));
    if (get && is('/api/queue')) return queueView().then(v => json(res, 200, v));
    if (req.method === 'POST' && is('/api/commands')) return postJson(req, res, MAX_BODY, addCommand);
    if (req.method === 'POST' && is('/api/issues')) return postJson(req, res, MAX_ISSUE_BODY, createIssue);
    if (req.method === 'POST' && is('/api/triage')) return postJson(req, res, MAX_ISSUE_BODY, triageHttp);
    if (req.method === 'POST' && is('/api/queue')) return postJson(req, res, MAX_BODY, mutateQueue);
    json(res, 404, { error: L('server.notFound') });
  });

  const listen = (p) => new Promise((ok, no) => { server.once('error', no); server.listen(p, host, () => { server.off('error', no); ok(); }); });
  const first = o.port ?? cfg.server.port;
  for (let i = 0; ; i++) {
    try { await listen(first === 0 ? 0 : first + i); break; } catch (e) { if (e.code !== 'EADDRINUSE' || i >= PORT_TRIES) throw e; }
  }
  const port = server.address().port;
  origins = ['127.0.0.1', 'localhost', '[::1]'].map(h => `http://${h}:${port}`);
  writeJson(`${state}/server.json`, { pid: process.pid, port, host, startedAt: new Date().toISOString() });

  const close = () => {
    clearInterval(ping);
    clearTimeout(timer);
    for (const w of watchers) w.close();
    for (const r of clients) r.end();
    if (rj(`${state}/server.json`, null)?.pid === process.pid) rmSync(`${state}/server.json`, { force: true });
    return new Promise(ok => { server.close(ok); server.closeAllConnections(); });
  };
  return { server, port, host, token, close };
}

if (resolve(process.argv[1] ?? '').toLowerCase() === resolve(SELF).toLowerCase()) {
  const args = process.argv.slice(2), val = k => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const project = val('--project') ?? process.cwd();
  try {
    const cfg = loadProjectConfig(project), s = await serve(cfg, { port: val('--port') === undefined ? undefined : Number(val('--port')), host: val('--host') });
    console.log(`Forja dashboard: ${dashboardUrl(cfg.paths.state)}`);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => s.close().then(() => process.exit(0)));
  } catch (e) {
    const dir = `${resolve(project).replace(/\\/g, '/')}/.forja/state/logs`;
    mkdirSync(dir, { recursive: true });
    appendFileSync(`${dir}/server.log`, `${new Date().toISOString()} ${e.message}\n`);
    process.exitCode = 1;
  }
}
