import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const COMMANDS = ['setup', 'start', 'stop', 'status', 'doctor'];

test('every command has frontmatter and references cli.mjs with CLAUDE_PLUGIN_ROOT', () => {
  for (const name of COMMANDS) {
    const text = read(`commands/${name}.md`);
    assert.match(text, /^---\ndescription: .+\nallowed-tools: Bash\(node:\*\)\n---/, `${name} frontmatter`);
    assert.match(text, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/engine\/cli\.mjs" /, `${name} cli call`);
  }
  for (const name of ['start', 'stop', 'status', 'doctor']) {
    assert.match(read(`commands/${name}.md`), new RegExp(`cli\\.mjs" ${name} --project "\\$PWD"`), `${name} subcommand`);
  }
});

test('setup runs detect, init and doctor through cli.mjs', () => {
  const text = read('commands/setup.md');
  assert.match(text, /cli\.mjs" detect --project "\$PWD"/);
  assert.match(text, /cli\.mjs" init --project "\$PWD" --answers-file <path>/);
  assert.match(text, /cli\.mjs" doctor --project "\$PWD"/);
});

test('setup asks one question at a time and explains tier approval', () => {
  const text = read('commands/setup.md');
  assert.match(text, /one question at a time/i);
  assert.match(text, /owner approval/i);
  assert.match(text, /auto-merge/i);
  assert.match(text, /paths/);
});

test('bundled skills have LICENSE files and are listed in THIRD_PARTY.md', () => {
  for (const dir of ['security-audit', 'ponytail-review']) {
    assert.ok(existsSync(join(root, 'skills', dir, 'LICENSE')), `${dir} LICENSE`);
    assert.match(read(`skills/${dir}/LICENSE`), /MIT License/);
    assert.match(read('THIRD_PARTY.md'), new RegExp(dir));
  }
  assert.ok(existsSync(join(root, 'skills/security-audit/SKILL.md')));
  assert.ok(existsSync(join(root, 'skills/ponytail-review/SKILL.md')));
  assert.ok(existsSync(join(root, 'skills/forja/SKILL.md')));
});
