// Table tests for the step decider. Each env is a temp project with its own .forja/config.json and state dir; gh is a fake.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../engine/config.mjs';
import { t } from '../engine/i18n.mjs';
import { paths } from '../engine/state.mjs';
import { createTick, effectiveTier, limitReset, parseAdvice, parseTriage } from '../engine/tick.mjs';

const REPO = resolve(import.meta.dirname, '..').replaceAll('\\', '/');
const put = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
const now = () => new Date().toISOString(), past = '2026-01-01T00:00:00.000Z';
const later = ms => new Date(Date.now() + ms).toISOString();

const TIERS = [
  { id: 'A', describe: 'docs only', paths: ['docs/**', '**/*.md'], reviews: ['code'], approval: 'auto', autoDeploy: true },
  { id: 'B', describe: 'app logic', paths: ['src/**'], reviews: ['code', 'ui?', 'ponytail'], approval: 'auto' },
  { id: 'C', describe: 'risky', reviews: ['code', 'ponytail', 'security', 'data'], approval: 'owner', strongSpec: true, strongApprover: true },
];
const MULTI = {
  repo: 'o/r', approvers: ['owner'], language: 'en',
  vendors: { codex: { enabled: true }, gemini: { enabled: true } },
  tiers: TIERS,
  models: {
    build: { exact: ['local:exact'], small: ['claude:haiku'], medium: ['codex:sol', 'gemini:hydrogen'], hard: ['gemini:neon', 'codex:sol'] },
    review: { code: ['gemini:neon', 'codex:sol'], ui: ['gemini:hydrogen', 'codex:sol'], data: ['claude:fable'] },
    goldfish: ['gemini:hydrogen', 'codex:sol'],
  },
  deferredReviews: ['ponytail', 'security', 'data'],
  reviewers: { data: { agent: '.forja/agents/review-data.md' } },
  checks: { deploy: 'echo deploy', deployTest: 'echo test' },
};
const CLAUDE_ONLY = { repo: 'o/r', approvers: ['owner'], language: 'en', tiers: TIERS.filter(x => x.id !== 'C').concat({ ...TIERS[2], reviews: ['code', 'ponytail', 'security'] }) };

function mkEnv(json = MULTI, gh) {
  const root = mkdtempSync(join(tmpdir(), 'forja-tick-')).replaceAll('\\', '/'), project = `${root}/proj`, calls = [];
  put(`${project}/.forja/config.json`, json);
  const cfg = loadConfig(project, { pluginRoot: REPO }), P = paths(cfg);
  const T = createTick(cfg, { gh: gh ?? ((...a) => { calls.push(a); return ''; }) });
  return { cfg, T, P, J: P.jobs, WT: P.wt, F: cfg.paths.state, project, calls };
}
const job = o => ({ round: 1, fails: 0, reviews: {}, running: [], events: [], since: past, tier: 'B', executor: 'small', entry: 'claude:haiku', ...o });
const R = { code: { verdict: 'PASS' } };
const commands = (E, list) => put(E.P.commands, list.map((c, i) => ({ id: `c${i}`, status: 'pending', note: '', ...c })));
// A build plus a code review written after it: what approve() and merge need.
const reviewed = (E, n, extra = '') => { put(`${E.J(n)}/build.md`, `BUILD: OK\nRound: 1\n${extra}`); put(`${E.J(n)}/round-1/review-code.md`, 'VERDICT: PASS\n'); };
const rmRuns = E => { for (const k of ['deploy', 'deploy-test']) rmSync(`${E.F}/run-${k}.json`, { force: true }); };

const E = mkEnv(), { T, J, F } = E, rv = (n, extra) => reviewed(E, n, extra);

test('redo clears an old approve', () => {
  const board = { jobs: [job({ issue: 1, stage: 'pr', pr: 9, prState: 'open', ci: 'pending', approved: true })] };
  commands(E, [{ jobId: '1', action: 'redo', note: 'change the text' }]);
  const [s] = T.commandSteps(board, {});
  assert.equal(s.step, 'redo');
  assert.equal(s.set.approved, false);
  assert.equal(s.set.round, 2);
  assert.deepEqual(s.do[0], { write: `${J(1)}/round-1/owner.md`, text: 'change the text' });
});

test('a review round that asks for changes clears approved', () => {
  put(`${J(11)}/round-1/review-code.md`, 'VERDICT: CHANGES\n- a.ts:1: bug. fix.\n');
  const s = T.stepFor(job({ issue: 11, stage: 'review', approved: true, reviews: { code: { verdict: 'pending' } } }), {});
  assert.equal(s.step, 'rebuild');
  assert.equal(s.set.approved, false);
});

test('tier A deploys itself only when every merged card allows it', () => {
  rmRuns(E);
  const a = job({ issue: 2, stage: 'merged', tier: 'A' }), b = job({ issue: 3, stage: 'merged', tier: 'B' });
  assert.deepEqual(T.stepFor(a, {}), { step: 'deploy' });
  assert.equal(T.autoDeployOk({ jobs: [a] }), true);
  assert.equal(T.autoDeployOk({ jobs: [a, b] }), false);
  put(`${E.P.docs}/hand-made.json`, { id: 'hand-made', stage: 'merged' });
  assert.equal(T.autoDeployOk({ jobs: [a] }), false);
  put(`${E.P.docs}/hand-made.json`, { id: 'hand-made', stage: 'deployed' });
  put(`${J(2)}/build.md`, 'BUILD: OK\nRound: 1\nProtected: yes\n');
  assert.equal(T.autoDeployOk({ jobs: [a] }), false);
  put(`${J(2)}/build.md`, 'BUILD: OK\nRound: 1\nProtected: no\n');
  assert.equal(T.autoDeployOk({ jobs: [a] }), true);
});

test('a failed deploy keeps the card merged, waiting for the deploy button', () => {
  put(`${F}/run-deploy.json`, { kind: 'deploy', pid: 1, startedAt: now(), endedAt: now(), status: 'failed', issues: [4], note: 'x' });
  assert.deepEqual(T.stepFor(job({ issue: 4, stage: 'merged', tier: 'A' }), {}), { wait: 'owner' });
  put(`${F}/run-deploy.json`, { kind: 'deploy', pid: 1, startedAt: now(), endedAt: now(), status: 'ok', issues: [4] });
  assert.equal(T.stepFor(job({ issue: 4, stage: 'merged', tier: 'A' }), {}).set.stage, 'deployed');
  rmRuns(E);
});

