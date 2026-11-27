// The forja command line, called by the slash commands.
//   node cli.mjs detect|init|start|stop|status|doctor --project <dir>
//   init takes --answers '<json>' or --answers-file <path>, and --no-gh to skip the labels.
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigError, DEFAULTS, loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { IS_WIN, alive, killTree } from './platform.mjs';
import { renderAgent, roles } from './registry.mjs';
import { launch as realLaunch, loadCfg } from './runner.mjs';
import { dashboardUrl } from './server.mjs';
import { gh as realGh, git, read, readJson, writeJson } from './state.mjs';
import { ensureMain } from './worktree.mjs';

const ENGINE = path.dirname(fileURLToPath(import.meta.url)), SERVER = `${ENGINE}/server.mjs`, RUNNER = `${ENGINE}/runner.mjs`;
const fwd = p => p.replace(/\\/g, '/');
const first = e => String(e?.message ?? e).split('\n')[0].slice(0, 200);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const CLIS = ['git', 'gh', 'claude', 'codex', 'gemini', 'agy', 'ollama'];
const LABELS = ['forja:spec', 'forja:build', 'forja:review', 'forja:needs-you', 'forja:done'];

function which(name, env = process.env, extraDirs = []) {
  const dirs = [...extraDirs, ...(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)];
  const exts = IS_WIN ? (/\.\w+$/.test(name) ? [''] : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())) : [''];
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, name + e);
    try { if (statSync(f).isFile()) { if (!IS_WIN) accessSync(f, constants.X_OK); return f; } } catch {}
  }
  return null;
}

function resolveBin(bin, project, env) {
  if (/[\\/]/.test(bin)) return [bin, `${bin}.exe`, `${bin}.cmd`].map(b => path.resolve(project, b)).find(existsSync) ?? null;
  const known = IS_WIN && bin === 'claude' ? [`${env.USERPROFILE}/.local/bin/claude.exe`, `${env.APPDATA}/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`].find(existsSync) : null;
  return which(bin, env) ?? known ?? null;
}

async function playwrightOk(project) {
  try {
    const file = createRequire(`${path.resolve(project)}/package.json`).resolve('playwright');
    const pw = await import(pathToFileURL(file).href);
    return existsSync((pw.chromium ?? pw.default?.chromium).executablePath());
  } catch { return false; }
}

