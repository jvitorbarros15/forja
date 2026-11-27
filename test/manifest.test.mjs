import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

test('manifest is valid', () => {
  const plugin = read('.claude-plugin/plugin.json');
  const marketplace = read('.claude-plugin/marketplace.json');
  const pkg = read('package.json');

  assert.equal(plugin.name, 'forja');
  assert.ok(marketplace.plugins.some((p) => p.name === 'forja'));
  assert.equal(pkg.engines.node, '>=22');
  assert.equal('dependencies' in pkg, false);
});