test('an agent that ends without its file is relaunched at once, then after 10 minutes, then goes to needs-you', () => {
  const j = job({ issue: 5, stage: 'spec', round: 0, running: ['spec'] }), a = { agent: 'spec', out: `${J(5)}/spec.md` }, t0 = Date.parse(now());
  for (const [ok, text] of [[true, ''], [true, 'I could not finish.'], [false, 'TIER: A']]) {
    const first = T.agentEnd(j, a, ok, text, t0);
    assert.equal(first.write, undefined);
    assert.equal(first.set.stage, undefined);
    assert.deepEqual(first.set.running, []);
    assert.deepEqual(first.set.agentRetry, ['spec']);
    assert.equal('retryAt' in first.set, false);
    const second = T.agentEnd({ ...j, ...first.set }, a, ok, text, t0);
    assert.equal(second.set.stage, undefined);
    assert.deepEqual(second.set.agentRetry, ['spec', 'spec']);
    assert.equal(Date.parse(second.set.retryAt) - t0, 10 * 60e3);
    const e = T.agentEnd({ ...j, ...second.set }, a, ok, text, t0);
    assert.equal(e.set.stage, 'needs-you');
    assert.ok(e.set.need.why.includes('spec.md'));
    assert.deepEqual(e.set.need.buttons, ['redo']);
    assert.deepEqual(e.set.agentRetry, []);
  }
  const e = T.agentEnd({ ...j, agentRetry: ['spec'] }, a, true, 'Here it is:\n```\nTIER: A\nEXECUTOR: exact\n```');
  assert.equal(e.write, 'TIER: A\nEXECUTOR: exact\n');
  assert.equal(e.set.stage, undefined);
  assert.deepEqual(e.set.agentRetry, []);
});

test('a Claude usage limit spends no retry and gives the reset time from the message, 12 times at most', () => {
  const j = job({ issue: 50, stage: 'review', round: 3, running: ['security', 'data'], agentRetry: ['security', 'security'] }), a = { agent: 'review-security', out: `${J(50)}/round-3/review-security.md` };
  const hit = "You've hit your 5-hour limit · resets 12:10am (America/New_York)", t0 = Date.UTC(2026, 10, 24, 4, 35, 52);
  const e = T.agentEnd(j, a, false, hit, t0);
  assert.equal(e.set.stage, undefined);
  assert.equal(e.set.agentRetry, undefined);
  assert.equal('retryAt' in e.set, false);
  assert.deepEqual(e.set.running, ['data']);
  assert.equal(e.set.limitWaits, 1);
  assert.equal(e.limited, '2026-11-24T05:11:52.000Z');
  assert.equal(limitReset(hit, Date.UTC(2026, 10, 24, 5, 12, 0)), '2026-11-24T05:13:00.000Z');
  assert.equal(limitReset('Claude AI usage limit reached|1795500000', t0), new Date(1795500000e3).toISOString());
  assert.equal(Date.parse(limitReset('API Error: 429 rate limit', t0)) - t0, 3600e3);
  assert.equal(T.agentEnd({ ...j, limitWaits: 12 }, a, false, hit, t0).set.stage, 'needs-you');
  assert.equal(T.agentEnd(j, a, true, 'The code mentions a rate limit.', t0).limited, undefined);
  assert.equal(T.agentEnd({ ...j, limitWaits: 3 }, a, true, 'VERDICT: PASS\n- ok', t0).set.limitWaits, 0);
});

test('while Claude is at its limit no Claude agent is launched; a retry time holds only its own job', () => {
  const until = later(20 * 60e3);
  put(`${F}/quota.json`, { calls: [{ p: 'claude', at: now(), issue: 50, kind: 'security', limited: true, until }] });
  const q = T.quota();
  assert.equal(q.claude.limitedUntil, until);
  assert.equal(T.claudeHeld(q, { step: 'approve', do: [{ agent: 'approver' }] }), true);
  assert.equal(T.claudeHeld(q, { step: 'check', do: [{ bg: 'node call.mjs check 1 claude:haiku 1' }] }), false);
  put(`${F}/quota.json`, { calls: [{ p: 'claude', at: now(), issue: 50, kind: 'security', limited: true, until: past }] });
  assert.equal(T.quota().claude.limitedUntil, null);
  assert.equal(T.claudeHeld(T.quota(), { step: 'approve', do: [{ agent: 'approver' }] }), false);
  put(`${F}/quota.json`, { calls: [] });
  const held = job({ issue: 54, stage: 'approve', retryAt: later(60e3) });
  assert.deepEqual(T.stepFor(held, {}), { wait: 'retry' });
  assert.equal(T.stepFor({ ...held, retryAt: past }, {}).step, 'approve');
  const first = T.agentEnd({ ...held, running: ['approver'] }, { agent: 'approver', out: `${J(54)}/decision.md` }, true, '');
  assert.equal('retryAt' in first.set, false);
});

test('a step that threw is retried after 1, 5 and 15 minutes, then stops; a conflict stops at once', () => {
  const t0 = Date.parse(now());
  let j = job({ issue: 51, stage: 'pr', pr: 9, round: 2 });
  for (const [n, min] of [[1, 1], [2, 5], [3, 15]]) {
    const f = T.stepFailed(j, 'merge', 'gh pr merge 9: fatal: unable to access', t0);
    assert.equal(f.stopped, undefined);
    assert.equal(f.set.stage, undefined);
    assert.deepEqual(f.set.stepFails, { key: 'merge@2', n });
    assert.equal(Date.parse(f.set.retryAt) - t0, min * 60e3);
    j = { ...j, ...f.set };
  }
  const end = T.stepFailed(j, 'merge', 'gh pr merge 9: fatal: unable to access', t0);
  assert.equal(end.stopped, true);
  assert.equal(end.set.stage, 'failed');
  assert.equal(end.set.retryAt, null);
  assert.equal(T.stepFailed({ ...j, stepFails: { key: 'open-pr@2', n: 3 } }, 'merge', 'x', t0).set.stepFails.n, 1);
  const c = T.stepFailed(job({ issue: 52, stage: 'build' }), 'build', 'setup 52: conflict while bringing main into the branch: CONFLICT', t0);
  assert.equal(c.stopped, true);
  assert.equal(c.set.need.action, t('en', 'action.conflict'));
  assert.equal(T.stepFailed(job({ issue: 52, stage: 'pr' }), 'merge', 'X Pull request #9 is not mergeable: the merge commit cannot be cleanly created', t0).stopped, true);
});

test('an approve whose PR step failed waits for the retry time instead of being refused', () => {
  rv(53);
  const held = job({ issue: 53, stage: 'needs-you', reviews: R, retryAt: later(60e3) });
  commands(E, [{ jobId: '53', action: 'approve' }]);
  assert.deepEqual(T.commandSteps({ jobs: [held] }, {}), []);
  assert.equal(T.commandSteps({ jobs: [{ ...held, retryAt: past }] }, {})[0].step, 'open-pr');
  commands(E, []);
});

test('decorated markers count; the approver needs a bare APPROVE above Tier', () => {
  const end = (agent, text) => T.agentEnd(job({ issue: 13 }), { agent, out: 'x.md' }, true, text).write;
  assert.equal(end('review-security', 'Done.\n\n**VERDICT: PASS**\n- ok'), 'VERDICT: PASS\n- ok\n');
  assert.equal(end('builder', 'All good, tests pass.'), 'DONE\nAll good, tests pass.\n');
  assert.equal(end('builder', '**DONE**\nchanged a.ts'), 'DONE\nchanged a.ts\n');
  assert.equal(end('approver', 'APPROVE only holds if CI passes.\nESCALATE\nTier: B\nReason: x'), 'ESCALATE\nTier: B\nReason: x\n');
  assert.equal(end('approver', 'APPROVE only if fine'), undefined);
  put(`${J(14)}/decision.md`, 'APPROVE only holds if…\nESCALATE\nTier: B\nReason: unsure\n');
  assert.equal(T.stepFor(job({ issue: 14, stage: 'approve' }), {}).step, 'escalate');
  put(`${J(15)}/decision.md`, 'APPROVE\nTier: B\nPR title: Fix a\n');
  assert.equal(T.stepFor(job({ issue: 15, stage: 'approve' }), {}).step, 'open-pr');
});

