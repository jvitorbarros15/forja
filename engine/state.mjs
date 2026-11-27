import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { alive } from './platform.mjs';

export const read = p => (existsSync(p) ? readFileSync(p, 'utf8') : '');
export const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`);
  // Windows refuses the rename while another process (the dashboard server) has the file open.
  for (let i = 0; ; i++) try { return renameSync(tmp, p); } catch (e) { if (i > 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; pause(25); }
};

// The board has several writers (the runner, each agent's own process, background calls), so every read-change-write
// holds a lock file. A lock left by a killed process expires after 10 seconds; after 5 seconds of waiting it throws, and the caller tries again on its next cycle.
// `long` is for work that takes minutes (an install): it waits and expires after 45 minutes, and a lock whose holder
// (its pid is written inside) is gone is taken over at once.
export function locked(file, fn, { long = false } = {}) {
  const lock = `${file}.lock`, stale = long ? 45 * 60e3 : 10e3, step = long ? 250 : 25, tries = (long ? 45 * 60e3 : 5e3) / step;
  // A lock that vanished between the failed open and this look has age 0: only a lock still there and old is removed,
  // or the removal could take the lock another process has just created.
  const age = () => { try { return Date.now() - statSync(lock).mtimeMs; } catch { return 0; } };
  const orphan = () => { try { const pid = Number(readFileSync(lock, 'utf8')); return long && pid > 0 && !alive(pid, statSync(lock).mtimeMs, 'node'); } catch { return false; } };
  mkdirSync(dirname(lock), { recursive: true });
  let fd = null;
  for (let i = 0; i < tries && fd === null; i++) try { fd = openSync(lock, 'wx'); } catch { if (age() > stale || orphan()) try { rmSync(lock, { force: true }); } catch {} else pause(step); }
  if (fd === null) throw new Error('board lock busy');
  writeSync(fd, String(process.pid));
  // A lock Windows refuses to delete right now is left to expire; the write itself is already done.
  try { return fn(); } finally { closeSync(fd); try { rmSync(lock, { force: true, maxRetries: 5, retryDelay: 20 }); } catch {} }
}

export const field = (text, key) => text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1].trim() || null;
const run = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256e6 });
export const gh = (...a) => run('gh', a);
export const git = (cwd, ...a) => run('git', ['-c', 'safe.directory=*', '-C', cwd, ...a]);

export function paths(cfg) {
  const s = cfg.paths.state;
  return {
    board: `${s}/board.json`, queue: `${s}/queue.json`, quota: `${s}/quota.json`, commands: `${s}/commands.json`, runner: `${s}/runner.json`, ignored: `${s}/ignored.json`,
    jobs: n => `${s}/jobs/${n}`, docs: `${s}/docs`, logs: `${s}/logs`,
    wt: n => `${cfg.paths.worktreeRoot}/forja-${n}`, main: cfg.paths.main,
  };
}

function tokensOf(workers) {
  const t = { input: 0, output: 0, total: 0, estimated: false, byVendor: {} };
  for (const w of workers) {
    if (!w.tokens) continue;
    const v = (t.byVendor[w.vendor] ??= { input: 0, output: 0, total: 0, estimated: false });
    for (const x of [t, v]) { x.input += w.tokens.input || 0; x.output += w.tokens.output || 0; x.total += w.tokens.total || 0; x.estimated ||= !!w.estimated; }
  }
  return t;
}

export function createBoard(cfg, { relabel = () => {}, needOf = null } = {}) {
  const P = paths(cfg);
  const board = { needOf };

  function writeDoc(job) {
    const files = [];
    if (job.branch) try {
      for (const l of git(P.main, 'diff', '--numstat', `origin/main...${job.branch}`).split('\n').filter(Boolean)) {
        const [add, del, path] = l.split('\t');
        files.push({ path, add: +add || 0, del: +del || 0 });
      }
    } catch {}
    const doc = {
      issue: job.issue, pr: job.pr ?? null, title: job.title ?? '', summary: field(read(`${P.jobs(job.issue)}/spec.md`), 'SUMMARY') ?? '',
      tier: job.tier ?? null, stage: job.stage, round: job.round, branch: job.branch ?? null, reviews: job.reviews ?? {}, files,
      events: job.events.slice(-30), note: job.note ?? '', need: job.need && board.needOf ? board.needOf(job, job.need.why, job.need.action) : null,
      running: job.running ?? [], paused: !!job.paused, approved: !!job.approved, updatedAt: job.updatedAt,
      since: job.since ?? null, ci: job.ci ?? null, retryAt: job.retryAt ?? null,
      workers: job.workers ?? [], tokens: tokensOf(job.workers ?? []), triage: job.triage ?? null, ai: job.ai ?? null,
    };
    const p = `${P.docs}/${job.issue}.json`;
    writeJson(p, doc);
    return p;
  }

  // `change` is the patch, or a function of the job as read under the lock that returns it; `event` may be a function called after it.
  // Null when `create` is false and the job is not on the board.
  function setJob(issue, change, event, create = true) {
    const now = new Date().toISOString();
    const r = locked(P.board, () => {
      const b = readJson(P.board, { jobs: [] });
      let job = b.jobs.find(j => j.issue === issue);
      if (!job && !create) return null;
      if (!job) b.jobs.push((job = { issue, round: 0, fails: 0, reviews: {}, running: [], events: [] }));
      const prev = { ...job }, patch = typeof change === 'function' ? change(job) : change;
      Object.assign(job, patch, { updatedAt: now });
      if (!['needs-you', 'failed'].includes(job.stage)) { delete job.need; delete job.ai; delete job.advisedFor; }
      // `since` marks the start of the current attempt; an output file counts only when it is newer.
      if ('stage' in patch && patch.stage !== prev.stage) job.stageSince = now;
      if (['stage', 'round', 'executor', 'fails'].some(k => k in patch && patch[k] !== prev[k]) || patch.running?.length) job.since = now;
      const text = typeof event === 'function' ? event() : event;
      if (text) job.events.push({ at: now, text });
      writeJson(P.board, b);
      return { job, prev };
    });
    if (!r) return null;
    if (r.job.stage !== r.prev.stage) try { relabel(r.job, r.prev.stage); } catch {}
    return writeDoc(r.job);
  }

  // Upserts one worker (by id) on a job and rewrites its doc; null when the job is not on the board.
  const upsertWorker = (issue, w) => setJob(issue, job => {
    const ws = [...(job.workers ?? [])], i = ws.findIndex(x => x.id === w.id);
    ws[i < 0 ? ws.length : i] = { ...ws[i], ...w };
    return { workers: ws };
  }, null, false);

  return Object.assign(board, { setJob, upsertWorker, writeDoc });
}
