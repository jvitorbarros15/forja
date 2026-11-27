import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languages, t } from './i18n.mjs';

export const PROTECTED = ['.forja/**', '.github/workflows/**', '.claude/**'];

export const DEFAULTS = {
  repo: null,
  approvers: [],
  language: 'en',
  defaultBranch: 'main',
  intakeLabel: 'forja',
  worktreeRoot: null,
  checks: { install: null, typecheck: null, test: null, build: null, deployTest: null, deploy: null },
  ui: null,
  tiers: [
    { id: 'A', describe: 'only tests, docs, markdown or purely visual CSS; cannot change app behavior',
      paths: ['test/**', 'tests/**', 'docs/**', '**/*.md', '**/*.css'], reviews: ['code'], approval: 'owner', autoDeploy: false },
    { id: 'B', describe: 'app logic, UI behavior, copy or markup',
      reviews: ['code', 'ui?', 'ponytail'], approval: 'owner', autoDeploy: false },
    { id: 'C', describe: 'auth, secrets, payments, migrations or user data, deploy or CI config, or loosening any check',
      reviews: ['code', 'ponytail', 'security'], approval: 'owner', autoDeploy: false, strongSpec: true, strongApprover: true },
  ],
  models: {
    spec: ['claude:sonnet'],
    specStrong: ['claude:opus'],
    build: { exact: ['local:exact'], small: ['claude:haiku'], medium: ['claude:sonnet'], hard: ['claude:opus'] },
    buildEscalation: ['exact', 'small', 'medium', 'hard'],
    review: { code: ['claude:sonnet'], ui: ['claude:sonnet'], ponytail: ['claude:sonnet'], security: ['claude:opus'] },
    goldfish: ['claude:sonnet'],
    approver: ['claude:sonnet'],
    approverStrong: ['claude:opus'],
    advisor: ['claude:sonnet'],
  },
  deferredReviews: ['ponytail', 'security'],
  goldfish: true,
  vendors: {
    codex: { enabled: false, bin: 'codex' },
    gemini: { enabled: false, bin: 'gemini' },
    agy: { enabled: false, bin: 'agy' },
    ollama: { enabled: false, url: 'http://127.0.0.1:11434', triageModel: null },
  },
  reviewers: {},
  privacy: { denyRead: ['**/.env*'], promptRules: [] },
  commit: { pattern: '^(Add|Fix|Update|Remove|Move|Refactor|Improve) .*[^.]$', guidance: 'Imperative verb, sentence case, no period.' },
  pr: { bodyTemplate: 'Closes #{issue}\n\n{summary}', mergeMethod: 'squash', requireCi: false },
  queue: { max: 3 },
  notify: { desktop: true },
  limits: { rounds: 3, agentTimeoutMin: 60 },
  server: { port: 4317, host: '127.0.0.1' },
};

export class ConfigError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

const fwd = (p) => p.replace(/\\/g, '/');
const ENTRY = /^(claude|codex|gemini|agy|ollama|local):[\w.:-]+$/;

export function validateConfig(cfg) {
  const errors = [];
  if (typeof cfg.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) errors.push('repo must be "owner/name"');
  if (!Array.isArray(cfg.approvers) || !cfg.approvers.length || !cfg.approvers.every((a) => typeof a === 'string' && a)) {
    errors.push('approvers must be a non-empty array of logins');
  }
  if (typeof cfg.defaultBranch !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(cfg.defaultBranch) || cfg.defaultBranch.includes('..')) errors.push('defaultBranch must be a branch name');
  if (!languages().includes(cfg.language)) errors.push(`language "${cfg.language}" is not supported (${languages().join(', ')})`);

  const kinds = new Set([...Object.keys(cfg.models?.review ?? {}), ...Object.keys(cfg.reviewers ?? {})]);
  const tiers = Array.isArray(cfg.tiers) ? cfg.tiers : [];
  if (!tiers.length) errors.push('tiers must be a non-empty array');
  const seen = new Set();
  for (const t of tiers) {
    if (!t?.id || typeof t.id !== 'string') { errors.push('every tier needs an id'); continue; }
    if (seen.has(t.id)) errors.push(`tier ${t.id} is duplicated`);
    seen.add(t.id);
    if (typeof t.describe !== 'string' || !t.describe) errors.push(`tier ${t.id} needs a describe text`);
    if (!['owner', 'auto'].includes(t.approval)) errors.push(`tier ${t.id} approval must be "owner" or "auto"`);
    const hasPaths = Array.isArray(t.paths) && t.paths.length > 0;
    if ((t.approval === 'auto' || t.autoDeploy === true) && !hasPaths) {
      errors.push(`tier ${t.id} uses auto approval or autoDeploy but has no paths`);
    }
    if (!Array.isArray(t.reviews)) { errors.push(`tier ${t.id} reviews must be an array`); continue; }
    for (const r of t.reviews) {
      const kind = String(r).replace(/\?$/, '');
      if (!kinds.has(kind)) errors.push(`review kind "${kind}" in tier ${t.id} is not in models.review or reviewers`);
    }
  }

  const checkChain = (name, chain) => {
    if (!Array.isArray(chain) || !chain.length) { errors.push(`${name} must be a non-empty chain`); return; }
    for (const e of chain) {
      if (typeof e !== 'string' || !ENTRY.test(e)) { errors.push(`${name}: bad chain entry "${e}"`); continue; }
      const vendor = e.split(':')[0];
      if (vendor !== 'claude' && vendor !== 'local' && !cfg.vendors?.[vendor]?.enabled) {
        errors.push(`${name}: vendor ${vendor} is not enabled ("${e}")`);
      }
    }
  };
  const m = cfg.models ?? {};
  for (const k of ['spec', 'specStrong', 'goldfish', 'approver', 'approverStrong', 'advisor']) checkChain(`models.${k}`, m[k]);
  for (const k of ['spec', 'specStrong', 'approver', 'approverStrong', 'advisor']) {
    for (const e of Array.isArray(m[k]) ? m[k] : []) if (typeof e === 'string' && !e.startsWith('claude:')) errors.push(`models.${k}: "${e}" must be a claude: entry (it runs as a Claude agent)`);
  }
  for (const [k, v] of Object.entries(m.build ?? {})) checkChain(`models.build.${k}`, v);
  for (const [k, v] of Object.entries(m.review ?? {})) checkChain(`models.review.${k}`, v);
  if (!Array.isArray(m.buildEscalation) || !m.buildEscalation.length) errors.push('models.buildEscalation must be a non-empty array');
  else for (const r of m.buildEscalation) if (!(r in (m.build ?? {}))) errors.push(`models.buildEscalation: "${r}" is not in models.build`);

  for (const r of cfg.deferredReviews ?? []) if (!kinds.has(r)) errors.push(`deferredReviews: "${r}" is not a review kind`);

  if (cfg.ui !== null && cfg.ui !== undefined) {
    if (!isObj(cfg.ui) || !Array.isArray(cfg.ui.paths) || !cfg.ui.paths.length || typeof cfg.ui.serve !== 'string' || !cfg.ui.serve) {
      errors.push('ui needs a non-empty paths array and a serve command');
    }
  }
  try { new RegExp(cfg.commit?.pattern); } catch { errors.push('commit.pattern is not a valid regex'); }
  if (!['merge', 'squash', 'rebase'].includes(cfg.pr?.mergeMethod)) errors.push('pr.mergeMethod must be "merge", "squash" or "rebase"');
  if (typeof cfg.pr?.requireCi !== 'boolean') errors.push('pr.requireCi must be true or false');
  if (!Number.isInteger(cfg.queue?.max) || cfg.queue.max < 1) errors.push('queue.max must be a positive integer');
  if (!Number.isInteger(cfg.limits?.rounds) || cfg.limits.rounds < 1) errors.push('limits.rounds must be a positive integer');
  if (!Number.isInteger(cfg.server?.port) || cfg.server.port < 1 || cfg.server.port > 65535) errors.push('server.port must be a valid port');
  return errors;
}