test('a failed card whose PR the owner merged becomes merged; the merge is pinned to the read head', () => {
  assert.equal(T.stepFor(job({ issue: 16, stage: 'failed', pr: 9, prState: 'merged' }), {}).set.stage, 'merged');
  assert.equal(T.stepFor(job({ issue: 16, stage: 'failed', pr: 9, prState: 'open' }), {}), null);
  rv(17);
  const sha = 'a'.repeat(40), s = T.stepFor(job({ issue: 17, reviews: R, stage: 'pr', pr: 9, prState: 'open', ci: 'pass', tier: 'A', prHead: sha }), {});
  assert.equal(s.step, 'merge');
  assert.match(s.do[0].run, new RegExp(`--match-head-commit ${sha}$`));
});

test('the doc recomputes the buttons from the current state', () => {
  put(E.P.board, { jobs: [job({ issue: 18, stage: 'failed', reviews: R, need: { why: 'x', action: 'y', buttons: ['redo'] } })] });
  T.setJob(18, {});
  assert.deepEqual(JSON.parse(readFileSync(`${E.P.docs}/18.json`, 'utf8')).need.buttons, ['redo']);
  rv(18);
  T.setJob(18, {});
  assert.deepEqual(JSON.parse(readFileSync(`${E.P.docs}/18.json`, 'utf8')).need.buttons, ['approve', 'redo']);
});

test('no tier A auto-deploy next to a deploy test in the same tick', () => {
  rmRuns(E);
  const board = { jobs: [job({ issue: 19, stage: 'merged', tier: 'A' })] };
  assert.equal(T.canAutoDeploy(board, []), true);
  assert.equal(T.canAutoDeploy(board, [{ step: 'deploy-test' }]), false);
});

test('double approve on an open PR re-pushes the head once and never merges directly', () => {
  rv(7);
  const board = { jobs: [job({ issue: 7, stage: 'needs-you', reviews: R, pr: 9, prState: 'open', ci: 'pass' })] };
  commands(E, [{ jobId: '7', action: 'approve' }, { jobId: '7', action: 'approve' }]);
  const steps = T.commandSteps(board, {});
  assert.deepEqual(steps.map(s => s.step), ['open-pr', 'refuse']);
  assert.match(steps[0].do[0].run, / pr 7$/);
  assert.ok(steps[0].do[0].run.startsWith('node '));
  assert.equal(steps[0].set.approved, true);
  assert.equal(steps.filter(s => s.step === 'merge').length, 0);
});

test('approve is refused on a red PR and offered only when there is something to approve', () => {
  const red = job({ issue: 8, stage: 'failed', pr: 9, prState: 'open', ci: 'fail' });
  commands(E, [{ jobId: '8', action: 'approve' }]);
  assert.equal(T.commandSteps({ jobs: [red] }, {})[0].step, 'refuse');
  rv(81);
  assert.equal(T.commandSteps({ jobs: [{ ...red, issue: 81, reviews: R }] }, {})[0].step, 'refuse');
  assert.deepEqual(T.needOf(job({ issue: 12, reviews: R }), 'x', 'y').buttons, ['redo']);
  rv(12);
  assert.deepEqual(T.needOf(job({ issue: 12, reviews: R }), 'x', 'y').buttons, ['approve', 'redo']);
});

test('a run file from before the last boot is dead; a live one holds the step', () => {
  put(`${J(10)}/run-build.json`, { kind: 'build', pid: process.pid, startedAt: past, status: 'running' });
  const j = job({ issue: 10, stage: 'build', executor: 'medium', entry: 'codex:sol' });
  assert.equal(T.stepFor(j, {}).step, 'build');
  put(`${J(10)}/run-build.json`, { kind: 'build', pid: process.pid, startedAt: now(), status: 'running' });
  assert.deepEqual(T.stepFor(j, {}), { wait: 'build' });
});

test('commands with a bad id, or deploys while one runs, are refused', () => {
  rmRuns(E);
  commands(E, [{ jobId: 'x; rm -rf /', action: 'deploy-test' }]);
  const [bad] = T.commandSteps({ jobs: [] }, {});
  assert.equal(bad.step, 'refuse');
  assert.equal(bad.issue, null);
  put(`${F}/run-deploy-test.json`, { kind: 'deploy-test', pid: process.pid, startedAt: now(), status: 'running' });
  commands(E, [{ jobId: '2', action: 'deploy' }]);
  const merged = { jobs: [job({ issue: 2, stage: 'merged' })] };
  assert.equal(T.commandSteps(merged, {})[0].step, 'refuse');
  rmRuns(E);
  assert.equal(T.commandSteps(merged, {})[0].step, 'deploy');
  commands(E, [{ jobId: '2', action: 'nuke' }]);
  assert.equal(T.commandSteps(merged, {})[0].step, 'refuse');
  commands(E, []);
});

test('tier A and tier B merge themselves on green CI; tier C waits for approve', () => {
  rv(60); rv(61);
  const pr = o => job({ stage: 'pr', pr: 9, prState: 'open', ci: 'pass', reviews: R, ...o });
  for (const tier of ['A', 'B']) {
    assert.equal(T.stepFor(pr({ issue: 60, tier }), {}).step, 'merge');
    assert.deepEqual(T.stepFor(pr({ issue: 60, tier, ci: 'pending' }), {}), { wait: 'ci' });
  }
  const c = T.stepFor(pr({ issue: 61, tier: 'C' }), {});
  assert.equal(c.step, 'escalate');
  assert.equal(c.set.stage, 'needs-you');
  assert.deepEqual(c.set.need.buttons, ['approve', 'redo']);
  assert.equal(T.stepFor(pr({ issue: 61, tier: 'C', approved: true }), {}).step, 'merge');
  assert.equal(T.stepFor(pr({ issue: 61, tier: 'C', prCmd: { cmd: 'approve', note: '' } }), {}).step, 'merge');
  assert.equal(T.stepFor(pr({ issue: 62, tier: undefined }), {}).step, 'escalate');
  put(`${J(63)}/decision.md`, 'APPROVE\nTier: B\nPR title: Fix a\n');
  const open = T.stepFor(job({ issue: 63, stage: 'approve', tier: 'B' }), {});
  assert.equal(open.step, 'open-pr');
  assert.equal(open.set.approved, undefined);
});

