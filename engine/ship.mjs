import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { t } from './i18n.mjs';
import { parseEntry } from './models.mjs';
import { bestEffort, gh as realGh, field, git, locked, paths, read, readJson, writeJson } from './state.mjs';
import { createTick } from './tick.mjs';
import { tail } from './vendors/proc.mjs';
import { ensureMain, expand, removeJob, sh } from './worktree.mjs';

// A dry-run that fails for one of these is worth running again on its own.
const DROPPED = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Could not resolve host|unable to access|EPERM/i;
const NETWORK = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Could not resolve host|unable to access/i;
const RENAME = /EPERM[^\n]*rename|rename[^\n]*EPERM/i;

// Wraps one step: writes its run file (running, then the result) and its worker, and returns the result.
// A thrown error is a failed run. `usage`, when the step reports it, only goes to the worker.
export async function tracked(cfg, n, kind, fn, { file, extra = {}, w = null, T = createTick(cfg) } = {}) {
  const f = file ?? `${paths(cfg).jobs(n)}/run-${kind}.json`, base = { kind, pid: process.pid, startedAt: new Date().toISOString(), ...extra };
  const worker = patch => { if (w) try { T.upsertWorker(n, { id: `${w.role}-${w.round}-${w.model}`, model: w.model, vendor: parseEntry(w.model).vendor, role: w.role, round: w.round, startedAt: base.startedAt, ...patch }); } catch {} };
  writeJson(f, { ...base, status: 'running' });
  worker({ status: 'running', endedAt: null, tokens: null, estimated: false });
  let res;
  try { res = await fn(); } catch (e) { res = { status: 'failed', note: tail(e.stderr || e.message, 5), detail: tail(e.stderr || e.message, 80) }; }
  const { usage, ...out } = res, endedAt = new Date().toISOString();
  writeJson(f, { ...base, endedAt, ...out });
  worker({ status: res.status === 'ok' ? 'ok' : 'failed', endedAt, tokens: usage ? { input: usage.input, output: usage.output, total: usage.total } : null, estimated: !!usage?.estimated });
  return { kind, ...out };
}

export function pr(cfg, n, { gh = realGh } = {}) {
  const P = paths(cfg), dir = P.jobs(n), d = read(`${dir}/decision.md`), spec = read(`${dir}/spec.md`), branch = field(spec, 'BRANCH'), wt = P.wt(n);
  // Without decision.md the owner approved a passing build by hand.
  const title = d ? field(d, 'PR title') : field(spec, 'COMMIT'), summary = d ? d.match(/^PR body:[ \t]*([\s\S]*?)^Reason:/m)?.[1].trim() : t(cfg.language, 'pr.defaultBody');
  if (!new RegExp(cfg.commit.pattern).test(title ?? '') || !summary) throw new Error('decision.md needs a commit-style PR title and a PR body');
  if (!new RegExp(`^forja/${n}-[a-z0-9-]+$`).test(branch ?? '') || git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim() !== branch) throw new Error(`BRANCH in spec.md (${branch}) is not a forja/${n}-… branch checked out in the worktree`);
  git(wt, 'push', '-q', '-u', 'origin', branch);
  const open = JSON.parse(gh('pr', 'list', '-R', cfg.repo, '--head', branch, '--state', 'open', '--json', 'number'));
  if (open.length) return open[0].number;
  const body = cfg.pr.bodyTemplate.replace(/\{(issue|summary)\}/g, (m, k) => (k === 'issue' ? String(n) : summary));
  return Number(gh('pr', 'create', '-R', cfg.repo, '--base', 'main', '--head', branch, '--title', title, '--body', body).trim().match(/\/pull\/(\d+)/)[1]);
}

// deploy and deployTest run in forja-main, after it is fast-forwarded to origin/main; at most one runs at a time.
function runIn(cfg, key, retry) {
  if (!cfg.checks[key]) throw new Error(t(cfg.language, 'refuse.noDeployCommand'));
  ensureMain(cfg);
  for (let attempt = 0; ; attempt++) {
    const r = sh(cfg.paths.main, expand(cfg, cfg.checks[key])), s = `${r.stdout}${r.stderr}`;
    if (!r.status) return s;
    if (attempt >= 3 || !retry(s)) throw new Error(tail(s, 80));
  }
}

export function deploy(cfg, ids) {
  // A dropped connection or a locked file happens before anything is promoted, so the same command is safe to run again.
  runIn(cfg, 'deploy', s => NETWORK.test(s) || RENAME.test(s));
  // The site is already live here; a stuck worktree must not turn the deploy into a reported failure.
  for (const n of ids) try { removeJob(cfg, n); } catch {}
  return { status: 'ok', note: `deployed ${ids.join(', ')}` };
}

export function deployTest(cfg, ids) {
  runIn(cfg, 'deployTest', s => RENAME.test(s));
  return { status: 'ok', note: t(cfg.language, 'deploy.testOk'), of: ids[0] };
}

const explain = (cfg, out) => {
  const o = String(out ?? '');
  if (NETWORK.test(o)) return t(cfg.language, 'deploy.reason.connection');
  if (/EPERM/i.test(o)) return t(cfg.language, 'deploy.reason.fileLock');
  return (o.match(/^.*(?:\[ERROR\]|Error:).*$/m)?.[0] ?? o.trim().split('\n').at(-1) ?? '').replace(/^[✘X▲ ]+/, '').slice(0, 160);
};

