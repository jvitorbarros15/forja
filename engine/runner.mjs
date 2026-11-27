// Runs tick and executes its steps: launches agents, background calls and commands, reaps dead processes, feeds the queue.
//   node runner.mjs --project <dir> [--every 15] [--once] [--dry-run] [--issue <n>]
//   node runner.mjs --project <dir> --agent <file> runs one Claude agent to its end; the runner starts one such process per agent.
//   node runner.mjs --launch <script> [args] is the detached launcher of every background process on Windows (see launch).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadProjectConfig, mainDirOf } from './config.mjs';
import { t } from './i18n.mjs';
import { logCall } from './models.mjs';
import { IS_WIN, alive, gone, killTree, notify as platformNotify, spawnDetached } from './platform.mjs';
import { roles } from './registry.mjs';
import { bestEffort, gh as realGh, git, idsOf, locked, paths, pruneCommands, read, readCommands, readJson, writeJson } from './state.mjs';
import { createTick } from './tick.mjs';
import { runAgent } from './vendors/claude.mjs';
import { cleanMain, ensureMain } from './worktree.mjs';

const MIN = 60e3, SELF = fileURLToPath(import.meta.url), DEPLOYS = ['deploy', 'deploy-test'];
const fwd = p => p.replace(/\\/g, '/');
const stateDir = project => `${fwd(resolve(project))}/.forja/state`;
const first = e => String(e?.message ?? e).split('\n')[0].slice(0, 200);
const stamp = (...a) => [new Date().toISOString().slice(11, 19), ...a].join(' ');
const asJson = o => JSON.stringify(o);
// What a step runs without the node and script path in front: "setup 5", "gh pr merge 9 ...".
const label = a => (i => (i < 0 ? a : a.slice(i + 2)).join(' '))(a.indexOf('--project')).slice(0, 60);

export function makeCtx(cfg, o = {}) {
  const P = paths(cfg), state = cfg.paths.state, log = o.log ?? ((...a) => console.log(stamp(...a)));
  const ctx = {
    cfg, P, log, L: (k, v) => t(cfg.language, k, v), gh: o.gh ?? realGh, ROLES: roles(cfg),
    dry: !!o.dry, once: !!o.once, only: o.only ?? null, pending: o.pending ?? new Set(), mem: o.mem ?? {},
    launch: o.launch ?? launch,
  };
  ctx.T = o.T ?? createTick(cfg, { gh: ctx.gh });
  ctx.notify = o.notify ?? (text => {
    if (ctx.dry) return log('[dry] notify:', text);
    mkdirSync(state, { recursive: true });
    platformNotify(text, { desktop: cfg.notify.desktop, logFile: `${state}/notify.log` });
  });
  return ctx;
}