test('a deploy test starts by itself after a merge, once, and never next to another deploy', () => {
  rmRuns(E);
  const run = `${F}/run-deploy-test.json`, merged = job({ issue: 64, stage: 'merged', tier: 'B', since: '2026-06-01T10:00:00.000Z' });
  const board = { jobs: [merged, job({ issue: 65, stage: 'build' })] };
  put(run, { kind: 'deploy-test', pid: 1, startedAt: '2026-06-01T09:00:00.000Z', endedAt: '2026-06-01T09:10:00.000Z', status: 'ok' });
  const s = T.autoTest(board, []);
  assert.equal(s.step, 'deploy-test');
  assert.match(s.do[0].bg, / deploy-test 64$/);
  assert.equal(T.autoTest(board, [{ step: 'deploy' }]), null);
  assert.equal(T.autoTest(board, [{ step: 'deploy-test' }]), null);
  assert.equal(T.autoTest({ jobs: [job({ issue: 65, stage: 'build' })] }, []), null);
  put(run, { kind: 'deploy-test', pid: process.pid, startedAt: now(), status: 'running' });
  assert.equal(T.autoTest(board, []), null);
  put(`${F}/run-deploy.json`, { kind: 'deploy', pid: process.pid, startedAt: now(), status: 'running' });
  put(run, { kind: 'deploy-test', pid: 1, startedAt: '2026-06-01T09:00:00.000Z', endedAt: '2026-06-01T09:10:00.000Z', status: 'ok' });
  assert.equal(T.autoTest(board, []), null);
  put(`${F}/run-deploy.json`, { kind: 'deploy', pid: 1, startedAt: past, endedAt: past, status: 'ok', issues: [] });
  put(run, { kind: 'deploy-test', pid: 1, startedAt: '2026-06-01T11:00:00.000Z', endedAt: '2026-06-01T11:10:00.000Z', status: 'ok' });
  assert.equal(T.autoTest(board, []), null);
  put(run, { kind: 'deploy-test', pid: 1, startedAt: '2026-06-01T11:00:00.000Z', endedAt: '2026-06-01T11:10:00.000Z', status: 'failed', note: 'verify:ui' });
  assert.equal(T.autoTest(board, []), null);
  rmRuns(E);
});

test('a deploy test that was interrupted runs again after 5 minutes, three times at most', () => {
  const run = `${F}/run-deploy-test.json`, board = { jobs: [job({ issue: 64, stage: 'merged', tier: 'B', since: '2026-06-01T10:00:00.000Z' })] };
  const ended = Date.parse('2026-06-01T11:10:00.000Z'), dropped = o => put(run, { kind: 'deploy-test', pid: 1, startedAt: '2026-06-01T11:00:00.000Z', endedAt: new Date(ended).toISOString(), status: 'failed', transient: true, ...o });
  dropped({});
  assert.equal(T.autoTest(board, [], ended + 60e3), null);
  assert.equal(T.autoTest(board, [], ended + 6 * 60e3).step, 'deploy-test');
  dropped({ tries: 2 });
  assert.equal(T.autoTest(board, [], ended + 6 * 60e3).step, 'deploy-test');
  dropped({ tries: 3 });
  assert.equal(T.autoTest(board, [], ended + 6 * 60e3), null);
  rmRuns(E);
});

test('deferred reviews run only after the others pass, except in the last round', () => {
  put(`${J(70)}/build.md`, 'BUILD: OK\nExecutor: claude:sonnet\nUI: no\n');
  const built = T.stepFor(job({ issue: 70, stage: 'build', tier: 'C', executor: 'medium', entry: 'claude:sonnet' }), {});
  assert.equal(built.step, 'review');
  assert.deepEqual(Object.keys(built.set.reviews), ['code', 'ponytail', 'security', 'data']);
  assert.deepEqual(built.set.running, []);
  assert.equal(built.do.length, 1);
  assert.match(built.do[0].bg, / review 70 code gemini:neon 1$/);
  const j = job({ issue: 70, stage: 'review', tier: 'C', executor: 'medium', entry: 'claude:sonnet', reviews: built.set.reviews });
  put(`${J(70)}/run-review-code.json`, { kind: 'review-code', pid: process.pid, startedAt: now(), status: 'running' });
  assert.deepEqual(T.stepFor(j, {}), { wait: 'reviews' });
  put(`${J(70)}/run-review-code.json`, { kind: 'review-code', pid: 1, startedAt: past, endedAt: past, status: 'ok' });
  put(`${J(70)}/round-1/review-code.md`, 'VERDICT: CHANGES\n- a.ts:1: bug. fix.\n');
  const back = T.stepFor(j, {});
  assert.equal(back.step, 'rebuild');
  assert.equal(back.set.reviews.code.verdict, 'CHANGES');
  assert.equal(back.set.reviews.security.verdict, 'pending');
  assert.equal(back.do.some(d => /^review-/.test(d.agent ?? '')), false);
  put(`${J(70)}/round-1/review-code.md`, 'VERDICT: PASS\n- checked: a.ts:1 guards the null case.\n');
  const claude = T.stepFor(j, {});
  assert.equal(claude.step, 'review');
  assert.deepEqual(claude.do.map(d => d.agent), ['review-ponytail', 'review-security', 'review-data']);
  assert.deepEqual(claude.do.map(d => d.model), ['sonnet', 'opus', 'fable']);
  assert.deepEqual(claude.set.running, ['ponytail', 'security', 'data']);
  const one = T.stepFor({ ...j, running: ['ponytail', 'security'], since: now() }, {});
  assert.deepEqual(one.do.map(d => d.agent), ['review-data']);
  assert.deepEqual(one.set.running, ['ponytail', 'security', 'data']);
  for (const k of ['ponytail', 'security', 'data']) put(`${J(70)}/round-1/review-${k}.md`, 'VERDICT: PASS\n- ok\n');
  const ok = T.stepFor(j, {});
  assert.equal(ok.step, 'approve');
  assert.equal(ok.do[0].agent, 'approver');
  assert.equal(ok.do[0].model, 'opus');
  put(`${J(70)}/round-3/review-code.md`, 'VERDICT: CHANGES\n- a.ts:1: bug. fix.\n');
  const last = T.stepFor({ ...j, round: 3 }, {});
  assert.equal(last.step, 'review');
  assert.deepEqual(last.do.map(d => d.agent), ['review-ponytail', 'review-security', 'review-data']);
  for (const k of ['ponytail', 'security', 'data']) put(`${J(70)}/round-3/review-${k}.md`, 'VERDICT: PASS\n- ok\n');
  const asked = T.stepFor({ ...j, round: 3 }, {});
  assert.equal(asked.step, 'escalate');
  assert.equal(asked.set.reviews.security.verdict, 'PASS');
});

test('a spec without a valid TIER is rewritten once, then goes to the owner', () => {
  put(`${J(71)}/spec.md`, 'TIER: D\nEXECUTOR: small\n');
  const j = job({ issue: 71, stage: 'spec', round: 0, tier: undefined });
  const s = T.stepFor(j, {});
  assert.equal(s.step, 'retry');
  assert.deepEqual(s.set, { running: ['spec'], stepRetry: ['spec@0'] });
  assert.equal(s.do[0].agent, 'spec');
  assert.equal(T.stepFor({ ...j, stepRetry: ['spec@0'] }, {}).step, 'fail');
});

