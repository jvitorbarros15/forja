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

const checkRules = (cfg, ...names) => names.map((n) => cfg.checks[n]).filter(Boolean).map((c) => `Bash(${c})`);

const BUILTIN = {
  spec: { slot: 'spec', out: () => 'spec.md', start: /^\W*(ESCALATE|TIER):/m, allow: () => [...READ, ...gitRule('log', 'show', 'ls-files')] },
  builder: {
    slot: 'builder', out: () => 'builder.md', start: /^\W*(DONE|STUCK)\b/im,
    allow: (cfg) => [...READ, 'Edit(./**)', 'Write(./**)', ...gitRule('diff', 'status'), ...checkRules(cfg, 'test', 'typecheck')],
  },
  approver: {
    slot: 'approver', out: () => 'decision.md', start: /^\W*(APPROVE|ESCALATE)\W*\r?\n\W*Tier:/m,
    allow: (cfg) => [...READ, ...checkRules(cfg, 'test')],
  },
  advisor: { slot: 'advisor', out: () => 'advice.md', start: /^\W*REC:/m, allow: (cfg) => [...READ, ...checkRules(cfg, 'test')] },
  'review-code': { slot: 'code', out: reviewOut('code'), start: MARKED, allow: (cfg) => [...READ, ...checkRules(cfg, 'test')] },
  'review-ui': { slot: 'ui', out: reviewOut('ui'), start: MARKED, allow: () => [...READ] },
  'review-ponytail': { slot: 'ponytail', out: reviewOut('ponytail'), start: MARKED, allow: (cfg) => [...READ, ...checkRules(cfg, 'test')] },
  'review-security': { slot: 'security', out: reviewOut('security'), start: MARKED, allow: (cfg) => [...READ, ...checkRules(cfg, 'test')] },
};

const skillsOf = (text) => (text.match(FM)?.[1].match(/^skills:(.*)$/m)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export function roles(cfg) {
  const { main, plugin } = cfg.paths;
  const deny = [...DENY, ...cfg.privacy.denyRead.map((g) => `Read(${g})`)];
  const builderDeny = [...deny, ...PROTECTED.flatMap((p) => [`Edit(./${p})`, `Write(./${p})`])];
  const out = {};
  const add = (name, def, template, extra) => {
    out[name] = {
      name, slot: def.slot, out: def.out, start: def.start, reviewer: name.startsWith('review-'), template,
      skills: fs.existsSync(template) ? skillsOf(fs.readFileSync(template, 'utf8')) : [],
      allow: def.allow ? () => def.allow(cfg) : () => [...READ, ...extra],
      deny: name === 'builder' ? builderDeny : deny,
    };
  };
  for (const [name, def] of Object.entries(BUILTIN)) {
    const override = `${main}/.forja/agents/${name}.md`;
    add(name, def, fs.existsSync(override) ? override : `${plugin}/agents/${name}.md`);
  }
  for (const [kind, r] of Object.entries(cfg.reviewers)) {
    add(`review-${kind}`, { slot: kind, out: reviewOut(kind), start: MARKED }, fwd(path.resolve(main, r.agent)), r.allow ?? []);
  }
  return out;
}

export function renderAgent(cfg, role, homeDir = os.homedir()) {
  const [, head = '', raw = ''] = fs.readFileSync(role.template, 'utf8').match(FM) ?? [];
  const fill = {
    privacyRules: [...cfg.privacy.promptRules.map((r) => `- ${r}`), `- Never read files matching: ${cfg.privacy.denyRead.join(', ')}`].join('\n'),
    tiers: cfg.tiers.map((t) => `- ${t.id}: ${t.describe}`).join('\n'),
    checks: Object.entries(cfg.checks).filter(([, c]) => c).map(([n, c]) => `- ${n}: ${c}`).join('\n') || '- none configured',
    commitGuidance: `${cfg.commit.guidance} Subjects must match ${cfg.commit.pattern}`,
    language: cfg.language,
  };
  const body = raw.replace(/\{\{(\w+)\}\}/g, (m, k) => fill[k] ?? m).trim();
  const skillDirs = [];
  const text = skillsOf(`---\n${head}\n---`).map((k) => {
    const dir = [`${cfg.paths.plugin}/skills/${k}`, `${fwd(homeDir)}/.claude/skills/${k}`].find((d) => fs.existsSync(`${d}/SKILL.md`));
    if (!dir) throw new Error(`skill ${k} missing for ${role.name}`);
    skillDirs.push(dir);
    const s = fs.readFileSync(`${dir}/SKILL.md`, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    return `\n\n## Skill: ${k} (its reference files are in ${dir})\n\n${s}`;
  }).join('');
  return { body: body + text, skillDirs };
}
