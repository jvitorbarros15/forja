import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../engine/config.mjs';

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');

function load(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-example-'));
  try {
    fs.mkdirSync(path.join(dir, '.forja'));
    fs.copyFileSync(path.join(examples, name), path.join(dir, '.forja', 'config.json'));
    return loadConfig(dir, { mainDir: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('minimal example passes validation after the merge with defaults', () => {
  const cfg = load('minimal.config.json');
  assert.equal(cfg.repo, 'your-login/your-repo');
  assert.deepEqual(cfg.approvers, ['your-login']);
  assert.equal(cfg.tiers[0].approval, 'owner');
});

test('clareia example passes validation after the merge with defaults', () => {
  const cfg = load('clareia.config.json');
  assert.equal(cfg.repo, 'jvitorbarros15/clareia');
  assert.equal(cfg.language, 'pt-BR');
  assert.equal(cfg.tiers[0].approval, 'auto');
  assert.equal(cfg.tiers[0].autoDeploy, true);
  assert.deepEqual(cfg.deferredReviews, ['ponytail', 'security', 'data']);
  assert.deepEqual(cfg.models.build.hard, ['agy:neon', 'codex:sol']);
  assert.equal(cfg.vendors.ollama.triageModel, 'gemma4:e4b');
});
