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
const pluginWithoutSkills = (cfg) => {
  const plugin = tmp();
  fs.cpSync(path.resolve(import.meta.dirname, '..', 'agents'), `${plugin}/agents`, { recursive: true });
  cfg.paths.plugin = plugin;
  return cfg;
};

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

test('builder denies protected paths and .git', () => {
  const r = roles(mkCfg());
  for (const p of ['.forja/**', '.github/workflows/**', '.claude/**', '.git', '.git/**']) {
    assert.ok(r.builder.deny.includes(`Edit(./${p})`), p);
    assert.ok(r.builder.deny.includes(`Write(./${p})`), p);
  }
  assert.ok(!r['review-code'].deny.includes('Edit(./.forja/**)'));
});

test('roles rejects custom reviewer agent missing or escaping main', () => {
  for (const bad of [{}, { agent: '' }, { agent: '../escape.md' }, { agent: 'a/../../escape.md' }, { agent: '/etc/passwd' }, { agent: 'C:/evil.md' }]) {
    const cfg = mkCfg();
    cfg.reviewers.data = bad;
    assert.throws(() => roles(cfg), /reviewers\.data\.agent/, JSON.stringify(bad));
  }
  const cfg = mkCfg(), outside = tmp();
  fs.mkdirSync(cfg.paths.main, { recursive: true });
  write(`${outside}/evil.md`, 'evil');
  fs.symlinkSync(outside, `${cfg.paths.main}/link`, 'junction');
  cfg.reviewers.data = { agent: 'link/evil.md' };
  assert.throws(() => roles(cfg), /reviewers\.data\.agent/);
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
  const cfg = pluginWithoutSkills(mkCfg());
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
  assert.ok(spec.includes(`- B: ${cfg.tiers[1].describe} [approval: owner]`));
  assert.ok(spec.includes(`- A: ${cfg.tiers[0].describe} [paths: ${cfg.tiers[0].paths.join(', ')}; approval: owner]`));
  assert.ok(spec.includes('pt-BR'));
  assert.ok(renderAgent(cfg, roles(cfg).builder).body.includes('- test: make test'));
  assert.ok(renderAgent(cfg, roles(cfg).approver).body.includes(cfg.commit.guidance));
});

test('custom reviewer config skills are inlined', () => {
  const cfg = pluginWithoutSkills(mkCfg());
  cfg.reviewers.data = { agent: 'review-data.md', skills: ['ponytail-review'] };
  write(`${cfg.paths.main}/review-data.md`, '---\nname: review-data\n---\nData reviewer.');
  const home = tmp();
  write(`${home}/.claude/skills/ponytail-review/SKILL.md`, '---\nname: ponytail-review\n---\nSkill text here.');
  const { body, skillDirs } = renderAgent(cfg, roles(cfg)['review-data'], home);
  assert.ok(body.includes('Data reviewer.'));
  assert.ok(body.includes('## Skill: ponytail-review'));
  assert.ok(body.includes('Skill text here.'));
  assert.deepEqual(skillDirs, [`${home}/.claude/skills/ponytail-review`]);
});

test('renderAgent throws on missing skill', () => {
  const cfg = pluginWithoutSkills(mkCfg());
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

const mkRole = (cfg, text) => {
  write(`${cfg.paths.main}/.forja/agents/spec.md`, text);
  return roles(cfg).spec;
};

test('renderAgent accepts template without frontmatter', () => {
  const cfg = mkCfg();
  const role = mkRole(cfg, 'just a body for {{language}}');
  assert.equal(renderAgent(cfg, role).body, 'just a body for en');
  assert.deepEqual(role.skills, []);
});

test('renderAgent strips BOM', () => {
  const cfg = mkCfg();
  assert.equal(renderAgent(cfg, mkRole(cfg, '\uFEFF---\nname: s\n---\nbody text')).body, 'body text');
  assert.equal(renderAgent(cfg, mkRole(cfg, '\uFEFFplain body')).body, 'plain body');
});

test('renderAgent throws on empty body', () => {
  const cfg = mkCfg();
  assert.throws(() => renderAgent(cfg, mkRole(cfg, '---\nname: s\n---\n  \n')), /no agent body for spec/);
  assert.throws(() => renderAgent(cfg, mkRole(cfg, '')), /no agent body for spec/);
});

test('rendered checks match what each role may run', () => {
  const cfg = realPlugin(mkCfg());
  Object.assign(cfg.checks, { install: 'make install', typecheck: 'make types', test: 'make test', build: 'make build', deploy: 'make deploy', deployTest: 'make deploy-test' });
  cfg.reviewers.data = { agent: 'data.md' };
  write(`${cfg.paths.main}/data.md`, 'data reviewer\n{{checks}}');
  const home = tmp();
  for (const k of ['ponytail-review', 'security-audit']) write(`${home}/.claude/skills/${k}/SKILL.md`, 'skill');
  const r = roles(cfg);
  const body = (n) => renderAgent(cfg, r[n], home).body;
  for (const n of Object.keys(r)) for (const c of ['make install', 'make deploy', 'make deploy-test']) assert.ok(!body(n).includes(c), `${n} ${c}`);
  assert.ok(body('builder').includes('make types') && body('builder').includes('make test') && !body('builder').includes('make build'));
  assert.ok(body('spec').includes('make types') && body('spec').includes('make test') && body('spec').includes('make build'));
  for (const n of ['approver', 'advisor', 'review-code', 'review-ponytail', 'review-security']) {
    assert.ok(body(n).includes('make test') && !body(n).includes('make types') && !body(n).includes('make build'), n);
  }
  assert.ok(!body('review-ui').includes('make test'));
  assert.ok(body('review-ui').includes('{{') === false);
  assert.ok(!body('review-data').includes('make test'));
});

test('every role but the builder denies Edit and Write', () => {
  const cfg = mkCfg();
  cfg.reviewers.data = { agent: 'x.md' };
  const r = roles(cfg);
  for (const n of Object.keys(r)) {
    if (n === 'builder') { assert.ok(!r[n].deny.includes('Edit(./**)')); continue; }
    assert.ok(r[n].deny.includes('Edit(./**)') && r[n].deny.includes('Write(./**)'), n);
  }
});

test('empty denyRead omits the never-read line', () => {
  const cfg = realPlugin(mkCfg());
  cfg.privacy.denyRead = [];
  assert.ok(!renderAgent(cfg, roles(cfg).spec).body.includes('Never read files matching'));
});

test('templates leave commit rules to commitGuidance', () => {
  const cfg = realPlugin(mkCfg());
  for (const r of Object.values(roles(cfg))) assert.doesNotMatch(fs.readFileSync(r.template, 'utf8'), /Co-Authored/i, r.name);
});