test('the board keeps every change when several processes write at once; a worker of an unknown job is refused', async () => {
  put(E.P.board, { jobs: [job({ issue: 72, stage: 'build' })] });
  const code = `const { loadConfig } = await import(${JSON.stringify(new URL('../engine/config.mjs', import.meta.url).href)});
    const { createTick } = await import(${JSON.stringify(new URL('../engine/tick.mjs', import.meta.url).href)});
    const T = createTick(loadConfig(${JSON.stringify(E.project)}, { pluginRoot: ${JSON.stringify(REPO)} }));
    for (let i = 0; i < 8; i++) T.setJob(72, j => ({ note: String(j.events.length) }), 'w' + process.argv[1] + '-' + i);`;
  await Promise.all([1, 2, 3, 4, 5].map(w => new Promise((ok, bad) => execFile(process.execPath, ['--input-type=module', '-e', code, String(w)], e => (e ? bad(e) : ok())))));
  const board = () => JSON.parse(readFileSync(E.P.board, 'utf8'));
  const j = board().jobs.find(x => x.issue === 72);
  assert.equal(j.events.length, 40);
  assert.equal(j.note, '39');
  let late = null;
  T.setJob(72, x => { late = `round ${x.round}`; return {}; }, () => late);
  assert.equal(board().jobs.find(x => x.issue === 72).events.at(-1).text, 'round 1');
  assert.equal(T.upsertWorker(73, { id: 'x' }), null);
  T.upsertWorker(72, { id: 'build-1-sol', status: 'running' });
  T.upsertWorker(72, { id: 'build-1-sol', status: 'ok' });
  assert.deepEqual(board().jobs.find(x => x.issue === 72).workers, [{ id: 'build-1-sol', status: 'ok' }]);
});

test('a red CI starts the next round with the CI log, then stops after the last round', () => {
  const s = T.stepFor(job({ issue: 40, stage: 'pr', pr: 9, prState: 'open', ci: 'fail', approved: true }), {});
  assert.equal(s.step, 'ci-redo');
  assert.equal(s.set.round, 2);
  assert.equal(s.set.approved, false);
  assert.match(s.do[0].run, / cilog 40 1 9$/);
  assert.equal(T.stepFor(job({ issue: 41, stage: 'pr', pr: 9, prState: 'open', ci: 'fail', round: 3 }), {}).step, 'fail');
});

test('a crashed review relaunches once, then fails', () => {
  put(`${J(42)}/run-review-code.json`, { status: 'failed', note: 'spawnSync agy ENAMETOOLONG', endedAt: now() });
  const j = job({ issue: 42, stage: 'review', reviews: { code: { verdict: 'pending' } } });
  const s = T.stepFor(j, {});
  assert.equal(s.step, 'retry');
  assert.deepEqual(s.set.stepRetry, ['review-code@1']);
  assert.match(s.do[0].bg, / review 42 code gemini:neon 1$/);
  assert.equal(T.stepFor({ ...j, stepRetry: ['review-code@1'] }, {}).step, 'fail');
  const again = T.stepFor({ ...j, workers: [{ role: 'review-code', round: 1, model: 'gemini:neon', status: 'failed' }] }, {});
  assert.match(again.do[0].bg, / review 42 code codex:sol 1$/);
});

test('approve is refused while reviews are pending', () => {
  put(`${J(43)}/build.md`, 'BUILD: OK\n');
  const board = { jobs: [job({ issue: 43, stage: 'failed', reviews: { code: { verdict: 'pending' } } })] };
  commands(E, [{ jobId: '43', action: 'approve' }]);
  const [s] = T.commandSteps(board, {});
  assert.equal(s.step, 'refuse');
  assert.equal(s.note, t('en', 'refuse.reviewsPending', { kinds: 'code' }));
  commands(E, []);
});

test('nothing merges or gets approved unless the build that would merge was reviewed', () => {
  put(`${J(44)}/build.md`, 'BUILD: OK\nRound: 2\n');
  const j = job({ issue: 44, round: 2, stage: 'pr', pr: 9, prState: 'open', ci: 'pass', tier: 'B', reviews: R });
  assert.equal(T.stepFor(j, {}).step, 'fail');
  assert.ok(T.unreviewed(j));
  put(`${J(44)}/round-2/review-code.md`, 'VERDICT: PASS\n');
  assert.equal(T.stepFor(j, {}).step, 'merge');
  assert.equal(T.unreviewed(j), '');
});

const specStep = (n, specTier, triage) => {
  put(`${J(n)}/spec.md`, `TIER: ${specTier}\nEXECUTOR: exact\nBRANCH: forja/${n}-x\n`);
  if (triage) put(`${J(n)}/triage.json`, { bucket: 'factory', reason: 'because yes', model: 'm', ms: 1, ...triage });
  return T.stepFor(job({ issue: n, stage: 'spec', round: 0, tier: undefined, specRevised: true, specModel: 'opus' }), {});
};

test('local triage can raise the tier, never lower it, and "?" changes nothing', () => {
  const up = specStep(90, 'A', { tier: 'B' });
  assert.equal(up.set.tier, 'B');
  assert.ok(up.event.includes('because yes'));
  assert.equal(specStep(91, 'B', { tier: 'C' }).set.tier, 'C');
  for (const [spec, tri] of [['C', 'A'], ['C', 'B'], ['B', 'A'], ['B', 'B'], ['A', '?']]) {
    const s = specStep(92, spec, { tier: tri });
    assert.equal(s.set.tier, spec);
    assert.ok(!s.event.includes('because yes'));
  }
  assert.equal(specStep(93, 'B', null).set.tier, 'B');
  assert.equal(specStep(96, 'B', { tier: '?', bucket: 'supervisor', reason: 'triage failed' }).set.tier, 'B');
  assert.equal(effectiveTier(E.cfg, 'B', { tier: 'C' }), 'C');
  assert.equal(effectiveTier(E.cfg, 'B', { tier: 'A' }), 'B');
});

test('a tier raised to a strong-spec tier sends the spec to the strong model; a raise from A asks for the blind check', () => {
  put(`${J(94)}/spec.md`, 'TIER: B\nEXECUTOR: exact\nBRANCH: forja/94-x\n');
  put(`${J(94)}/triage.json`, { tier: 'C', bucket: 'supervisor', reason: 'touches money', model: 'm', ms: 1 });
  const s = T.stepFor(job({ issue: 94, stage: 'spec', round: 0, tier: undefined, specModel: 'sonnet' }), {});
  assert.equal(s.set.specModel, 'opus');
  assert.equal(s.do[0].agent, 'spec');
  assert.equal(s.do[0].model, 'opus');
  assert.equal(s.do[0].cwd, E.cfg.paths.main);
  put(`${J(95)}/spec.md`, 'TIER: A\nEXECUTOR: exact\nBRANCH: forja/95-x\n');
  put(`${J(95)}/triage.json`, { tier: 'B', bucket: 'factory', reason: 'logic', model: 'm', ms: 1 });
  const g = T.stepFor(job({ issue: 95, stage: 'spec', round: 0, tier: undefined }), {});
  assert.equal(g.step, 'goldfish');
  assert.match(g.do[0].bg, / goldfish 95 gemini:hydrogen$/);
});

