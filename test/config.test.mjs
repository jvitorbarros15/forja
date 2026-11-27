import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig, ConfigError, globMatch, reviewsFor, tierRank, highestTier, tierOf, PROTECTED } from '../engine/config.mjs';

function project(config, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-cfg-'))) {
  fs.mkdirSync(path.join(dir, '.forja'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forja', 'config.json'), JSON.stringify(config));
  return dir;
}
const cleanup = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
const base = { repo: 'o/r', approvers: ['me'] };

test('defaults load with only repo', () => {
  const dir = project(base);
  try {
    const cfg = loadConfig(dir);
    assert.deepEqual(cfg.models.review.code, ['claude:sonnet']);
    assert.deepEqual(cfg.tiers.map((t) => t.approval), ['owner', 'owner', 'owner']);
    assert.equal(cfg.paths.worktreeRoot, `${path.dirname(dir).replace(/\\/g, '/')}/${path.basename(dir)}-forja-wt`);
    assert.equal(cfg.paths.main, `${cfg.paths.worktreeRoot}/forja-main`);
    assert.equal(cfg.paths.state, `${cfg.paths.project}/.forja/state`);
    assert.ok(!cfg.paths.plugin.includes('\\'));
    assert.deepEqual(PROTECTED, ['.forja/**', '.github/workflows/**', '.claude/**']);
  } finally { cleanup(dir); }
});

test('user config merges objects and replaces arrays', () => {
  const dir = project({ ...base, models: { spec: ['claude:opus'] }, queue: { max: 5 } });
  try {
    const cfg = loadConfig(dir);
    assert.deepEqual(cfg.models.spec, ['claude:opus']);
    assert.deepEqual(cfg.models.approver, ['claude:sonnet']);
    assert.equal(cfg.queue.max, 5);
  } finally { cleanup(dir); }
});

test('rejects unknown review kind and lists all errors', () => {
  const dir = project({ ...base, tiers: [{ id: 'A', describe: 'x', reviews: ['nope'], approval: 'auto' }] });
  try {
    assert.throws(() => loadConfig(dir), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.errors.filter((s) => /review kind "nope"/.test(s)).length, 1);
      assert.equal(e.errors.filter((s) => /tier A.*auto.*paths/.test(s)).length, 1);
      assert.equal(e.message, e.errors.join('\n'));
      return true;
    });
  } finally { cleanup(dir); }
});

test('rejects chain entry for disabled vendor', () => {
  const dir = project({ ...base, models: { review: { code: ['codex:gpt'] } } });
  try {
    assert.throws(() => loadConfig(dir), (e) => e.errors.some((s) => /codex.*not enabled/.test(s)));
  } finally { cleanup(dir); }
});

test('accepts chain entry for enabled vendor', () => {
  const dir = project({ ...base, vendors: { codex: { enabled: true } }, models: { review: { code: ['codex:gpt', 'claude:sonnet'] } } });
  try {
    assert.deepEqual(loadConfig(dir).models.review.code, ['codex:gpt', 'claude:sonnet']);
  } finally { cleanup(dir); }
});

test('rejects missing repo and empty approvers', () => {
  const dir = project({});
  try {
    assert.throws(() => loadConfig(dir), (e) => e.errors.length === 2);
  } finally { cleanup(dir); }
});

test('custom reviewer is a valid kind and defaults to claude:sonnet', () => {
  const dir = project({ ...base, reviewers: { data: { agent: '.forja/agents/review-data.md' } },
    tiers: [{ id: 'A', describe: 'x', reviews: ['code', 'data'], approval: 'owner' }] });
  try {
    assert.deepEqual(loadConfig(dir).models.review.data, ['claude:sonnet']);
  } finally { cleanup(dir); }
});

test('loadConfig does not mutate DEFAULTS', () => {
  const a = project({ ...base, reviewers: { data: { agent: 'x.md' } } });
  const b = project({ ...base, tiers: [{ id: 'A', describe: 'x', reviews: ['data'], approval: 'owner' }] });
  try {
    loadConfig(a);
    assert.equal('data' in DEFAULTS.models.review, false);
    assert.throws(() => loadConfig(b), (e) => e.errors.some((s) => /review kind "data"/.test(s)));
  } finally { cleanup(a, b); }
});

test('auto approval is accepted with paths', () => {
  const dir = project({ ...base, tiers: [{ id: 'A', describe: 'x', paths: ['docs/**'], reviews: ['code'], approval: 'auto' }] });
  try {
    assert.equal(loadConfig(dir).tiers[0].approval, 'auto');
  } finally { cleanup(dir); }
});

test('rejects unsupported language', () => {
  const dir = project({ ...base, language: 'xx' });
  try {
    assert.throws(() => loadConfig(dir), (e) => e.errors.some((s) => /language "xx"/.test(s)));
  } finally { cleanup(dir); }
});

test('mainDir wins over project', () => {
  const proj = project({ repo: 'a/proj', approvers: ['me'] });
  const main = project({ repo: 'a/main', approvers: ['me'] });
  try {
    const cfg = loadConfig(proj, { mainDir: main });
    assert.equal(cfg.repo, 'a/main');
    assert.equal(cfg.paths.project, proj.replace(/\\/g, '/'));
  } finally { cleanup(proj, main); }
});

test('explicit worktreeRoot and pluginRoot', () => {
  const dir = project({ ...base, worktreeRoot: '../elsewhere' });
  try {
    const cfg = loadConfig(dir, { pluginRoot: '/x/plugin' });
    assert.equal(cfg.paths.worktreeRoot, `${path.dirname(dir).replace(/\\/g, '/')}/elsewhere`);
    assert.ok(cfg.paths.plugin.endsWith('/x/plugin'));
  } finally { cleanup(dir); }
});

test('globMatch', () => {
  assert.equal(globMatch('docs/a/b.md', ['docs/**']), true);
  assert.equal(globMatch('src/x.css', ['**/*.css']), true);
  assert.equal(globMatch('x.css', ['**/*.css']), true);
  assert.equal(globMatch('src/x.ts', ['**/*.css']), false);
  assert.equal(globMatch('a/b.md', ['*.md']), false);
  assert.equal(globMatch('a.md', ['?.md']), true);
  assert.equal(globMatch('src/a.js', ['test/**', 'src/*.js']), true);
});

test('tier helpers and reviewsFor', () => {
  const dir = project(base);
  try {
    const cfg = loadConfig(dir);
    assert.deepEqual(reviewsFor(cfg, 'B', false), ['code', 'ponytail']);
    assert.deepEqual(reviewsFor(cfg, 'B', true), ['code', 'ui', 'ponytail']);
    assert.equal(tierRank(cfg, 'A'), 0);
    assert.equal(tierRank(cfg, 'C'), 2);
    assert.equal(tierRank(cfg, 'Z'), -1);
    assert.equal(highestTier(cfg).id, 'C');
    assert.equal(tierOf(cfg, 'C').strongSpec, true);
  } finally { cleanup(dir); }
});
