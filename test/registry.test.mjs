import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roles, renderAgent } from '../engine/registry.mjs';
import { DEFAULTS } from '../engine/config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forja-registry-')).replace(/\\/g, '/');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function mkCfg(over = {}) {
  const root = tmp();
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, over);
  cfg.language = 'en';
  cfg.paths = { project: `${root}/p`, main: `${root}/main`, worktreeRoot: root, state: `${root}/p/.forja/state`, plugin: `${root}/plugin` };
  return cfg;
}
const realPlugin = (cfg) => { cfg.paths.plugin = path.resolve(import.meta.dirname, '..').replace(/\\/g, '/'); return cfg; };

test('registry has the built-in roles with their slots and outputs', () => {
  const r = roles(mkCfg());
  assert.deepEqual(Object.keys(r).sort(), ['advisor', 'approver', 'builder', 'review-code', 'review-ponytail', 'review-security', 'review-ui', 'spec']);
  assert.equal(r['review-ui'].slot, 'ui');
  assert.equal(r.approver.slot, 'approver');
  assert.equal(r.spec.out({}), 'spec.md');
  assert.equal(r['review-code'].out({ round: 2 }), 'round-2/review-code.md');
  assert.equal(r['review-code'].reviewer, true);
  assert.equal(r.builder.reviewer, false);
});

test('start markers accept decorated markers and reject prose', () => {
  const r = roles(mkCfg());
  assert.ok(r['review-code'].start.test('notes\n**VERDICT: PASS**'));
  assert.ok(r.approver.start.test('APPROVE\nTier: B'));
  assert.ok(!r.approver.start.test('APPROVE only if everything passes\nTier: B'));
  assert.ok(r.builder.start.test('done\nfixed it'));
  assert.ok(r.spec.start.test('TIER: A'));
  assert.ok(r.advisor.start.test('REC: approve'));
});

test('registry includes custom reviewer', () => {
  const cfg = mkCfg();
  cfg.reviewers.data = { agent: 'x.md', allow: ['Bash(make data)'] };
  const r = roles(cfg)['review-data'];
  assert.equal(r.slot, 'data');
  assert.ok(r.allow({}).includes('Bash(make data)'));
  assert.ok(r.allow({}).includes('Read'));
  assert.equal(r.out({ round: 1 }), 'round-1/review-data.md');
  assert.ok(r.start.test('VERDICT: PASS'));
  assert.equal(r.template, `${cfg.paths.main}/x.md`);
  assert.equal(r.reviewer, true);
});

test('builder allow uses the configured checks', () => {
  const cfg = mkCfg();
  cfg.checks.test = 'make test';
  cfg.checks.typecheck = 'make types';
  const r = roles(cfg);
  assert.ok(r.builder.allow({}).includes('Edit(./**)'));
  assert.ok(r.builder.allow({}).includes('Bash(make test)'));
  assert.ok(r.builder.allow({}).includes('Bash(make types)'));
  assert.ok(r['review-code'].allow({}).includes('Bash(make test)'));
  assert.ok(!r['review-code'].allow({}).includes('Bash(make types)'));
  assert.ok(!r['review-ui'].allow({}).some((a) => a.startsWith('Bash')));
  assert.ok(!r.builder.allow({}).some((a) => /npm/.test(a)));
});

test('unset checks add no Bash rule', () => {
  const r = roles(mkCfg());
  assert.ok(!r.approver.allow({}).some((a) => a.startsWith('Bash')));
});

test('builder denies protected paths', () => {
  const r = roles(mkCfg());
  for (const p of ['.forja/**', '.github/workflows/**', '.claude/**']) {
    assert.ok(r.builder.deny.includes(`Edit(./${p})`));
    assert.ok(r.builder.deny.includes(`Write(./${p})`));
  }
  assert.ok(!r['review-code'].deny.includes('Edit(./.forja/**)'));
});

test('privacy denyRead becomes Read deny', () => {
  const cfg = mkCfg();
  cfg.privacy.denyRead = ['**/.env*', 'secrets/**'];
  const r = roles(cfg);
  for (const n of Object.keys(r)) {
    assert.ok(r[n].deny.includes('Read(secrets/**)'));
    assert.ok(r[n].deny.includes('Read(**/.env*)'));
    assert.ok(r[n].deny.includes('WebFetch'));
  }
});

test('override template wins', () => {
  const cfg = mkCfg();
  write(`${cfg.paths.plugin}/agents/spec.md`, '---\nname: s\n---\nplugin');
  assert.equal(roles(cfg).spec.template, `${cfg.paths.plugin}/agents/spec.md`);
  write(`${cfg.paths.main}/.forja/agents/spec.md`, '---\nname: s\n---\noverride');
  const spec = roles(cfg).spec;
  assert.equal(spec.template, `${cfg.paths.main}/.forja/agents/spec.md`);
  assert.equal(renderAgent(cfg, spec).body, 'override');
});