test('triage parsing is strict and takes any configured tier', () => {
  const ok = { tier: 'B', bucket: 'supervisor', reason: ' line\n two ', extra: 'x' };
  assert.deepEqual(parseTriage(E.cfg, JSON.stringify(ok)), { tier: 'B', bucket: 'supervisor', reason: 'line two' });
  for (const bad of ['', 'nope', '[]', '{"tier":"D","bucket":"factory","reason":"x"}', '{"tier":"A","bucket":"x","reason":"x"}', '{"tier":"A","bucket":"factory","reason":1}', '{"tier":"A","bucket":"factory","reason":"  "}', '{"tier":"?","bucket":"factory","reason":"x"}']) assert.equal(parseTriage(E.cfg, bad), null);
});

test('advisor output keeps only a valid action and never recommends a refused approve', () => {
  assert.deepEqual(parseAdvice('REC: approve\nWHY: all passed.\nDONE: opened index.json.', ['approve', 'redo']), { rec: 'approve', why: 'all passed.', done: 'opened index.json.' });
  assert.equal(parseAdvice('REC: approve\nWHY: x', ['redo']), null);
  assert.equal(parseAdvice('REC: redo\nWHY: x', ['redo']), null);
  assert.equal(parseAdvice('REC: merge\nWHY: x', ['approve']), null);
  assert.equal(parseAdvice('**REC:** redo\nWHY: missing test\nNOTE: add a test', ['redo']).note, 'add a test');
  assert.equal(parseAdvice('REC: aprovar\nWHY: tudo passou', ['approve', 'redo']).rec, 'approve');
  assert.equal(parseAdvice('REC: refazer\nWHY: falta teste\nNOTE: add a test', ['redo']).rec, 'redo');
});

test('an external vendor that hit its limit without a reset time waits an hour', () => {
  put(`${F}/quota.json`, { calls: [{ p: 'gemini', at: now(), issue: 50, kind: 'build', limited: true }] });
  assert.ok(Date.parse(T.quota().gemini.limitedUntil) > Date.now() + 50 * 60e3);
  assert.equal(T.stepFor(job({ issue: 97, stage: 'build', executor: 'hard', entry: 'gemini:neon' }), T.quota()).do[0].bg.endsWith(' build 97 codex:sol 1'), true);
  put(`${F}/quota.json`, { calls: [] });
});

test('a build with every external vendor limited falls back to a Claude builder', () => {
  put(`${F}/quota.json`, { calls: ['codex', 'gemini'].map(p => ({ p, at: now(), issue: 1, kind: 'build', limited: true })) });
  const s = T.stepFor(job({ issue: 98, stage: 'build', executor: 'medium', entry: 'codex:sol' }), T.quota());
  assert.equal(s.step, 'build');
  assert.equal(s.set.entry, 'claude:sonnet');
  assert.deepEqual(s.set.running, ['builder']);
  assert.equal(s.do.find(d => d.agent).model, 'sonnet');
  put(`${F}/quota.json`, { calls: [] });
});

test('the build ladder retries once, escalates over the configured sizes and fails at the end', () => {
  put(`${J(99)}/build.md`, 'BUILD: FAILED\nchecks failed\n');
  const j = job({ issue: 99, stage: 'build', executor: 'medium', entry: 'codex:sol', since: '2026-01-01T00:00:00.000Z' });
  const retry = T.stepFor(j, {});
  assert.equal(retry.step, 'build-retry');
  assert.equal(retry.set.fails, 1);
  assert.equal(retry.set.executor, 'medium');
  const up = T.stepFor({ ...j, fails: 1 }, {});
  assert.equal(up.set.executor, 'hard');
  assert.equal(up.set.fails, 0);
  assert.match(up.do[0].bg, / build 99 gemini:neon 1$/);
  assert.equal(T.stepFor({ ...j, fails: 1, executor: 'hard' }, {}).step, 'fail');
});

test('claude-only medium build runs the builder agent on sonnet', () => {
  const C = mkEnv(CLAUDE_ONLY);
  put(`${C.J(1)}/spec.md`, 'TIER: B\nEXECUTOR: medium\nBRANCH: forja/1-x\n');
  const s = C.T.stepFor(job({ issue: 1, stage: 'spec', round: 0, tier: undefined, specModel: 'sonnet', specRevised: true }), {});
  assert.equal(s.step, 'build');
  assert.equal(s.set.executor, 'medium');
  assert.equal(s.set.entry, 'claude:sonnet');
  assert.deepEqual(s.set.running, ['builder']);
  assert.match(s.do[0].run, / setup 1$/);
  assert.deepEqual({ ...s.do[1], prompt: undefined }, { agent: 'builder', model: 'sonnet', issue: 1, round: 1, out: `${C.J(1)}/builder.md`, cwd: C.cfg.paths.main, prompt: undefined });
});

test('an unknown spec EXECUTOR size becomes small', () => {
  const C = mkEnv(CLAUDE_ONLY);
  put(`${C.J(1)}/spec.md`, 'TIER: B\nEXECUTOR: gigantic\nBRANCH: forja/1-x\n');
  const s = C.T.stepFor(job({ issue: 1, stage: 'spec', round: 0, tier: undefined, specModel: 'sonnet', specRevised: true }), {});
  assert.equal(s.set.executor, 'small');
  assert.equal(s.do.find(d => d.agent).model, 'haiku');
});

test('claude-only review runs the same-model reviewer agent', () => {
  const C = mkEnv(CLAUDE_ONLY);
  put(`${C.J(2)}/build.md`, 'BUILD: OK\nExecutor: claude:sonnet\nUI: no\n');
  const s = C.T.stepFor(job({ issue: 2, stage: 'build', tier: 'B', executor: 'medium', entry: 'claude:sonnet' }), {});
  assert.equal(s.step, 'review');
  assert.deepEqual(Object.keys(s.set.reviews), ['code', 'ponytail']);
  assert.deepEqual(s.do.map(d => [d.agent, d.model, d.cwd]), [['review-code', 'sonnet', C.cfg.paths.main]]);
  assert.deepEqual(s.set.running, ['code']);
});

test('build waits on quota when pick returns null', () => {
  const C = mkEnv(CLAUDE_ONLY);
  put(`${C.F}/quota.json`, { calls: [{ p: 'claude', at: now(), issue: 1, kind: 'build', limited: true, until: later(30 * 60e3) }] });
  const q = C.T.quota();
  assert.deepEqual(C.T.stepFor(job({ issue: 3, stage: 'build', executor: 'medium', entry: null }), q), { wait: 'quota' });
  put(`${C.J(4)}/spec.md`, 'TIER: A\nEXECUTOR: medium\nBRANCH: forja/4-x\n');
  const s = C.T.stepFor(job({ issue: 4, stage: 'spec', round: 0, tier: undefined, specModel: 'sonnet' }), q);
  assert.equal(s.step, 'build');
  assert.deepEqual(s.do, []);
  assert.equal(s.set.entry, null);
  assert.deepEqual(s.set.running, []);
});