// Background work must outlive a runner restart, so it is detached. On Windows node kills every other child with its parent,
// and a detached process has no console, so each program it starts would open a visible one: the detached process is only
// a launcher that starts the real script with a hidden console, which everything below inherits, and waits for it.
// `logFile` receives the script's stdout and stderr; the launcher opens it, since the file is the child's, not the launcher's.
export function launch(ctx, argv, { logFile } = {}) {
  const cwd = ctx.cfg.paths.project;
  let c;
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  if (IS_WIN) {
    c = spawn(process.execPath, [SELF, '--launch', ...(logFile ? ['--log', logFile] : []), ...argv], { cwd, detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
  } else c = spawnDetached(process.execPath, argv, { cwd, logFile });
  if (ctx.once) {
    // --once waits for what it started, so its report covers them; the interval keeps the event loop alive meanwhile.
    const keep = setInterval(() => {}, 1e3);
    const p = new Promise(r => { c.on('close', r); c.on('error', r); }).finally(() => { clearInterval(keep); ctx.pending.delete(p); });
    ctx.pending.add(p);
  }
  return c;
}

export function acquireLock(file, L) {
  mkdirSync(dirname(file), { recursive: true });
  const look = () => { try { return `${readFileSync(file, 'utf8').trim()}@${statSync(file).mtimeMs}`; } catch { return null; } };
  const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 20; i++) {
    let fd;
    try { fd = openSync(file, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const seen = look();
      if (!seen) continue;
      const [raw, mt] = seen.split('@'), pid = Number(raw), mtime = Number(mt);
      if (raw === '' && Date.now() - mtime < 1000 && i < 18) { pause(25); continue; }
      if (pid && pid !== process.pid && !gone(pid, mtime, 'node')) throw new Error(L('runner.alreadyRunning', { pid }));
      if (look() === seen) try { unlinkSync(file); } catch {}
      continue;
    }
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
    return () => { try { if (Number(read(file).trim()) === process.pid) unlinkSync(file); } catch {} };
  }
  throw new Error(L('runner.alreadyRunning', { pid: Number(read(file).trim()) || '?' }));
}

const tokensOf = (u = {}) => {
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output = u.output_tokens || 0;
  return { input, output, total: input + output };
};

// The spec agent reads only what the owner wrote: the title, and the body when an approver is its author. Never comments.
export function writeIssue(ctx, issue) {
  const { cfg, P, L } = ctx, i = JSON.parse(ctx.gh('issue', 'view', String(issue), '-R', cfg.repo, '--json', 'title,body,author'));
  const login = i.author?.login?.toLowerCase();
  mkdirSync(P.jobs(issue), { recursive: true });
  writeFileSync(`${P.jobs(issue)}/issue.md`, `# ${i.title}\n\n${login && cfg.approvers.some(a => a.toLowerCase() === login) ? i.body : L('issue.bodyOmitted')}\n`);
}

// Each agent gets its own process, so a runner restart (new code, a crash) does not cut a running agent short.
export function startAgent(ctx, issue, a) {
  const { cfg, P, T, ROLES, log } = ctx, role = ROLES[a.agent], J = P.jobs(issue), WT = P.wt(issue);
  const id = `${a.agent}-${a.round}`, startedAt = new Date().toISOString(), file = `${J}/agent-${role.slot}.json`;
  if (a.agent === 'spec') {
    writeIssue(ctx, issue);
    // The spec reads the code in forja-main, so it must match origin; only a fast-forward, never a merge or reset.
    try { ensureMain(cfg, { install: false }); } catch (e) { if (!existsSync(cfg.paths.main)) throw e; log(`forja-main did not advance: ${first(e)}`); }
  }
  let commit;
  if (role.reviewer) {
    mkdirSync(`${J}/round-${a.round}`, { recursive: true });
    if (existsSync(WT)) { writeFileSync(`${J}/round-${a.round}/diff.patch`, git(WT, 'diff', `origin/${cfg.defaultBranch}...HEAD`)); commit = git(WT, 'rev-parse', 'HEAD').trim(); }
  }
  // The worktree of a builder is made by the step's setup command, after the tick chose the cwd: resolved here.
  const cwd = a.agent !== 'spec' && existsSync(WT) ? WT : cfg.paths.main;
  writeJson(file, { ...a, cwd, id, startedAt, ...(commit ? { commit } : {}) });
  const c = ctx.launch(ctx, [SELF, '--agent', file, '--project', cfg.paths.project]);
  T.upsertWorker(issue, { id, model: a.model, vendor: 'claude', role: a.agent, round: a.round, status: 'running', startedAt, endedAt: null, durationMs: null, tokens: null, pid: c.pid, cpid: null });
  log(`agent ${a.agent} (${a.model}) #${issue} pid ${c.pid}`);
}

// The agent process: runs Claude, then records the result in one board write, so the reaper never sees a finished
// agent still holding its slot. An answer for a round the job already left is dropped.
export async function agentMain(ctx, file) {
  const { cfg, T, ROLES, log, L } = ctx, a = readJson(file, null), issue = a.issue, role = ROLES[a.agent], slot = role.slot;
  const wtState = () => { try { return role.reviewer && a.cwd ? git(a.cwd, 'status', '--porcelain') + git(a.cwd, 'rev-parse', 'HEAD') : null; } catch { return null; } };
  const before = wtState();
  // A launch that throws (no agent file, no claude) is reported like an agent that answered nothing, so it spends a retry.
  const r = await Promise.resolve().then(() => runAgent(cfg, role, a, cpid => T.upsertWorker(issue, { id: a.id, cpid }))).catch(e => ({ code: -1, out: '', err: String(e.message) }));
  let j = null; try { j = JSON.parse(r.out); } catch {}
  const changed = before !== null && wtState() !== before;
  const ok = !changed && r.code === 0 && !!j && !j.is_error, endedAt = new Date().toISOString();
  const done = { status: ok ? 'ok' : 'failed', endedAt, durationMs: j?.duration_ms ?? Date.parse(endedAt) - Date.parse(a.startedAt), tokens: tokensOf(j?.usage), estimated: false };
  let e = null;
  const record = () => T.setJob(issue, job => {
    const workers = (job.workers ?? []).map(w => (w.id === a.id ? { ...w, ...done } : w));
    if (job.round !== a.round || !(job.running ?? []).includes(slot)) return { workers };
    e = T.agentEnd(job, a, ok, changed ? L('err.reviewChanged', { entry: `claude:${a.model}`, kind: slot }) : (j?.result ?? r.err));
    // Logged before the slot is freed, so the next tick already knows Claude is at its limit.
    if (e.limited) bestEffort(() => logCall(cfg.paths.state, 'claude', issue, slot, true, e.limited), 1);
    if (e.write) { mkdirSync(dirname(a.out), { recursive: true }); writeFileSync(a.out, e.write); }
    return { ...e.set, workers };
  }, () => e?.event, false);
  // The answer is already in hand: a busy board lock is waited out rather than losing the agent's work.
  for (let i = 0; ; i++) try { record(); break; } catch (x) { if (i >= 2 || !/lock busy/.test(x.message)) throw x; }
  log(`agent ${a.agent} #${issue} ${ok ? 'ok' : 'failed'}${e ? '' : ' (answer dropped: the job already left that round)'}`);
  if (e && !e.write && e.set.stage === 'needs-you') ctx.notify(L('notify.needsYou', { issue, why: e.event }));
}

// The line of a failed command that says why: node and git print it before a stack or a hint, gh prints it first.
const brief = out => {
  const lines = String(out).trim().split('\n').map(l => l.trim()).filter(Boolean);
  return (lines.find(l => /^(\w*Error:|error:|fatal:|GraphQL:|X |! )/.test(l)) ?? lines.at(-1) ?? '').replace(/^\w*Error: /, '');
};

// commands.json has several writers (the dashboard, call.mjs), so every edit holds its lock.
function editCommands(ctx, fn) {
  const file = ctx.P.commands;
  locked(file, () => {
    const list = readCommands(file);
    let hit = false;
    for (const c of list) if (fn(c, c.id)) hit = true;
    if (hit) writeJson(file, pruneCommands(list));
  });
}

export function execStep(ctx, s) {
  const { cfg, P, T, ROLES, log, L } = ctx, issues = s.issues ?? (s.issue != null ? [s.issue] : []);
  const set = { ...(s.set ?? {}) }, started = new Set();
  const doSet = () => { for (const n of issues) log(`set #${n} ${asJson(set)} -> ${T.setJob(n, set, s.event)}`); };
  if (s.command && DEPLOYS.includes(s.step)) editCommands(ctx, (c, id) => id === s.command && Object.assign(c, { status: 'running', runAt: new Date().toISOString() }));
  if (!s.after && Object.keys(set).length + (s.event ? 1 : 0) && issues.length) doSet();
  try {
    for (const d of s.do ?? []) {
      if (d.run) {
        const r = spawnSync(d.run[0], d.run.slice(1), { cwd: cfg.paths.project, encoding: 'utf8', maxBuffer: 256e6, timeout: 45 * MIN, windowsHide: true });
        if (r.status !== 0) {
          const msg = `${label(d.run)}: ${brief(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`)}`;
          if (!d.optional) throw new Error(msg);
          log(`run ignored: ${msg}`);
        } else {
          if (d.sets) set[d.sets] = /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : r.stdout.trim();
          log(`run ok: ${label(d.run)}`);
        }
      } else if (d.bg) {
        if (d.bg[0] !== process.execPath) throw new Error(`bg is not a node command: ${label(d.bg)}`);
        const k = d.bg.indexOf('--project') + 2, triage = d.bg[k] === 'triage' && /^\d+$/.test(d.bg[k + 1]) ? d.bg[k + 1] : null;
        // Without issue.md the triage reads nothing and answers tier "?".
        if (triage && !existsSync(`${P.jobs(triage)}/issue.md`)) writeIssue(ctx, Number(triage));
        log(`bg pid ${ctx.launch(ctx, d.bg.slice(1)).pid}: ${label(d.bg)}`);
      } else if (d.agent) { startAgent(ctx, s.issue, d); started.add(d); }
      else if (d.write) { mkdirSync(dirname(d.write), { recursive: true }); writeFileSync(d.write, d.text); log(`write ${d.write}`); }
      else if (d.notify) ctx.notify(d.notify);
    }
    if (s.after && issues.length) doSet();
    return { ok: s.step !== 'refuse', note: s.note };
  } catch (e) {
    // The job keeps its stage and the tick derives the same step again after the wait; only the slots of agents
    // that never started are freed, so they are launched again and the ones already running are not doubled.
    const why = first(e), unstarted = (s.do ?? []).filter(d => d.agent && !started.has(d)).map(d => ROLES[d.agent].slot);
    let stopped = false;
    for (const n of issues) {
      let f;
      T.setJob(n, job => { f = T.stepFailed(job, s.step, why); return { ...f.set, ...(f.stopped ? { running: [] } : unstarted.length ? { running: (job.running ?? []).filter(r => !unstarted.includes(r)) } : {}) }; }, () => f.event);
      log(`#${n} step ${s.step} failed: ${why}${f.stopped ? ' (stopped)' : ' (retry scheduled)'}`);
      if (f.stopped) { stopped = true; ctx.notify(L('notify.stopped', { issue: n, why })); }
    }
    // A command whose change was already recorded is done; one that changed nothing yet stays pending for the retry.
    return { ok: !s.after, failed: s.after && (stopped || !issues.length), retry: s.after && !stopped && issues.length > 0, note: why };
  }
}

function dryStep(ctx, s) {
  const { ROLES, log } = ctx, show = (i, d) => log(`  ${i}`, d ?? '');
  log(`step ${s.step} #${s.issues?.join(',') ?? s.issue ?? '-'}${s.command ? ` (command ${s.command})` : ''}${s.after ? ' [set after]' : ''}`);
  if (s.set) show('set', `${asJson(s.set)}${s.event ? ` --event ${s.event}` : ''}`);
  if (s.note) show('refuse', s.note);
  for (const d of s.do ?? []) {
    if (d.run) show('run', `${d.run.join(' ')}${d.sets ? ` (sets ${d.sets})` : ''}`);
    else if (d.bg) show('bg', d.bg.join(' '));
    else if (d.agent) show('agent', `${d.agent} (${d.model}) cwd ${d.cwd} -> ${d.out}; allow ${ROLES[d.agent].allow().join(' ')}`);
    else if (d.write) show('write', d.write);
    else if (d.notify) show('notify', d.notify);
  }
}

// Only deploy and deploy-test mark their own command when they end (call.mjs); everything else is done once executed.
function markCommands(ctx, results) {
  if (!results.length) return;
  editCommands(ctx, (c, id) => {
    const r = results.find(x => x.id === id);
    if (!r || (r.bg && r.ok && !r.failed)) return false;
    c.status = r.failed ? 'failed' : !r.ok ? 'refused' : 'done';
    if (!r.ok && r.note) c.note = r.note;
    c.doneAt = new Date().toISOString();
    return true;
  });
}

// A deploy or test whose process died (PC or runner restarted) would show running forever; close it as failed on every card it touched.
export function reapDead(ctx) {
  const { cfg, P, T, L, log } = ctx, state = cfg.paths.state;
  // A busy commands file must not cut the cycle short: the run file is the record, and the next cycle closes what is left.
  const edit = fn => { try { editCommands(ctx, fn); } catch (e) { log(`commands not updated: ${first(e)}`); } };
  for (const kind of DEPLOYS) {
    const file = `${state}/run-${kind}.json`, r = readJson(file, null);
    // A run that ended while the board was busy never closed its command: the run file is the record, a run older than the command is not.
    const open = readCommands(P.commands).some(c => c.action === kind && c.status === 'running');
    if (r && r.status !== 'running' && open) {
      const ended = idsOf(r);
      edit(c => c.action === kind && c.status === 'running' && ended.includes(String(c.jobId)) && Date.parse(r.endedAt) > Date.parse(c.runAt ?? 0) && Object.assign(c, { status: r.status === 'ok' ? 'done' : 'failed', doneAt: r.endedAt }));
    }
    if (r?.status !== 'running' || alive(r.pid, r.startedAt, 'node')) continue;
    const test = kind === 'deploy-test', endedAt = new Date().toISOString();
    const why = L('deploy.interrupted', { again: L(test && (r.tries ?? 1) < 3 ? 'deploy.retryTest' : 'deploy.clickAgain') });
    writeJson(file, { ...r, status: 'failed', endedAt, note: why, ...(test ? { transient: true } : {}) });
    const ids = idsOf(r), started = Date.parse(r.startedAt) - MIN;
    for (const id of ids) {
      const text = L(test ? 'deploy.testFailed' : 'deploy.failed', { why });
      if (/^\d+$/.test(id)) T.setJob(Number(id), {}, text, false);
      const p = `${P.docs}/${id}.json`;
      if (!/^\d+$/.test(id) && existsSync(p)) {
        const d = readJson(p, {});
        d.events = [...(d.events ?? []), { at: endedAt, text }].slice(-200);
        d.workers = (d.workers ?? []).map(w => (w.status === 'running' && w.round === 99 && Date.parse(w.startedAt) >= started ? { ...w, status: 'failed', endedAt } : w));
        writeJson(p, d);
      }
    }
    edit(c => c.action === kind && c.status === 'running' && ids.includes(String(c.jobId)) && Object.assign(c, { status: 'failed', note: why, doneAt: endedAt }));
    log(`${kind} dead (pid ${r.pid}) marked failed`);
  }
}

// queue.json lists the next issues in order. While fewer than cfg.queue.max factory jobs are open, the first one whose
// "Depends on:" issues are all closed gets the intake label, so new work starts without the owner. Jobs stopped for the owner
// do not hold a slot: the line keeps moving while they wait.
export function feedQueue(ctx) {
  const { cfg, P, mem, log } = ctx;
  if (Date.now() - (mem.lastFeed ?? 0) < 120e3) return;
  mem.lastFeed = Date.now();
  const queue = readJson(P.queue, []);
  if (!queue.length) return;
  const ghj = (...a) => JSON.parse(ctx.gh(...a)), R = cfg.repo;
  const drop = n => locked(P.queue, () => {
    const cur = readJson(P.queue, []), next = cur.filter(x => x !== n);
    if (next.length !== cur.length) writeJson(P.queue, next);
  });
  const open = ghj('issue', 'list', '-R', R, '--label', cfg.intakeLabel, '--state', 'open', '--json', 'number').map(i => i.number);
  const done = new Set(readJson(P.board, { jobs: [] }).jobs.filter(j => ['merged', 'deployed', 'needs-you', 'failed'].includes(j.stage)).map(j => j.issue));
  if (open.filter(n => !done.has(n)).length >= cfg.queue.max) return;
  for (const n of queue) {
    const i = ghj('issue', 'view', String(n), '-R', R, '--json', 'state,body,labels');
    if (i.state !== 'OPEN' || i.labels.some(l => l.name === cfg.intakeLabel)) { drop(n); continue; }
    const deps = [...(i.body.match(/^Depends on: (.+)$/m)?.[1] ?? '').matchAll(/#(\d+)/g)].map(m => m[1]);
    if (deps.some(d => ghj('issue', 'view', d, '-R', R, '--json', 'state').state === 'OPEN')) continue;
    ctx.gh('issue', 'edit', String(n), '-R', R, '--add-label', cfg.intakeLabel);
    drop(n);
    log(`queue: #${n} got the ${cfg.intakeLabel} label`);
    return;
  }
}

// Closes three kinds of leftovers, so no job waits two hours on a slot nobody holds: an agent whose process died without
// reporting (PC restart, crash), an agent still working for a round the job already left (new round, stopped, redo),
// and a slot marked running that no live agent holds (the step died before the launch).
const slots = new WeakMap();
const slotOf = (cfg, w) => {
  if (!slots.has(cfg)) slots.set(cfg, roles(cfg));
  return slots.get(cfg)[w.role]?.slot ?? w.role;
};
const killIf = (pid, startedAt, ...images) => { if (images.some(i => alive(pid, startedAt, i))) killTree(pid); };

export function scanAgents(cfg, j) {
  const run = j.running ?? [], open = (j.workers ?? []).filter(w => w.vendor === 'claude' && w.status === 'running');
  const gone = open.filter(w => !alive(w.pid, w.startedAt, 'node'));
  const old = open.filter(w => !gone.includes(w) && !(w.round === j.round && run.includes(slotOf(cfg, w))));
  const held = new Set(open.filter(w => !gone.includes(w) && !old.includes(w)).map(w => slotOf(cfg, w)));
  return { gone, old, held, stale: run.filter(r => !held.has(r)) };
}

export function reapAgents(ctx) {
  const { cfg, P, T, L, log } = ctx;
  for (const j0 of readJson(P.board, { jobs: [] }).jobs) {
    const f = scanAgents(cfg, j0);
    if (!f.gone.length && !f.old.length && !f.stale.length) continue;
    let event = null, alert = null;
    // Scanned again under the board lock: an agent may have reported between the two reads.
    T.setJob(j0.issue, j => {
      const { gone, old, held, stale } = scanAgents(cfg, j), closed = [...gone, ...old], endedAt = new Date().toISOString(), slot = w => slotOf(cfg, w);
      if (!closed.length && !stale.length) return {};
      for (const w of old) { killIf(w.cpid, w.startedAt, 'claude', 'node'); killIf(w.pid, w.startedAt, 'node'); }
      for (const w of gone) killIf(w.cpid ?? w.pid, w.startedAt, 'claude', 'node');
      const patch = { workers: (j.workers ?? []).map(w => (closed.includes(w) ? { ...w, status: 'failed', endedAt } : w)), ...(stale.length ? { running: (j.running ?? []).filter(r => held.has(r)) } : {}) };
      // A current agent that died without reporting spends a retry like one that answered nothing: a crash at launch cannot loop.
      const notes = [], counted = new Set();
      for (const w of gone.filter(w => w.round === j.round && stale.includes(slot(w)))) {
        const a = readJson(`${P.jobs(j.issue)}/agent-${slot(w)}.json`, null);
        if (a?.id !== w.id) continue;
        const e = T.agentEnd({ ...j, ...patch }, a, false, L('note.agentSilent'));
        Object.assign(patch, e.set); notes.push(e.event); counted.add(slot(w));
        if (e.set.stage === 'needs-you') alert = e.event;
      }
      const lost = stale.filter(r => !counted.has(r));
      if (lost.length) notes.push(L('note.agentLost', { kinds: lost.join(', ') }));
      if (old.length) notes.push(L('note.agentOld', { kinds: old.map(slot).join(', ') }));
      event = notes.join(' ') || null;
      log(`#${j.issue}: ${closed.length} agent(s) closed, slot(s) freed: ${stale.join(', ') || 'none'}`);
      return patch;
    }, () => event, false);
    if (alert) ctx.notify(L('notify.needsYou', { issue: j0.issue, why: alert }));
  }
}

export async function cycle(ctx) {
  const { T, log, mem } = ctx;
  if (!ctx.dry) { reapDead(ctx); reapAgents(ctx); try { feedQueue(ctx); } catch (e) { log('queue failed:', first(e)); } }
  let t;
  try { t = T.tick({ dryRun: ctx.dry, issue: ctx.only }); } catch (e) { throw new Error(`tick failed: ${first(e)}`); }
  // The same waits as the cycle before are not logged again.
  const waits = t.waiting.map(w => `#${w.issue} ${w.stage} on ${w.on}`).join('; ');
  if (t.steps.length || waits !== mem.lastWaits) log(`tick: ${t.steps.length} step(s), ${t.ignored.length} ignored; waiting: ${waits || 'nothing'}`);
  mem.lastWaits = waits;
  if (ctx.dry) { t.steps.forEach(s => dryStep(ctx, s)); return t; }
  const results = [];
  for (const s of t.steps) {
    let r;
    try { r = execStep(ctx, s); } catch (e) { log(`step ${s.step} #${s.issue ?? '-'} not recorded: ${first(e)}`); continue; }
    if (s.command && !r.retry) results.push({ id: s.command, ok: r.ok, failed: r.failed, note: r.note, bg: DEPLOYS.includes(s.step) });
  }
  markCommands(ctx, results);
  return t;
}

// One iteration: loads the config afresh (a bad edit must not kill the runner), runs the cycle and writes the heartbeat
// the dashboard reads for what each job waits on and the vendors' quota.
export async function runCycle(project, o) {
  let error = null, t = null;
  try {
    // A deploy builds inside forja-main, so it is left alone while one runs.
    try { cleanMain(mainDirOf(project), stateDir(project)); } catch {}
    t = await cycle(makeCtx(loadProjectConfig(project), o));
  } catch (e) {
    error = e instanceof ConfigError ? e.errors.join('; ').slice(0, 400) : first(e);
    (o.log ?? ((...a) => console.log(stamp(...a))))('cycle failed:', error);
  }
  if (!o.dry) try { writeJson(`${stateDir(project)}/runner.json`, { pid: process.pid, at: new Date().toISOString(), every: o.every, error, waiting: t?.waiting ?? [], quota: t?.quota ?? {} }); } catch {}
  return { error, t };
}

export const argError = (every, only) => (!(every > 0 && Number.isFinite(every)) ? '--every must be a positive number of seconds' : only !== null && !/^\d+$/.test(only) ? '--issue must be an issue number' : null);

export async function run(argv, o = {}) {
  const args = [...argv], flag = k => args.includes(k), val = (k, d) => (flag(k) ? args[args.indexOf(k) + 1] : d);
  const project = val('--project', process.cwd()), agent = val('--agent', null), dry = flag('--dry-run'), once = flag('--once') || dry;
  const every = Number(val('--every', 15)), only = val('--issue', null), logFile = `${stateDir(project)}/logs/agents.log`;
  const badArg = argError(every, only);
  if (badArg) { (o.err ?? console.error)(badArg); return 1; }
  const base = { gh: o.gh, notify: o.notify, launch: o.launch, dry, once, only: only === null ? null : Number(only), every, mem: {}, pending: new Set() };

  if (agent) {
    // An agent process has no console: its lines go to logs/agents.log.
    const log = o.log ?? ((...a) => { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, `${stamp(...a)}\n`); });
    try { await agentMain(makeCtx(loadProjectConfig(project), { ...base, log }), agent); return 0; } catch (e) { log(`agent ${agent}: ${e.message}`); return 1; }
  }

  const log = o.log ?? ((...a) => console.log(stamp(...a))), err = o.err ?? console.error;
  let release = () => {};
  if (!dry) {
    let lang = 'en'; try { lang = loadProjectConfig(project).language; } catch {}
    try { release = acquireLock(`${stateDir(project)}/.runner.lock`, (k, v) => t(lang, k, v)); } catch (e) { err(e.message); return 1; }
  }
  const stop = () => process.exit(130);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, stop);
  process.on('exit', release);
  try {
    log(`runner ${dry ? 'dry-run' : once ? 'once' : `every ${every}s`}`);
    do {
      await runCycle(project, { ...base, log });
      if (once) { await Promise.all([...base.pending]); break; }
      await new Promise(r => setTimeout(r, every * 1000));
    } while (true);
  } finally {
    release();
    process.off('exit', release);
    for (const s of ['SIGINT', 'SIGTERM']) process.off(s, stop);
  }
  return 0;
}

if (resolve(process.argv[1] ?? '').toLowerCase() === resolve(SELF).toLowerCase()) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--launch') {
    const log = argv[1] === '--log' ? openSync(argv[2], 'a') : 'ignore';
    spawn(process.execPath, argv.slice(log === 'ignore' ? 1 : 3), { stdio: ['ignore', log, log], windowsHide: true }).on('close', code => process.exit(code ?? 1));
  }
  else process.exitCode = await run(argv);
}
