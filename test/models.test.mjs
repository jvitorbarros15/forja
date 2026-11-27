import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEntry, quota, logCall, pick, multiVendor, nextRung } from '../engine/models.mjs';
import { DEFAULTS } from '../engine/config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forja-models-'));
const future = () => new Date(Date.now() + 3600e3).toISOString();

test('parseEntry splits on the first colon', () => {
  assert.deepEqual(parseEntry('codex:sol'), { vendor: 'codex', model: 'sol' });
  assert.deepEqual(parseEntry('ollama:qwen3:8b'), { vendor: 'ollama', model: 'qwen3:8b' });
});

test('prefers other vendor when multi-vendor', () => {
  assert.equal(pick(['codex:sol', 'gemini:neon'], { avoidVendor: 'codex', avoidModel: 'sol', q: {}, multiVendor: true }), 'gemini:neon');
});

test('same model fallback in claude-only', () => {
  assert.equal(pick(['claude:sonnet'], { avoidVendor: 'claude', avoidModel: 'sonnet', q: {}, multiVendor: false }), 'claude:sonnet');
});

test('other model of the same vendor wins over same model when single-vendor', () => {
  assert.equal(pick(['claude:sonnet', 'claude:opus'], { avoidVendor: 'claude', avoidModel: 'sonnet', q: {}, multiVendor: false }), 'claude:opus');
});

test('skips limited vendor', () => {
  const q = { codex: { h5: 0, week: 0, limitedUntil: future() } };
  assert.equal(pick(['codex:sol', 'claude:haiku'], { q, multiVendor: true }), 'claude:haiku');
});

test('local is never limited', () => {
  const q = { local: { h5: 0, week: 0, limitedUntil: future() } };
  assert.equal(pick(['local:exact'], { q, multiVendor: false }), 'local:exact');
});

test('returns null when every candidate and claude are limited', () => {
  const lim = { h5: 0, week: 0, limitedUntil: future() };
  const q = { codex: lim, claude: lim };
  assert.equal(pick(['codex:sol'], { avoidVendor: 'codex', avoidModel: 'sol', q, multiVendor: true }), null);
});

test('falls back to claude:sonnet when the chain is exhausted', () => {
  const q = { codex: { h5: 0, week: 0, limitedUntil: future() } };
  assert.equal(pick(['codex:sol'], { q, multiVendor: true }), 'claude:sonnet');
});

test('strict returns null instead of same model', () => {
  assert.equal(pick(['claude:sonnet'], { avoidVendor: 'claude', avoidModel: 'sonnet', q: {}, multiVendor: false, strict: true }), null);
});

test('strict still accepts a different model', () => {
  assert.equal(pick(['claude:sonnet', 'claude:opus'], { avoidVendor: 'claude', avoidModel: 'sonnet', q: {}, multiVendor: false, strict: true }), 'claude:opus');
});

test('multiVendor ignores claude and local, honours enabled vendors', () => {
  assert.equal(multiVendor(DEFAULTS), false);
  assert.equal(multiVendor({ vendors: { codex: { enabled: true }, gemini: { enabled: false } } }), true);
  assert.equal(multiVendor({ vendors: { claude: { enabled: true }, local: { enabled: true } } }), false);
});

test('a quota file without calls counts as empty and is rebuilt by the next call', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'quota.json'), '{}');
    assert.equal(quota(dir).claude.h5, 0);
    logCall(dir, 'codex', 7, 'build');
    assert.equal(quota(dir).codex.h5, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('logCall and quota count calls per vendor and window', () => {
  const dir = tmp();
  try {
    logCall(dir, 'codex', 7, 'build');
    logCall(dir, 'claude', 7, 'spec');
    const q = quota(dir);
    assert.equal(q.codex.h5, 1);
    assert.equal(q.codex.week, 1);
    assert.equal(q.codex.limitedUntil, null);
    assert.equal(q.claude.h5, 1);
    assert.equal(quota(dir, Date.now() + 6 * 3600e3).codex.h5, 0);
    assert.equal(quota(dir, Date.now() + 6 * 3600e3).codex.week, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quota always reports claude even with no file', () => {
  const dir = tmp();
  try {
    assert.deepEqual(quota(dir), { claude: { h5: 0, week: 0, limitedUntil: null } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quota marks limited for one hour without until', () => {
  const dir = tmp();
  try {
    logCall(dir, 'codex', 1, 'build', true);
    const q = quota(dir);
    const ms = Date.parse(q.codex.limitedUntil) - Date.now();
    assert.ok(ms > 3590e3 && ms <= 3600e3, `cooldown ${ms}`);
    assert.equal(quota(dir, Date.now() + 3601e3).codex.limitedUntil, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quota honours an explicit until', () => {
  const dir = tmp();
  try {
    const until = new Date(Date.now() + 3 * 3600e3).toISOString();
    logCall(dir, 'claude', 1, 'build', true, until);
    assert.equal(quota(dir).claude.limitedUntil, until);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('logCall keeps 192 hours of history and writes atomically', () => {
  const dir = tmp();
  try {
    const old = new Date(Date.now() - 200 * 3600e3).toISOString();
    const keep = new Date(Date.now() - 100 * 3600e3).toISOString();
    fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({ calls: [
      { p: 'codex', at: old, issue: 1, kind: 'build', limited: false },
      { p: 'codex', at: keep, issue: 2, kind: 'build', limited: false },
    ] }));
    logCall(dir, 'gemini', 3, 'review');
    const calls = JSON.parse(fs.readFileSync(path.join(dir, 'quota.json'), 'utf8')).calls;
    assert.deepEqual(calls.map((c) => c.issue), [2, 3]);
    assert.deepEqual(fs.readdirSync(dir), ['quota.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('logCall creates the state dir', () => {
  const dir = path.join(tmp(), 'nested', 'state');
  try {
    logCall(dir, 'codex', 1, 'build');
    assert.equal(quota(dir).codex.h5, 1);
  } finally { fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true }); }
});

test('nextRung walks escalation then null', () => {
  const cfg = DEFAULTS;
  assert.equal(nextRung(cfg, 'exact'), 'small');
  assert.equal(nextRung(cfg, 'small'), 'medium');
  assert.equal(nextRung(cfg, 'medium'), 'hard');
  assert.equal(nextRung(cfg, 'hard'), null);
  assert.equal(nextRung(cfg, 'nope'), null);
});

test('logCall goes through the lock: it throws while another writer holds it and leaves no lock behind', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'quota.json.lock'), '');
    assert.throws(() => logCall(dir, 'codex', 1, 'build'), /board lock busy/);
    assert.equal(quota(dir).codex, undefined);
    fs.rmSync(path.join(dir, 'quota.json.lock'));
    logCall(dir, 'codex', 1, 'build');
    assert.deepEqual(fs.readdirSync(dir), ['quota.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
