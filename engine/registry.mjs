import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTECTED } from './config.mjs';

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const fwd = (p) => p.replace(/\\/g, '/');
const gitRule = (...subs) => subs.map((s) => `Bash(git ${s}:*)`);
const READ = ['Read', 'Grep', 'Glob'];
const DENY = ['WebFetch', 'WebSearch', 'Bash(git * --output*)', 'Bash(git * -O*)', 'Bash(git * --open-files-in-pager*)'];
const MARKED = /^\W*VERDICT:/m;
const reviewOut = (kind) => (j) => `round-${j.round}/review-${kind}.md`;

const BUILTIN = {
  spec: { slot: 'spec', out: () => 'spec.md', start: /^\W*(ESCALATE|TIER):/m, base: [...READ, ...gitRule('log', 'show', 'ls-files')], checks: ['typecheck', 'test', 'build'], grant: false },
  builder: { slot: 'builder', out: () => 'builder.md', start: /^\W*(DONE|STUCK)\b/im, base: [...READ, 'Edit(./**)', 'Write(./**)', ...gitRule('diff', 'status')], checks: ['test', 'typecheck'] },
  approver: { slot: 'approver', out: () => 'decision.md', start: /^\W*(APPROVE|ESCALATE)\W*\r?\n\W*Tier:/m, base: READ, checks: ['test'] },
  advisor: { slot: 'advisor', out: () => 'advice.md', start: /^\W*REC:/m, base: READ, checks: ['test'] },
  'review-code': { slot: 'code', out: reviewOut('code'), start: MARKED, base: READ, checks: ['test'] },
  'review-ui': { slot: 'ui', out: reviewOut('ui'), start: MARKED, base: READ, checks: [] },
  'review-ponytail': { slot: 'ponytail', out: reviewOut('ponytail'), start: MARKED, base: READ, checks: ['test'] },
  'review-security': { slot: 'security', out: reviewOut('security'), start: MARKED, base: READ, checks: ['test'] },
};

const parse = (text) => {
  const t = text.replace(/^﻿/, '');
  const [, head = '', body = t] = t.match(FM) ?? [];
  return { head, body };
};
const skillsOf = (head) => (head.match(/^skills:(.*)$/m)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const setChecks = (cfg, names) => names.filter((n) => cfg.checks[n]).map((n) => [n, cfg.checks[n]]);

export function roles(cfg) {
  const { main, plugin } = cfg.paths;
  const deny = [...DENY, ...cfg.privacy.denyRead.map((g) => `Read(${g})`)];
  const readOnlyDeny = [...deny, 'Edit(./**)', 'Write(./**)'];
  const builderDeny = [...deny, ...PROTECTED.flatMap((p) => [`Edit(./${p})`, `Write(./${p})`])];
  const out = {};
  const add = (name, def, template, extra = []) => {
    const checks = def.checks ?? [];
    out[name] = {
      name, slot: def.slot, out: def.out, start: def.start, reviewer: name.startsWith('review-'), template,
      skills: fs.existsSync(template) ? skillsOf(parse(fs.readFileSync(template, 'utf8')).head) : [],
      checks,
      allow: () => [...(def.base ?? READ), ...extra, ...(def.grant === false ? [] : setChecks(cfg, checks).map(([, c]) => `Bash(${c})`))],
      deny: name === 'builder' ? builderDeny : readOnlyDeny,
    };
  };
  for (const [name, def] of Object.entries(BUILTIN)) {
    const override = `${main}/.forja/agents/${name}.md`;
    add(name, def, fs.existsSync(override) ? override : `${plugin}/agents/${name}.md`);
  }
  for (const [kind, r] of Object.entries(cfg.reviewers)) {
    const name = `review-${kind}`;
    add(name, { slot: kind, out: reviewOut(kind), start: MARKED }, fwd(path.resolve(main, r.agent)), r.allow ?? []);
    out[name].skills = [...new Set([...out[name].skills, ...(r.skills ?? [])])];
  }
  return out;
}

export function renderAgent(cfg, role, homeDir = os.homedir()) {
  const { body: raw } = parse(fs.readFileSync(role.template, 'utf8'));
  const checks = setChecks(cfg, role.checks);
  const fill = {
    privacyRules: [...cfg.privacy.promptRules.map((r) => `- ${r}`), ...(cfg.privacy.denyRead.length ? [`- Never read files matching: ${cfg.privacy.denyRead.join(', ')}`] : [])].join('\n'),
    tiers: cfg.tiers.map((t) => `- ${t.id}: ${t.describe} [${t.paths?.length ? `paths: ${t.paths.join(', ')}; ` : ''}approval: ${t.approval}]`).join('\n'),
    checks: checks.length ? checks.map(([n, c]) => `- ${n}: ${c}`).join('\n') : '- none: you run no commands',
    commitGuidance: `${cfg.commit.guidance} Subjects must match ${cfg.commit.pattern}`,
    language: cfg.language,
  };
  const body = raw.replace(/\{\{(\w+)\}\}/g, (m, k) => fill[k] ?? m).trim();
  if (!body) throw new Error(`no agent body for ${role.name}`);
  const skillDirs = [];
  const text = role.skills.map((k) => {
    const dir = [`${cfg.paths.plugin}/skills/${k}`, `${fwd(homeDir)}/.claude/skills/${k}`].find((d) => fs.existsSync(`${d}/SKILL.md`));
    if (!dir) throw new Error(`skill ${k} missing for ${role.name}`);
    skillDirs.push(dir);
    const s = fs.readFileSync(`${dir}/SKILL.md`, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    return `\n\n## Skill: ${k} (its reference files are in ${dir})\n\n${s}`;
  }).join('');
  return { body: body + text, skillDirs };
}
