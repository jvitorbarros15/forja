import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { t } from './i18n.mjs';
import { linkDir } from './platform.mjs';
import { field, git, paths, read } from './state.mjs';
import { tail } from './vendors/proc.mjs';

const MIN = 60e3;

// A command that timed out or never started has no exit code; it must count as failed, never as passed.
export const sh = (cwd, cmd, env = {}, timeout = 40 * MIN) => {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 256e6, timeout, windowsHide: true });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n${cmd.slice(0, 60)}: ${r.error.message}` : ''}` };
};

// Data kept outside git is absent in a job worktree, so configured commands can point at the project or main folder.
export const expand = (cfg, cmd) => cmd.replaceAll('{project}', cfg.paths.project).replaceAll('{main}', cfg.paths.main);

export const linked = wt => { try { return lstatSync(`${wt}/node_modules`).isSymbolicLink(); } catch { return false; } };
// The node_modules link Forja makes is not the builder's work, so it never counts as a change.
export const dirty = wt => git(wt, 'status', '--porcelain').split('\n').filter(l => l.trim() && !(linked(wt) && /^\?\? node_modules\/?$/.test(l))).join('\n');

const install = (cfg, dir) => {
  const r = sh(dir, expand(cfg, cfg.checks.install));
  if (r.status) throw new Error(tail(r.stderr || r.stdout, 10));
};

const DEPS = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/;

// The marker holds the commit whose dependencies are installed in forja-main. It lives outside the worktree, and a failed
// install removes it, so the next call tries again.
function syncDeps(cfg) {
  const { main, worktreeRoot } = cfg.paths, marker = `${worktreeRoot}/forja-main.installed`, head = git(main, 'rev-parse', 'HEAD').trim();
  if (!cfg.checks.install) return;
  const done = existsSync(marker) ? read(marker).trim() : '';
  let stale = !done || (existsSync(`${main}/package.json`) && !existsSync(`${main}/node_modules`));
  if (!stale && done !== head) {
    try { stale = git(main, 'diff', '--name-only', done, head).split('\n').some(f => DEPS.test(f)); } catch { stale = true; }
  }
  if (!stale) return writeFileSync(marker, head);
  rmSync(marker, { force: true });
  install(cfg, main);
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(marker, head);
}

// forja-main only ever fast-forwards to origin/main. Nothing is run in the project checkout but fetch and worktree add.
export function ensureMain(cfg) {
  const { project, main } = cfg.paths;
  git(project, 'fetch', '-q', 'origin', 'main');
  if (existsSync(main)) git(main, 'merge', '-q', '--ff-only', 'origin/main');
  else git(project, 'worktree', 'add', '-q', '--detach', main, 'origin/main');
  syncDeps(cfg);
}

const link = (cfg, wt) => {
  const nm = `${cfg.paths.main}/node_modules`;
  if (existsSync(nm) && !existsSync(`${wt}/node_modules`)) linkDir(nm, `${wt}/node_modules`);
};

const mergeMain = (cfg, wt) => {
  try { git(wt, 'merge', '-q', '--no-edit', 'origin/main'); } catch (e) {
    try { git(wt, 'merge', '--abort'); } catch {}
    throw new Error(t(cfg.language, 'err.mergeConflict', { why: tail(`${e.stdout ?? ''}${e.stderr ?? ''}`, 5) }));
  }
};

export function setupJob(cfg, n, branch) {
  const P = paths(cfg), wt = P.wt(n);
  branch ??= field(read(`${P.jobs(n)}/spec.md`), 'BRANCH');
  ensureMain(cfg);
  // Each round starts on the current main, so the checks here see what CI sees (CI tests the merge with main).
  if (existsSync(wt)) {
    if (!dirty(wt)) mergeMain(cfg, wt);
    if (!cfg.checks.install) link(cfg, wt);
    return;
  }
  if (!new RegExp(`^forja/${n}-[a-z0-9-]+$`).test(branch ?? '')) throw new Error(`bad BRANCH in spec.md: ${branch}`);
  // A failed earlier attempt can leave the branch behind; reuse it instead of failing every retry.
  let exists = true;
  try { git(cfg.paths.project, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`); } catch { exists = false; }
  if (exists) {
    git(cfg.paths.project, 'worktree', 'add', '-q', wt, branch);
    try { mergeMain(cfg, wt); } catch (e) { removeJob(cfg, n); throw e; }
  } else git(cfg.paths.project, 'worktree', 'add', '-q', wt, '-b', branch, 'origin/main');
  try {
    if (cfg.checks.install) install(cfg, wt);
    else link(cfg, wt);
  } catch (e) { removeJob(cfg, n); throw e; }
}

export function removeJob(cfg, n) {
  const wt = paths(cfg).wt(n);
  if (!existsSync(wt)) return;
  // Unlinked first: removing the worktree must never reach through the link into forja-main's node_modules.
  if (linked(wt)) unlinkSync(`${wt}/node_modules`);
  git(cfg.paths.project, 'worktree', 'remove', wt);
}