// Every card involved gets a start line, a worker and a result; factory jobs live in board.json, cards made by hand only in docs/<id>.json.
export async function runDeploy(cfg, test, ids, { gh = realGh, T = createTick(cfg, { gh }) } = {}) {
  const P = paths(cfg), L = (k, v) => t(cfg.language, k, v), cmd = test ? 'deploy-test' : 'deploy', num = id => /^\d+$/.test(id);
  if (!cfg.checks[test ? 'deployTest' : 'deploy']) throw new Error(L('refuse.noDeployCommand'));
  const doc = id => `${P.docs}/${id}.json`, edit = (id, fn) => { if (existsSync(doc(id))) { const d = readJson(doc(id)); fn(d); writeJson(doc(id), d); } };
  const note = (id, text, at) => (num(id) ? T.setJob(Number(id), {}, text, false) : edit(id, d => { d.events = [...(d.events ?? []), { at, text }]; }));
  const startedAt = new Date().toISOString(), w = { id: `${cmd}-${Date.parse(startedAt)}`, model: 'local', vendor: 'local', role: cmd, round: 99, startedAt, tokens: null };
  const worker = (id, patch) => { const x = { ...w, ...patch }; if (num(id)) T.upsertWorker(Number(id), x); else edit(id, d => { d.workers = [...(d.workers ?? []).filter(y => y.id !== x.id), x]; }); };
  // Board writes around the deploy are best effort: a busy lock must neither stop the deploy from starting nor hide that it went live.
  // What is left undone is reconciled later: the tick moves a merged card to deployed from run-deploy.json, and the runner closes
  // a command still `running` once the run file says the run ended.
  for (const id of ids) {
    bestEffort(() => note(id, L(test ? 'deploy.testStarted' : 'deploy.started'), startedAt));
    bestEffort(() => worker(id, { status: 'running' }));
  }
  const file = `${cfg.paths.state}/run-${cmd}.json`, issues = ids.filter(num).map(Number);
  // tick runs a dropped test again by itself; `tries` counts the attempts in a row so that stops at three.
  const prev = test ? readJson(file, null) : null, tries = prev?.status === 'failed' && prev.transient ? (prev.tries ?? 1) + 1 : 1;
  const res = await tracked(cfg, 0, cmd, () => (test ? deployTest(cfg, ids) : deploy(cfg, issues)), { file, extra: test ? { of: ids[0], ids, tries } : { issues, ids }, T });
  const r = readJson(file), ok = r.status === 'ok';
  // tick shows run-*.json's note on cards, so it gets the plain explanation too; the raw output stays in detail.
  const why = ok ? '' : explain(cfg, r.detail ?? r.note), again = !ok && test && DROPPED.test(r.detail ?? r.note);
  if (!ok) writeJson(file, { ...r, detail: r.detail ?? r.note, note: L('deploy.nothingChanged', { why }), ...(test ? { transient: again } : {}) });
  const text = ok ? (test ? r.note : L('deploy.live')) : `${L(test ? 'deploy.testFailed' : 'deploy.failed', { why })}${again && tries < 3 ? ` ${L('deploy.retryTest')}` : ''}`;
  for (const id of ids) {
    bestEffort(() => worker(id, { status: ok ? 'ok' : 'failed', endedAt: r.endedAt }));
    bestEffort(() => note(id, text, r.endedAt));
    if (ok && !test) bestEffort(() => {
      if (num(id)) T.setJob(Number(id), { stage: 'deployed', note: L('event.deployed') }, null, false);
      else edit(id, d => { d.stage = 'deployed'; d.updatedAt = r.endedAt; });
    });
  }
  bestEffort(() => locked(P.commands, () => {
    const raw = readJson(P.commands, []), list = Array.isArray(raw) ? raw : raw.docs ?? raw.documents ?? [];
    let hit = false;
    for (const c0 of list) {
      const c = c0.data ?? c0;
      if (c.action === cmd && c.status === 'running' && ids.includes(String(c.jobId))) { c.status = ok ? 'done' : 'failed'; c.doneAt = r.endedAt; hit = true; }
    }
    if (hit) writeJson(P.commands, raw);
  }));
  return res;
}

const tryGh = (gh, ...a) => { try { return gh(...a); } catch { return ''; } };

// Writes the failed CI lines as the round's owner note, read by the next builder like any other note.
export function ciLog(cfg, n, round, prNumber, { gh = realGh } = {}) {
  const R = cfg.repo, p = String(Number(prNumber));
  const br = tryGh(gh, 'pr', 'view', p, '-R', R, '--json', 'headRefName', '-q', '.headRefName').trim();
  const id = /^forja\/[a-z0-9-]+$/.test(br) && tryGh(gh, 'run', 'list', '-R', R, '--branch', br, '--status', 'failure', '--limit', '1', '--json', 'databaseId', '-q', '.[0].databaseId').trim();
  const lines = (/^\d+$/.test(id) ? tryGh(gh, 'run', 'view', id, '-R', R, '--log-failed') : '').split('\n')
    .map(l => l.replace(/^[^\t]*\t[^\t]*\t\S+\s?/, '')).filter(l => /error|fail|not ok|✖|expected/i.test(l)).slice(-30);
  const dir = `${paths(cfg).jobs(n)}/round-${round}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/owner.md`, `${t(cfg.language, 'ci.note')}\n${lines.join('\n') || t(cfg.language, 'ci.noLines')}\n`);
}