test('protected diff forces owner approval on an auto tier', () => {
  rv(110, 'Protected: yes\n');
  const pr = o => job({ issue: 110, stage: 'pr', pr: 9, prState: 'open', ci: 'pass', tier: 'A', reviews: R, ...o });
  const s = T.stepFor(pr(), {});
  assert.equal(s.step, 'escalate');
  assert.equal(s.set.stage, 'needs-you');
  assert.ok(s.do[0].notify);
  assert.equal(T.stepFor(pr({ approved: true }), {}).step, 'merge');
  assert.equal(T.stepFor(pr({ prCmd: { cmd: 'approve', note: '' } }), {}).step, 'merge');
});

test('auto tier merges on green CI when not protected', () => {
  rv(111, 'Protected: no\n');
  rv(112);
  for (const n of [111, 112]) assert.equal(T.stepFor(job({ issue: n, stage: 'pr', pr: 9, prState: 'open', ci: 'pass', tier: 'A', reviews: R }), {}).step, 'merge');
  assert.deepEqual(T.stepFor(job({ issue: 111, stage: 'pr', pr: 9, prState: 'open', ci: 'pending', tier: 'A', reviews: R }), {}), { wait: 'ci' });
});

test('goldfish is skipped when only the spec model is available', () => {
  const C = mkEnv(CLAUDE_ONLY);
  put(`${C.J(5)}/spec.md`, 'TIER: B\nEXECUTOR: small\nBRANCH: forja/5-x\n');
  const s = C.T.stepFor(job({ issue: 5, stage: 'spec', round: 0, tier: undefined, specModel: 'sonnet' }), {});
  assert.equal(s.step, 'build');
  assert.ok(s.event.includes(t('en', 'event.goldfishSkipped')));
  const strong = C.T.stepFor(job({ issue: 5, stage: 'spec', round: 0, tier: undefined, specModel: 'opus' }), {});
  assert.equal(strong.step, 'goldfish');
  assert.match(strong.do[0].bg, / goldfish 5 claude:sonnet$/);
  const off = mkEnv({ ...CLAUDE_ONLY, goldfish: false });
  put(`${off.J(5)}/spec.md`, 'TIER: B\nEXECUTOR: small\nBRANCH: forja/5-x\n');
  const o = off.T.stepFor(job({ issue: 5, stage: 'spec', round: 0, tier: undefined, specModel: 'opus' }), {});
  assert.equal(o.step, 'build');
  assert.ok(!o.event.includes(t('en', 'event.goldfishSkipped')));
});

test('deferred review waits until code passes before the round limit', () => {
  const C = mkEnv({ ...CLAUDE_ONLY, limits: { rounds: 2 } });
  put(`${C.J(6)}/build.md`, 'BUILD: OK\nExecutor: claude:sonnet\n');
  const j = job({ issue: 6, stage: 'review', tier: 'B', executor: 'medium', entry: 'claude:sonnet', reviews: { code: { verdict: 'pending' }, ponytail: { verdict: 'pending' } } });
  assert.deepEqual(C.T.stepFor(j, {}).do.map(d => d.agent), ['review-code']);
  put(`${C.J(6)}/round-1/review-code.md`, 'VERDICT: CHANGES\n- a.ts:1: bug. fix.\n');
  assert.equal(C.T.stepFor(j, {}).step, 'rebuild');
  const last = { ...j, round: 2 };
  put(`${C.J(6)}/round-2/review-code.md`, 'VERDICT: CHANGES\n- a.ts:1: bug. fix.\n');
  assert.deepEqual(C.T.stepFor(last, {}).do.map(d => d.agent), ['review-ponytail']);
  put(`${C.J(6)}/round-2/review-ponytail.md`, 'VERDICT: PASS\n- ok\n');
  assert.equal(C.T.stepFor(last, {}).step, 'escalate');
});

test('merged is terminal without a deploy command', () => {
  const C = mkEnv(CLAUDE_ONLY);
  assert.equal(C.T.stepFor(job({ issue: 7, stage: 'merged', tier: 'A' }), {}), null);
  put(C.P.board, { jobs: [job({ issue: 7, stage: 'merged', tier: 'A' })] });
  put(C.P.commands, []);
  const gh = (...a) => (a[0] === 'issue' && a[1] === 'list' ? '[]' : '');
  const r = createTick(C.cfg, { gh }).tick({ dryRun: true });
  assert.deepEqual([r.steps, r.waiting], [[], []]);
  commands(C, [{ jobId: '7', action: 'deploy' }, { jobId: '7', action: 'deploy-test' }]);
  assert.deepEqual(C.T.commandSteps({ jobs: [job({ issue: 7, stage: 'merged', tier: 'A' })] }, {}).map(s => s.step), ['refuse', 'refuse']);
  C.T.setJob(7, { stage: 'merged' });
  C.T.setJob(8, { stage: 'spec' });
  C.T.setJob(8, { stage: 'merged' });
  assert.ok(C.calls.some(c => c.includes('forja:done')));
});

test('relabel uses the fixed forja labels', () => {
  const C = mkEnv(CLAUDE_ONLY);
  C.T.setJob(9, { stage: 'spec' });
  C.T.setJob(9, { stage: 'build' });
  const edits = C.calls.filter(c => c[1] === 'edit').map(c => c.slice(c.indexOf('--add-label') + 1, c.indexOf('--add-label') + 2)[0]);
  assert.deepEqual(edits, ['forja:spec', 'forja:build']);
});

const prGh = (comments, extra = {}) => (...a) => {
  if (a[0] === 'issue' && a[1] === 'list') return '[]';
  if (a[0] === 'pr' && a[1] === 'view') return JSON.stringify({ state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], headRefOid: 'b'.repeat(40), comments, ...extra });
  return '';
};

test('an approver in cfg.approvers can /aprovar in pt-BR', () => {
  const C = mkEnv({ ...MULTI, approvers: ['owner', 'second'], language: 'pt-BR' });
  reviewed(C, 20);
  put(C.P.board, { jobs: [job({ issue: 20, stage: 'needs-you', pr: 9, reviews: R, note: 'n', ai: null })] });
  const comment = (login, body) => ({ author: { login }, body, createdAt: later(60e3) });
  const run = comments => createTick(C.cfg, { gh: prGh(comments) }).tick({ dryRun: true });
  assert.deepEqual(run([comment('second', '/aprovar')]).steps.map(s => [s.issue, s.step]), [[20, 'open-pr']]);
  assert.deepEqual(run([comment('owner', '/approve')]).steps.map(s => s.step), ['open-pr']);
  assert.deepEqual(run([comment('stranger', '/aprovar')]).steps, []);
  const redo = run([comment('second', '/refazer faz de novo')]).steps[0];
  assert.equal(redo.step, 'redo');
  assert.equal(redo.do[0].text, 'faz de novo');
  assert.deepEqual(run([comment('second', '/refazer faz de novo'), comment('second', '/aprovar')]).steps.map(s => s.step), ['open-pr']);
});

test('a PR command in en does not accept the pt-BR alias', () => {
  const C = mkEnv(MULTI);
  reviewed(C, 21);
  put(C.P.board, { jobs: [job({ issue: 21, stage: 'needs-you', pr: 9, reviews: R, note: 'n', ai: null })] });
  const r = createTick(C.cfg, { gh: prGh([{ author: { login: 'owner' }, body: '/aprovar', createdAt: later(60e3) }]) }).tick({ dryRun: true });
  assert.deepEqual(r.steps, []);
});

