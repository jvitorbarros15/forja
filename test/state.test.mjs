import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../engine/config.mjs';
import { createBoard, locked, paths, readJson } from '../engine/state.mjs';

const STATE_URL = new URL('../engine/state.mjs', import.meta.url).href;
const CONFIG_URL = new URL('../engine/config.mjs', import.meta.url).href;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-state-'));
  fs.mkdirSync(path.join(dir, '.forja'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forja', 'config.json'), JSON.stringify({ repo: 'o/r', approvers: ['me'] }));
  const cfg = loadConfig(dir);
  return { dir, cfg, P: paths(cfg), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('paths puts state under cfg.paths.state and worktrees under worktreeRoot', () => {
  const { cfg, P, cleanup } = setup();
  try {
    assert.equal(P.board, `${cfg.paths.state}/board.json`);
    assert.equal(P.jobs(7), `${cfg.paths.state}/jobs/7`);
    assert.equal(P.wt(7), `${cfg.paths.worktreeRoot}/forja-7`);
    assert.equal(P.main, cfg.paths.main);
  } finally { cleanup(); }
});

test('setJob creates job and writes doc', () => {
  const { cfg, P, cleanup } = setup();
  try {
    const board = createBoard(cfg);
    const p = board.setJob(1, { stage: 'spec', title: 'T' }, 'received');
    assert.equal(p, `${P.docs}/1.json`);
    const job = readJson(P.board).jobs[0];
    assert.equal(job.issue, 1);
    assert.equal(job.stage, 'spec');
    assert.equal(job.events[0].text, 'received');
    const doc = readJson(p);
    assert.equal(doc.title, 'T');
    assert.deepEqual(doc.files, []);
    assert.equal(doc.need, null);
  } finally { cleanup(); }
});

test('setJob clears need and ai when leaving needs-you', () => {
  const { cfg, P, cleanup } = setup();
  try {
    const board = createBoard(cfg);
    board.needOf = (job, why, action) => ({ why, action });
    board.setJob(1, { stage: 'needs-you', need: { why: 'w', action: 'approve' }, ai: { x: 1 }, advisedFor: 'k' });
    assert.deepEqual(readJson(`${P.docs}/1.json`).need, { why: 'w', action: 'approve' });
    board.setJob(1, { stage: 'build' });
    const job = readJson(P.board).jobs[0];
    assert.ok(!('need' in job) && !('ai' in job) && !('advisedFor' in job));
    assert.equal(readJson(`${P.docs}/1.json`).need, null);
  } finally { cleanup(); }
});

test('setJob keeps need and ai on failed', () => {
  const { cfg, P, cleanup } = setup();
  try {
    const board = createBoard(cfg);
    board.setJob(1, { stage: 'failed', need: { why: 'w', action: 'redo' }, ai: { x: 1 } });
    const job = readJson(P.board).jobs[0];
    assert.ok(job.need && job.ai);
  } finally { cleanup(); }
});

test('setJob sets since when stage changes', () => {
  const { cfg, P, cleanup } = setup();
  try {
    const board = createBoard(cfg);
    board.setJob(1, { stage: 'spec' });
    const first = readJson(P.board).jobs[0].since;
    assert.ok(first);
    board.setJob(1, { note: 'x' });
    assert.equal(readJson(P.board).jobs[0].since, first);
    const until = Date.now() + 5;
    while (Date.now() < until);
    board.setJob(1, { stage: 'build' });
    assert.notEqual(readJson(P.board).jobs[0].since, first);
  } finally { cleanup(); }
});

test('setJob calls relabel only when stage changes', () => {
  const { cfg, cleanup } = setup();
  try {
    const calls = [];
    const board = createBoard(cfg, { relabel: (job, old) => calls.push([job.stage, old]) });
    board.setJob(1, { stage: 'spec' });
    board.setJob(1, { note: 'x' });
    board.setJob(1, { stage: 'build' });
    assert.deepEqual(calls, [['spec', undefined], ['build', 'spec']]);
  } finally { cleanup(); }
});

test('upsertWorker returns null for missing job', () => {
  const { cfg, P, cleanup } = setup();
  try {
    const board = createBoard(cfg);
    assert.equal(board.upsertWorker(9, { id: 'a' }), null);
    assert.ok(!fs.existsSync(P.board));
  } finally { cleanup(); }
});

test('upsertWorker merges by id and sums tokens in the doc', () => {
  const { cfg, P, cleanup } = setup();
  try {
    const board = createBoard(cfg);
    board.setJob(1, { stage: 'build' });
    board.upsertWorker(1, { id: 'a', vendor: 'claude', tokens: { input: 1, output: 2, total: 3 } });
    board.upsertWorker(1, { id: 'a', status: 'done' });
    board.upsertWorker(1, { id: 'b', vendor: 'claude', tokens: { input: 10, output: 0, total: 10 } });
    const doc = readJson(`${P.docs}/1.json`);
    assert.equal(doc.workers.length, 2);
    assert.equal(doc.workers[0].status, 'done');
    assert.equal(doc.tokens.total, 13);
    assert.equal(doc.tokens.byVendor.claude.input, 11);
  } finally { cleanup(); }
});

test('concurrent setJob calls keep both changes', async () => {
  const { dir, cfg, cleanup } = setup();
  try {
    createBoard(cfg).setJob(1, { stage: 'build' });
    const script = `
      import { loadConfig } from '${CONFIG_URL}';
      import { createBoard } from '${STATE_URL}';
      const board = createBoard(loadConfig(${JSON.stringify(dir)}));
      const key = process.argv[1];
      for (let i = 0; i < 20; i++) board.setJob(1, job => ({ [key]: (job[key] ?? 0) + 1 }));
    `;
    const run = key => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script, key], { stdio: 'inherit' });
      c.on('exit', code => (code === 0 ? res() : rej(new Error(`child ${key} exited ${code}`))));
    });
    await Promise.all([run('a'), run('b')]);
    const job = readJson(paths(cfg).board).jobs[0];
    assert.equal(job.a, 20);
    assert.equal(job.b, 20);
  } finally { cleanup(); }
});

test('setJob moves stageSince only when the stage changes, not when running does', () => {
  const { cfg, P, cleanup } = setup();
  try {
    const board = createBoard(cfg);
    board.setJob(1, { stage: 'needs-you' });
    const first = readJson(P.board).jobs[0];
    assert.ok(first.stageSince);
    const until = Date.now() + 5;
    while (Date.now() < until);
    board.setJob(1, { running: ['advisor'] });
    const job = readJson(P.board).jobs[0];
    assert.equal(job.stageSince, first.stageSince);
    assert.notEqual(job.since, first.since);
  } finally { cleanup(); }
});

test('locked throws when the lock stays busy and removes one a dead process left behind', () => {
  const { dir, cleanup } = setup();
  try {
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(`${file}.lock`, '');
    let ran = 0;
    assert.throws(() => locked(file, () => ran++), /board lock busy/);
    assert.equal(ran, 0);
    const old = new Date(Date.now() - 20e3);
    fs.utimesSync(`${file}.lock`, old, old);
    assert.equal(locked(file, () => ++ran), 1);
    assert.ok(!fs.existsSync(`${file}.lock`));
  } finally { cleanup(); }
});
