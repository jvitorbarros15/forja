import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { PROTECTED, globMatch, tierOf } from './config.mjs';
import { t } from './i18n.mjs';
import { IS_WIN, killTree } from './platform.mjs';
import { field, git, paths, read, readJson } from './state.mjs';
import { effectiveTier } from './tick.mjs';
import { tail } from './vendors/proc.mjs';
import { dirty, expand, linked, sh } from './worktree.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
// A port nothing else holds right now: a fixed one can belong to another app, whose answer would pass for ui.serve.
const freePort = () => new Promise((ok, bad) => { const s = createServer(); s.once('error', bad); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

async function loadPlaywright(wt) {
  const loads = [() => import(pathToFileURL(createRequire(`${wt}/`).resolve('playwright')).href), () => import('playwright')];
  for (const load of loads) try { const m = await load(); return m.chromium ?? m.default?.chromium ?? null; } catch {}
  return null;
}
// Tests replace this to run without a browser.
export const deps = { playwright: loadPlaywright };

async function screenshots(cfg, n, round, url, pages, chromium) {
  const dir = `${paths(cfg).jobs(n)}/round-${round}/shots`, widths = cfg.ui.widths ?? [390, 1440];
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let browser;
  try { browser = await chromium.launch(); } catch { return { count: 0, why: t(cfg.language, 'check.noBrowser') }; }
  let count = 0;
  try {
    for (const page of (pages ?? '/').split(/\s+/).filter(p => p.startsWith('/'))) for (const width of widths) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light' }), p = await ctx.newPage();
      await p.goto(url + page, { waitUntil: 'networkidle' });
      await p.screenshot({ path: `${dir}/${page.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}-${width}.png`, fullPage: true });
      await ctx.close();
      count++;
    }
  } finally { await browser.close(); }
  return { count };
}

async function verifyUi(cfg, n, round, spec) {
  const wt = paths(cfg).wt(n), L = (k, v) => t(cfg.language, k, v), { ui } = cfg, chromium = await deps.playwright(wt);
  if (!ui.verify && !chromium) return { summary: L('check.uiSkipped'), note: '' };
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const srv = spawn(expand(cfg, ui.serve), { cwd: wt, shell: true, detached: !IS_WIN, env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  srv.on('error', () => {});
  try {
    let up = false;
    for (let i = 0; i < 60 && !up && srv.exitCode === null; i++) {
      try { await fetch(url, { signal: AbortSignal.timeout(2000) }); up = true; } catch { await wait(1000); }
    }
    // The answer must come from this serve: a process that exits right after answering, or never started, is not up.
    if (up) { await wait(250); up = srv.exitCode === null && srv.signalCode === null; }
    if (!up) return { summary: 'serve failed', note: L('check.uiNoServer', { port }) };
    let summary = 'verify skipped';
    if (ui.verify) {
      const v = sh(wt, expand(cfg, ui.verify), { BASE_URL: url });
      if (v.status) return { summary: 'verify fail', note: failure(L, 'ui.verify', v) };
      summary = 'verify pass';
    }
    if (!chromium) return { summary: `${summary}, ${L('check.screenshotsSkipped')}`, note: '' };
    try {
      const s = await screenshots(cfg, n, round, url, field(spec, 'PAGES'), chromium);
      return { summary: `${summary}, ${s.why ?? `${s.count} screenshots`}`, note: '' };
    } catch (e) { return { summary: `${summary}, screenshots failed`, note: L('check.shotFailed', { why: tail(e.message, 3) }) }; }
  } finally { killTree(srv.pid); }
}

// A failing command always leaves a note, even when it printed nothing: an empty note would read as a pass.
const failure = (L, name, r) => [L('check.cmdFailed', { name, code: r.status }), tail(`${r.stdout}${r.stderr}`)].filter(Boolean).join('\n');

// -z: git quotes non-ASCII names otherwise, and the globs would miss them.
const changedFiles = (wt, base) => [...git(wt, 'diff', '--name-only', '-z', '--no-renames', base).split('\0'), ...git(wt, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')]
  .filter(f => f && !(linked(wt) && /^node_modules(\/|$)/.test(f)));

// The orchestrator's own checks; a model's "done" never counts. Commits only when everything passes.
export async function check(cfg, n, exec, round, failed = '') {
  const P = paths(cfg), wt = P.wt(n), dir = P.jobs(n), spec = read(`${dir}/spec.md`), L = (k, v) => t(cfg.language, k, v);
  const out = { typecheck: 'skip', test: 'skip', build: 'skip', ui: 'skip' };
  const base = git(wt, 'merge-base', `origin/${cfg.defaultBranch}`, 'HEAD').trim();
  // --no-renames: a move lists both paths, so a rename out of a protected or tier folder still counts. Deletions are listed too.
  const files = changedFiles(wt, base);
  const ui = !!cfg.ui && files.some(f => globMatch(f, cfg.ui.paths)), prot = files.some(f => globMatch(f, PROTECTED));
  const tierId = effectiveTier(cfg, field(spec, 'TIER'), readJson(`${dir}/triage.json`, null)), tier = tierOf(cfg, tierId);
  const outside = tier?.paths?.length ? files.filter(f => !globMatch(f, tier.paths)) : [];
  let notes = failed || (!files.length ? L('check.noChanges', { branch: cfg.defaultBranch })
    : outside.length ? L('check.outsidePaths', { tier: tierId, paths: tier.paths.join(', '), files: outside.join(', ') })
    : !dirty(wt) ? L('check.nothingChanged') : '');
  for (const name of ['typecheck', 'test', 'build']) {
    if (notes || !cfg.checks[name]) continue;
    const r = sh(wt, expand(cfg, cfg.checks[name])), s = `${r.stdout}${r.stderr}`;
    const total = k => s.match(new RegExp(`(?:#|ℹ) ${k} (\\d+)`))?.[1];
    out[name] = `${r.status ? 'fail' : 'pass'}${name === 'test' && total('pass') !== undefined ? ` (${total('pass')} pass, ${total('fail') ?? 0} fail, ${total('skipped') ?? 0} skipped)` : ''}`;
    if (r.status) notes = failure(L, name, r);
  }
  if (!notes && ui) {
    const v = await verifyUi(cfg, n, round, spec);
    out.ui = v.summary;
    notes = v.note;
  }
  let commit = '-';
  if (!notes) {
    const msg = field(spec, 'COMMIT');
    if (!new RegExp(cfg.commit.pattern).test(msg ?? '')) notes = L('check.badCommit', { pattern: cfg.commit.pattern, subject: msg });
    else {
      git(wt, 'add', '-A', ...(linked(wt) ? ['--', '.', ':(exclude)node_modules'] : []));
      git(wt, 'commit', '-q', '-m', msg);
      commit = git(wt, 'log', '-1', '--format=%h %s').trim();
    }
  }
  const stat = git(wt, 'diff', '--numstat', base).split('\n').filter(Boolean).map(l => { const [a, d, p] = l.split('\t'); return `${p} +${a} -${d}`; });
  // The executor's closing message, so the approver sees what it says it did; the checks above are what counts.
  const vendor = exec.split(':')[0], said = vendor === 'local' ? '' : read(`${dir}/${vendor === 'claude' ? 'builder.md' : '.last-build.txt'}`).replace(/^\W*(DONE|STUCK)\b\W*/i, '').trim().split('\n').slice(-12).join('\n').slice(-1500);
  writeFileSync(`${dir}/build.md`, [
    `BUILD: ${notes ? 'FAILED' : 'OK'}`, `Executor: ${exec}`, `Round: ${round}`, `Commit: ${commit}`, `UI: ${ui ? 'yes' : 'no'}`, `Protected: ${prot ? 'yes' : 'no'}`,
    `Files: ${stat.join(', ') || '-'}`, `Checks: typecheck ${out.typecheck}; test ${out.test}; build ${out.build}; ui ${out.ui}`, 'Notes:', notes || '-',
    'Builder notes (the executor\'s own words, unverified):', said || '-', '',
  ].join('\n'));
  return { status: 'ok', note: notes ? 'checks failed' : commit };
}