test('a label by a non-approver is ignored', () => {
  const by = login => (...a) => (a[0] === 'issue' && a[1] === 'list' ? JSON.stringify([{ number: 5, title: 'Add a thing' }]) : a[0] === 'api' ? `${login}\n` : '');
  const C = mkEnv(MULTI);
  const ignored = createTick(C.cfg, { gh: by('stranger') }).tick({ dryRun: true });
  assert.deepEqual(ignored.ignored, [{ issue: 5, labeledBy: 'stranger' }]);
  assert.deepEqual(ignored.steps, []);
  const taken = createTick(C.cfg, { gh: by('owner') }).tick({ dryRun: true });
  assert.deepEqual(taken.ignored, []);
  const [s] = taken.steps;
  assert.equal(s.step, 'pickup');
  assert.equal(s.set.stage, 'spec');
  assert.equal(s.set.specModel, 'sonnet');
  assert.equal(s.do.length, 1);
  assert.deepEqual([s.do[0].agent, s.do[0].model, s.do[0].cwd, s.do[0].out], ['spec', 'sonnet', C.cfg.paths.main, `${C.J(5)}/spec.md`]);
});

test('the tick returns the unchanged result shape and holds Claude steps while Claude is limited', () => {
  const C = mkEnv(MULTI);
  const gh = (...a) => (a[0] === 'issue' && a[1] === 'list' ? JSON.stringify([{ number: 6, title: 'x' }]) : a[0] === 'api' ? 'owner\n' : '');
  const r = createTick(C.cfg, { gh }).tick({ dryRun: true });
  assert.deepEqual(Object.keys(r), ['at', 'dryRun', 'quota', 'steps', 'waiting', 'ignored']);
  assert.equal(r.steps.length, 1);
  put(`${C.F}/quota.json`, { calls: [{ p: 'claude', at: now(), issue: 1, kind: 'spec', limited: true, until: later(60e3) }] });
  const held = createTick(C.cfg, { gh }).tick({ dryRun: true });
  assert.deepEqual(held.steps, []);
  assert.deepEqual(held.waiting, [{ issue: 6, stage: 'spec', on: 'claude' }]);
});

test('the set command writes the board from the CLI', async () => {
  const C = mkEnv(MULTI);
  const out = await new Promise((ok, bad) => execFile(process.execPath, [`${REPO}/engine/tick.mjs`, '--project', C.project, 'set', '5', '{"note":"hi"}', '--event', 'went'], (e, so) => (e ? bad(e) : ok(so))));
  assert.ok(out.trim().endsWith('5.json'));
  const j = JSON.parse(readFileSync(C.P.board, 'utf8')).jobs[0];
  assert.deepEqual([j.issue, j.note, j.events[0].text], [5, 'hi', 'went']);
});

test('goldfish never uses the spec model, also with several vendors; none configured skips, a limited one waits', () => {
  const multi = { ...MULTI, models: { ...MULTI.models, goldfish: ['claude:sonnet'] } };
  const C = mkEnv(multi), spec = n => put(`${C.J(n)}/spec.md`, 'TIER: B\nEXECUTOR: small\nBRANCH: forja/x\n');
  spec(30);
  const s = C.T.stepFor(job({ issue: 30, stage: 'spec', round: 0, tier: undefined, specModel: 'sonnet' }), {});
  assert.equal(s.step, 'build');
  assert.ok(s.event.includes(t('en', 'event.goldfishSkipped')));
  const quotaChain = mkEnv({ ...MULTI, models: { ...MULTI.models, goldfish: ['gemini:hydrogen'] } });
  put(`${quotaChain.J(31)}/spec.md`, 'TIER: B\nEXECUTOR: small\nBRANCH: forja/x\n');
  const j = job({ issue: 31, stage: 'spec', round: 0, tier: undefined, specModel: 'sonnet' });
  assert.match(quotaChain.T.stepFor(j, {}).do[0].bg, / goldfish 31 gemini:hydrogen$/);
  put(`${quotaChain.F}/quota.json`, { calls: [{ p: 'gemini', at: now(), issue: 1, kind: 'goldfish', limited: true, until: later(30 * 60e3) }] });
  assert.deepEqual(quotaChain.T.stepFor(j, quotaChain.T.quota()), { wait: 'quota' });
});

test('approver logins compare case-insensitively', () => {
  const C = mkEnv({ ...MULTI, approvers: ['MixedCase'] });
  reviewed(C, 22);
  put(C.P.board, { jobs: [job({ issue: 22, stage: 'needs-you', pr: 9, reviews: R, note: 'n', ai: null })] });
  const r = createTick(C.cfg, { gh: prGh([{ author: { login: 'mixedcase' }, body: '/approve', createdAt: later(60e3) }]) }).tick({ dryRun: true });
  assert.deepEqual(r.steps.map(s => s.step), ['open-pr']);
  const by = login => (...a) => (a[0] === 'issue' && a[1] === 'list' ? JSON.stringify([{ number: 5, title: 'x' }]) : a[0] === 'api' ? `${login}\n` : '');
  assert.equal(createTick(C.cfg, { gh: by('MIXEDCASE') }).tick({ dryRun: true }).steps[0].step, 'pickup');
});

test('a job that throws does not abort the other jobs in the tick', () => {
  const C = mkEnv(MULTI);
  put(`${C.J(23)}/build.md`, 'BUILD: OK\nExecutor: claude:sonnet\n');
  put(C.P.board, { jobs: [job({ issue: 23, stage: 'build', tier: 'Z', executor: 'medium', entry: 'claude:sonnet' }), job({ issue: 24, stage: 'pr', pr: 9, prState: 'open', ci: 'pending', tier: 'A', reviews: R })] });
  const r = createTick(C.cfg, { gh: (...a) => (a[0] === 'issue' && a[1] === 'list' ? '[]' : '') }).tick({ dryRun: true });
  assert.equal(r.waiting.length, 2);
  assert.equal(r.waiting[0].issue, 23);
  assert.ok(r.waiting[0].on.startsWith('error: '));
  assert.deepEqual(r.waiting[1], { issue: 24, stage: 'pr', on: 'ci' });
});

test('a PR command written before the advisor launched is still seen, and is spent once consumed', () => {
  const C = mkEnv(MULTI);
  reviewed(C, 26);
  const at = new Date(Date.now() - 5000).toISOString(), comments = [{ author: { login: 'owner' }, body: '/approve', createdAt: at }];
  const board = extra => put(C.P.board, { jobs: [job({ issue: 26, stage: 'needs-you', pr: 9, reviews: R, note: 'n', ai: null, running: ['advisor'], since: now(), stageSince: past, ...extra })] });
  const run = () => createTick(C.cfg, { gh: prGh(comments) }).tick({ dryRun: true }).steps;
  board({});
  const [s] = run();
  assert.equal(s.step, 'open-pr');
  assert.equal(s.set.prCmdAt, at);
  board({ prCmdAt: at });
  assert.deepEqual(run(), []);
  board({ stageSince: later(-1000) });
  assert.deepEqual(run(), []);
});