const repoOf = project => {
  try { return git(project, 'remote', 'get-url', 'origin').trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? null; } catch { return null; }
};
const scopesOf = text => (text.match(/Token scopes:\s*(.+)/)?.[1] ?? '').split(',').map(s => s.replace(/['"\s]/g, '')).filter(s => s && s !== 'none');

async function detect(project, o) {
  const gh = o.gh ?? realGh, env = o.env ?? process.env, tryGh = (...a) => { try { return gh(...a); } catch { return ''; } };
  const pkg = path.join(project, 'package.json');
  let scripts = {}, config = null;
  try { scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {}; } catch {}
  try { config = JSON.parse(readFileSync(`${project}/.forja/config.json`, 'utf8')); } catch {}
  return {
    repo: repoOf(project), ghUser: tryGh('api', 'user', '--jq', '.login').trim() || null, ghScopes: scopesOf(tryGh('auth', 'status')),
    node: process.versions.node,
    clis: { ...Object.fromEntries(CLIS.map(c => [c, !!which(c, env)])), playwright: await playwrightOk(project) },
    scripts, config,
  };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diff = (a, d) => {
  if (!isObj(a) || !isObj(d)) return sameJson(a, d) ? undefined : a;
  const out = {};
  for (const k of Object.keys(a)) { const v = diff(a[k], d[k]); if (v !== undefined) out[k] = v; }
  return Object.keys(out).length ? out : undefined;
};

function fromAnswers(a) {
  const bad = Object.keys(a).filter(k => !(k in DEFAULTS) && !['deployTest', 'deploy'].includes(k));
  if (bad.length) return { bad };
  const cfg = {};
  for (const [k, v] of Object.entries(a)) if (k in DEFAULTS && v !== undefined) cfg[k] = v;
  if (a.vendors) {
    const list = Array.isArray(a.vendors) ? Object.fromEntries(a.vendors.map(n => [n, true])) : a.vendors;
    cfg.vendors = Object.fromEntries(Object.entries(list).map(([n, v]) => [n, typeof v === 'boolean' ? { enabled: v } : v]));
  }
  for (const k of ['deployTest', 'deploy']) if (a[k]) cfg.checks = { ...cfg.checks, [k]: a[k] };
  const min = { repo: cfg.repo, approvers: cfg.approvers };
  for (const k of Object.keys(cfg)) if (!(k in min)) { const v = diff(cfg[k], DEFAULTS[k]); if (v !== undefined) min[k] = v; }
  return { min };
}

function init(project, args, o, L, out) {
  const val = k => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  let answers;
  try { answers = JSON.parse(val('--answers-file') ? readFileSync(val('--answers-file'), 'utf8').replace(/^﻿/, '') : val('--answers')); } catch (e) { out.err(L('cli.answersBad', { why: first(e) })); return 2; }
  if (!isObj(answers)) { out.err(L('cli.answersBad', { why: 'not an object' })); return 2; }
  const { min, bad } = fromAnswers(answers);
  if (bad) { out.err(bad.map(k => L('cli.answersUnknown', { key: k })).join('\n')); return 2; }

  const tmp = mkdtempSync(`${os.tmpdir()}/forja-init-`);
  let cfg;
  try {
    mkdirSync(`${tmp}/.forja`);
    writeFileSync(`${tmp}/.forja/config.json`, JSON.stringify(min));
    cfg = loadConfig(project, { mainDir: tmp });
  } catch (e) {
    out.err(`${L('cli.initInvalid')}\n${e instanceof ConfigError ? e.errors.join('\n') : first(e)}`);
    return 1;
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  const file = `${project}/.forja/config.json`;
  mkdirSync(`${project}/.forja`, { recursive: true });
  writeFileSync(file, `${JSON.stringify(min, null, 2)}\n`);
  out.log(L('cli.initWrote', { file: fwd(file) }));
  const ignore = `${project}/.gitignore`, text = read(ignore);
  if (!text.split(/\r?\n/).some(l => ['.forja/state', '.forja/state/'].includes(l.trim()))) {
    appendFileSync(ignore, `${text && !text.endsWith('\n') ? '\n' : ''}.forja/state/\n`);
    out.log(L('cli.initIgnore'));
  }
  if (args.includes('--no-gh')) { out.log(L('cli.initNoGh')); return 0; }
  const gh = o.gh ?? realGh;
  let failed = 0;
  for (const name of [cfg.intakeLabel, ...LABELS]) {
    try { gh('label', 'create', name, '-R', cfg.repo, '--force'); } catch (e) { failed++; out.err(L('cli.initLabelFail', { name, why: first(e.stderr || e) })); }
  }
  if (failed) return 1;
  out.log(L('cli.initLabels', { n: LABELS.length + 1, repo: cfg.repo }));
  return 0;
}

const pidsFile = cfg => `${cfg.paths.state}/pids.json`;
const running = p => !!p && alive(p.pid, p.startedAt, 'node');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(cfg, o, L, out) {
  const state = cfg.paths.state, pids = readJson(pidsFile(cfg), null), url = () => dashboardUrl(state);
  if (running(pids?.server) && running(pids?.runner)) {
    out.log(L('cli.alreadyRunning'));
    if (url()) out.log(L('cli.dashboard', { url: url() }));
    return 0;
  }
  stopPids(cfg, pids, L, () => {});
  try { ensureMain(cfg); } catch (e) { out.err(L('cli.startFailed', { why: first(e.stderr || e) })); return 1; }
  rmSync(`${state}/server.json`, { force: true });
  const launch = o.launch ?? realLaunch, ctx = { cfg, once: false }, at = () => new Date().toISOString();
  const proj = cfg.paths.project, s = launch(ctx, [SERVER, '--project', proj]), sAt = at(), r = launch(ctx, [RUNNER, '--project', proj, '--every', '15']), rAt = at();
  if (!s?.pid || !r?.pid) { out.err(L('cli.startFailed', { why: 'spawn' })); return 1; }
  writeJson(pidsFile(cfg), { server: { pid: s.pid, startedAt: sAt }, runner: { pid: r.pid, startedAt: rAt } });
  for (let i = 0; i < 50 && !url(); i++) await sleep(100);
  if (!url()) { out.err(L('cli.serverSilent', { log: `${state}/logs/server.log` })); return 1; }
  out.log(L('cli.started'));
  out.log(L('cli.dashboard', { url: url() }));
  return 0;
}

function stopPids(cfg, pids, L, log) {
  const state = cfg.paths.state;
  for (const name of ['server', 'runner']) {
    const p = pids?.[name];
    if (running(p)) { killTree(p.pid); log(L('cli.stopped', { name, pid: p.pid })); } else log(L('cli.notRunning', { name }));
  }
  for (const f of ['pids.json', 'server.json', '.runner.lock']) rmSync(`${state}/${f}`, { force: true });
}

const age = ms => (ms < 90e3 ? `${Math.round(ms / 1e3)}s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)}m` : `${Math.round(ms / 3600e3)}h`);

function status(cfg, L, out) {
  const state = cfg.paths.state, pids = readJson(pidsFile(cfg), null), hb = readJson(`${state}/runner.json`, null), url = dashboardUrl(state);
  if (running(pids?.runner)) out.log(hb ? L('cli.runnerUp', { age: age(Date.now() - Date.parse(hb.at)) }) : L('cli.runnerNoBeat'));
  else out.log(L('cli.runnerDown'));
  if (hb?.error) out.log(L('cli.runnerError', { why: hb.error }));
  out.log(running(pids?.server) && url ? L('cli.dashboard', { url }) : L('cli.serverDown'));
  for (const w of hb?.waiting ?? []) out.log(L('cli.waiting', { issue: w.issue, stage: w.stage, on: w.on }));
  for (const [vendor, q] of Object.entries(hb?.quota ?? {})) out.log(L('cli.quota', { vendor, h5: q.h5, week: q.week, limited: q.limitedUntil ? L('cli.quotaLimited', { until: q.limitedUntil }) : '' }));
  const jobs = readJson(`${state}/board.json`, { jobs: [] }).jobs, by = {};
  for (const j of jobs) by[j.stage] = (by[j.stage] ?? 0) + 1;
  out.log(jobs.length ? L('cli.jobs', { summary: Object.entries(by).map(([s, n]) => `${s} ${n}`).join(', ') }) : L('cli.jobsNone'));
  const doc = n => readJson(`${state}/docs/${n}.json`, null);
  for (const j of jobs.filter(x => ['needs-you', 'failed'].includes(x.stage))) out.log(L('cli.needsYou', { issue: j.issue, stage: j.stage, title: j.title ?? doc(j.issue)?.title ?? '' }));
  return 0;
}

function nearestDir(p) { while (!existsSync(p)) p = path.dirname(p); return p; }

const firstWord = cmd => cmd.trim().split(/\s+/).find(w => !/^\w+=/.test(w))?.replace(/^["']|["']$/g, '') ?? '';

async function doctor(project, o, L, out) {
  const env = o.env ?? process.env, gh = o.gh ?? realGh, rows = [];
  const add = (level, text) => { rows.push(level); out.log(`[${level}] ${text}`); };
  const ok = (cond, good, bad) => add(cond ? 'ok' : 'FAIL', cond ? good : bad);

  ok(Number(process.versions.node.split('.')[0]) >= 22, L('cli.doctor.node', { v: process.versions.node }), L('cli.doctor.nodeOld', { v: process.versions.node }));
  ok(!!which('git', env), L('cli.doctor.git'), L('cli.doctor.gitMissing'));
  if (!which('gh', env)) add('FAIL', L('cli.doctor.ghMissing'));
  else {
    let authed = true, text = '';
    try { text = gh('auth', 'status'); } catch { authed = false; }
    if (!authed) add('FAIL', L('cli.doctor.ghAuth'));
    else {
      const scopes = scopesOf(text);
      ok(!scopes.length || scopes.includes('repo'), L('cli.doctor.ghOk'), L('cli.doctor.ghScope'));
    }
  }

  let cfg = null;
  try { cfg = loadCfg(project); add('ok', L('cli.doctor.config')); } catch (e) { add('FAIL', `${L('cli.doctor.configBad')}\n${e instanceof ConfigError ? e.errors.map(x => `  ${x}`).join('\n') : first(e)}`); }
  const claudeBin = cfg?.vendors?.claude?.bin ?? 'claude';
  ok(!!resolveBin(claudeBin, project, env), L('cli.doctor.claude', { bin: claudeBin }), L('cli.doctor.claudeMissing', { bin: claudeBin }));

  if (cfg) {
    const root = nearestDir(cfg.paths.worktreeRoot);
    let writable = true;
    try { accessSync(root, constants.W_OK); } catch { writable = false; }
    ok(writable, L('cli.doctor.worktree', { dir: cfg.paths.worktreeRoot }), L('cli.doctor.worktreeBad', { dir: cfg.paths.worktreeRoot }));

    const bins = [`${project}/node_modules/.bin`, `${cfg.paths.main}/node_modules/.bin`];
    for (const [name, cmd] of Object.entries(cfg.checks)) {
      if (!cmd) continue;
      const w = firstWord(cmd);
      ok(!!w && (/[\\/]/.test(w) ? existsSync(path.resolve(project, w)) : which(w, env, bins)), L('cli.doctor.check', { name, word: w }), L('cli.doctor.checkMissing', { name, word: w }));
    }
    for (const [name, v] of Object.entries(cfg.vendors)) {
      if (!v.enabled || name === 'ollama') continue;
      const bin = v.bin ?? name;
      ok(!!resolveBin(bin, project, env), L('cli.doctor.vendor', { name, bin }), L('cli.doctor.vendorMissing', { name, bin }));
    }
    try {
      const rs = Object.values(roles(cfg));
      for (const r of rs) renderAgent(cfg, r, o.home);
      add('ok', L('cli.doctor.skills', { n: rs.length }));
    } catch (e) { add('FAIL', L('cli.doctor.skillsBad', { why: first(e) })); }
  }
  const pw = await playwrightOk(project);
  add(pw ? 'ok' : 'warn', L(pw ? 'cli.doctor.playwright' : 'cli.doctor.playwrightMissing'));

  const failed = rows.filter(r => r === 'FAIL').length;
  out.log(failed ? L('cli.doctor.failed', { n: failed }) : L('cli.doctor.passed'));
  return failed ? 1 : 0;
}

export async function run(argv, o = {}) {
  const args = [...argv], cmd = args[0], p = args.indexOf('--project');
  const project = fwd(path.resolve(p >= 0 ? args[p + 1] : process.cwd()));
  const out = { log: o.log ?? console.log, err: o.err ?? console.error };
  const lang = (() => { try { return loadCfg(project).language; } catch { return 'en'; } })();
  const L = (k, v) => t(lang, k, v);
  if (cmd === 'detect') { out.log(JSON.stringify(await detect(project, o), null, 2)); return 0; }
  if (cmd === 'init') return init(project, args, o, L, out);
  if (cmd === 'doctor') return doctor(project, o, L, out);
  if (!['start', 'stop', 'status'].includes(cmd)) { out.err(L('cli.usage')); return 2; }
  let cfg;
  try { cfg = loadCfg(project); } catch (e) { out.err(`${L('cli.doctor.configBad')}\n${e instanceof ConfigError ? e.errors.join('\n') : first(e)}`); return 1; }
  if (cmd === 'start') return start(cfg, o, L, out);
  if (cmd === 'status') return status(cfg, L, out);
  stopPids(cfg, readJson(pidsFile(cfg), null), L, out.log);
  return 0;
}

if (path.resolve(process.argv[1] ?? '').toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  process.exitCode = await run(process.argv.slice(2));
}