test('renderAgent inlines skills and fills placeholders', () => {
  const cfg = realPlugin(mkCfg());
  cfg.privacy.promptRules = ['Never print customer ids.'];
  cfg.checks.test = 'make test';
  const home = tmp();
  write(`${home}/.claude/skills/ponytail-review/SKILL.md`, '---\nname: ponytail-review\n---\nSkill text here.');
  const { body, skillDirs } = renderAgent(cfg, roles(cfg)['review-ponytail'], home);
  assert.ok(!body.includes('{{'));
  assert.ok(body.includes('## Skill: ponytail-review'));
  assert.ok(body.includes('Skill text here.'));
  assert.ok(!body.includes('name: ponytail-review'));
  assert.deepEqual(skillDirs, [`${home}/.claude/skills/ponytail-review`]);
});

test('plugin skills win over home skills', () => {
  const cfg = realPlugin(mkCfg());
  const home = tmp();
  const plugin = tmp();
  cfg.paths.plugin = plugin;
  fs.cpSync(path.resolve(import.meta.dirname, '../agents'), `${plugin}/agents`, { recursive: true });
  write(`${plugin}/skills/security-audit/SKILL.md`, 'from plugin');
  write(`${home}/.claude/skills/security-audit/SKILL.md`, 'from home');
  const { body, skillDirs } = renderAgent(cfg, roles(cfg)['review-security'], home);
  assert.ok(body.includes('from plugin') && !body.includes('from home'));
  assert.deepEqual(skillDirs, [`${plugin}/skills/security-audit`]);
});

test('renderAgent fills the placeholders from the config', () => {
  const cfg = realPlugin(mkCfg());
  cfg.language = 'pt-BR';
  cfg.privacy.promptRules = ['Never print customer ids.'];
  cfg.checks.test = 'make test';
  const spec = renderAgent(cfg, roles(cfg).spec).body;
  assert.ok(spec.includes('- Never print customer ids.'));
  assert.ok(spec.includes('Never read files matching: **/.env*'));
  assert.ok(spec.includes(`- B: ${cfg.tiers[1].describe}`));
  assert.ok(spec.includes('pt-BR'));
  assert.ok(renderAgent(cfg, roles(cfg).builder).body.includes('- test: make test'));
  assert.ok(renderAgent(cfg, roles(cfg).approver).body.includes(cfg.commit.guidance));
});

test('renderAgent throws on missing skill', () => {
  const cfg = realPlugin(mkCfg());
  assert.throws(() => renderAgent(cfg, roles(cfg)['review-security'], tmp()), /skill security-audit missing for review-security/);
});

test('every built-in template has frontmatter and no project-specific text', () => {
  const cfg = realPlugin(mkCfg());
  for (const r of Object.values(roles(cfg))) {
    const text = fs.readFileSync(r.template, 'utf8');
    assert.match(text, /^---\r?\n[\s\S]*?\r?\n---\r?\n/, r.name);
    assert.doesNotMatch(text, /clareia|CPF|jvito|deputad|npm /i, r.name);
    assert.doesNotMatch(text, /C:\/Users/i, r.name);
    assert.ok(text.includes('{{privacyRules}}'), r.name);
  }
});

test('templates keep the output contracts', () => {
  const cfg = realPlugin(mkCfg());
  const r = roles(cfg);
  const t = (n) => fs.readFileSync(r[n].template, 'utf8');
  for (const k of ['TIER:', 'EXECUTOR:', 'BRANCH:', 'COMMIT:', 'SUMMARY:', 'UI:', 'PAGES:', 'ESCALATE:', 'BEFORE:', 'AFTER:', '{{tiers}}', 'exact', 'small', 'medium', 'hard']) assert.ok(t('spec').includes(k), k);
  assert.ok(t('builder').includes('DONE|STUCK'));
  assert.ok(t('approver').includes('APPROVE|ESCALATE') && t('approver').includes('Tier:'));
  for (const k of ['REC: approve | redo', 'WHY:', 'DONE:', 'NOTE:']) assert.ok(t('advisor').includes(k), k);
  for (const n of ['review-code', 'review-ui', 'review-ponytail', 'review-security']) assert.ok(t(n).includes('VERDICT: PASS'), n);
  assert.ok(/^skills: ponytail-review$/m.test(t('review-ponytail')));
  assert.ok(/^skills: security-audit$/m.test(t('review-security')));
  assert.deepEqual(r['review-ponytail'].skills, ['ponytail-review']);
  assert.deepEqual(r['review-security'].skills, ['security-audit']);
  assert.deepEqual(r.spec.skills, []);
});