const worktreeRootOf = (project, configured) => (configured
  ? fwd(path.resolve(project, configured))
  : `${fwd(path.dirname(project))}/${path.basename(project)}-forja-wt`);

export function loadConfig(projectDir, { mainDir, pluginRoot } = {}) {
  const project = fwd(path.resolve(projectDir));
  const file = path.join(mainDir ?? projectDir, '.forja', 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new ConfigError([`${fwd(file)} is not valid JSON`]); }
  }
  const cfg = merge(structuredClone(DEFAULTS), user);
  for (const k of Object.keys(cfg.reviewers ?? {})) cfg.models.review[k] ??= ['claude:sonnet'];
  const errors = validateConfig(cfg);
  if (errors.length) throw new ConfigError(errors);
  const worktreeRoot = worktreeRootOf(project, cfg.worktreeRoot);
  cfg.paths = {
    project,
    main: `${worktreeRoot}/forja-main`,
    worktreeRoot,
    state: `${project}/.forja/state`,
    plugin: fwd(path.resolve(pluginRoot ?? fileURLToPath(new URL('..', import.meta.url)))),
  };
  return cfg;
}

// The config every running part of Forja uses is the merged one: forja-main's .forja/config.json, which is what the repo
// reviewed and merged. The checkout's own file counts only before forja-main exists (setup, the first start) and where
// `fallback` is set (doctor, status, stop), which must work before the merge.
// Where forja-main lives can only come from the checkout's file, read without validation.
export function mainDirOf(projectDir) {
  const project = fwd(path.resolve(projectDir));
  let configured; try { configured = JSON.parse(fs.readFileSync(path.join(project, '.forja', 'config.json'), 'utf8')).worktreeRoot; } catch {}
  return `${worktreeRootOf(project, typeof configured === 'string' ? configured : undefined)}/forja-main`;
}

export function loadProjectConfig(projectDir, { fallback = false, ...opts } = {}) {
  const mainDir = mainDirOf(projectDir), merged = fs.existsSync(`${mainDir}/.forja/config.json`);
  // Once forja-main exists the merged config is the only one: a checkout's own file must not stand in for a merge that has not happened.
  if (!merged && !fallback && fs.existsSync(mainDir)) throw new ConfigError([t('en', 'config.notMerged', { dir: mainDir })]);
  return loadConfig(projectDir, merged ? { ...opts, mainDir } : opts);
}

const globRe = (g) => {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
};

export const globMatch = (file, patterns) => patterns.some((p) => globRe(p).test(file));

export const tierOf = (cfg, id) => cfg.tiers.find((t) => t.id === id);
export const tierRank = (cfg, id) => cfg.tiers.findIndex((t) => t.id === id);
export const highestTier = (cfg) => cfg.tiers[cfg.tiers.length - 1];

export const reviewsFor = (cfg, tierId, uiChanged) =>
  tierOf(cfg, tierId).reviews.filter((r) => uiChanged || !r.endsWith('?')).map((r) => r.replace(/\?$/, ''));
