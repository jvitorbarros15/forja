import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { t } from './i18n.mjs';
import { linkDir } from './platform.mjs';
import { field, git, locked, paths, read } from './state.mjs';
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

// A package.json with dependencies and no node_modules is a missing install; one without dependencies, or a Yarn
// Plug'n'Play project, never gets a node_modules, so that must not reinstall on every call.
const missingModules = main => {
  if (!existsSync(`${main}/package.json`) || existsSync(`${main}/node_modules`) || existsSync(`${main}/.pnp.cjs`)) return false;
  try { const p = JSON.parse(read(`${main}/package.json`)); return Object.keys({ ...p.dependencies, ...p.devDependencies }).length > 0; } catch { return false; }
};

// The marker holds the commit whose dependencies are installed in forja-main. It lives outside the worktree, and a failed
// install removes it, so the next call tries again.
function syncDeps(cfg) {
  const { main, worktreeRoot } = cfg.paths, marker = `${worktreeRoot}/forja-main.installed`;
  if (!cfg.checks.install) return;
  // The runner and every job's process come here, so one at a time.
  locked(marker, () => {
    const head = git(main, 'rev-parse', 'HEAD').trim(), done = existsSync(marker) ? read(marker).trim() : '';
    let stale = !done || missingModules(main);
    if (!stale && done !== head) {
      try { stale = git(main, 'diff', '--name-only', '-z', done, head).split('\0').some(f => DEPS.test(f)); } catch { stale = true; }
    }
    if (!stale) return writeFileSync(marker, head);
    rmSync(marker, { force: true });
    install(cfg, main);
    writeFileSync(marker, head);
  }, { long: true });
}

// forja-main belongs to Forja: what an agent, a vendor CLI or an install left in it is discarded, so the config and the agent
// overrides read from it are the merged ones. Ignored files and node_modules stay.
export function cleanMain(main) {
  if (!existsSync(`${main}/.git`)) return;
  if (!git(main, 'status', '--porcelain').split('\n').some(l => l.trim() && !/^\?\? node_modules\/?$/.test(l))) return;
  git(main, 'reset', '-q', '--hard', 'HEAD');
  git(main, 'clean', '-qfd', '-e', 'node_modules', '-e', '.pnp.*');
}

// forja-main only ever fast-forwards to the default branch. Nothing is run in the project checkout but fetch and worktree add.
// `install: false` skips the dependency install, which can take minutes: the runner uses it before a spec so one job's install never holds up the others.
export function ensureMain(cfg, { install = true } = {}) {
  const { project, main } = cfg.paths;
  git(project, 'fetch', '-q', 'origin', cfg.defaultBranch);
  if (existsSync(main)) { cleanMain(main); git(main, 'merge', '-q', '--ff-only', `origin/${cfg.defaultBranch}`); }
  else git(project, 'worktree', 'add', '-q', '--detach', main, `origin/${cfg.defaultBranch}`);
  if (install) syncDeps(cfg);
}

const link = (cfg, wt) => {
  const nm = `${cfg.paths.main}/node_modules`;
  if (existsSync(nm) && !existsSync(`${wt}/node_modules`)) linkDir(nm, `${wt}/node_modules`);
};

const mergeMain = (cfg, wt) => {
  try { git(wt, 'merge', '-q', '--no-edit', `origin/${cfg.defaultBranch}`); } catch (e) {
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
  } else git(cfg.paths.project, 'worktree', 'add', '-q', wt, '-b', branch, `origin/${cfg.defaultBranch}`);
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
