import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { check } from './checks.mjs';
import { PROTECTED, globMatch } from './config.mjs';
import { t } from './i18n.mjs';
import { logCall, parseEntry, quota } from './models.mjs';
import { bestEffort, field, git, paths, read } from './state.mjs';
import { ask, diffBlock, prompt } from './vendors/index.mjs';
import { tail } from './vendors/proc.mjs';
import { ensureMain, setupJob } from './worktree.mjs';

const count = (hay, needle) => hay.split(needle).length - 1;
const edits = spec => [...spec.matchAll(/^### (\S+)\nBEFORE:\n```[^\n]*\n([\s\S]*?)\n```\nAFTER:\n```[^\n]*\n([\s\S]*?)\n```/gm)].map(m => ({ file: m[1], before: m[2], after: m[3] }));
// Files check out with CRLF on Windows (autocrlf); specs are written with LF.
const text = (wt, f) => read(`${wt}/${f}`).replaceAll('\r\n', '\n');
const applied = (wt, e) => count(text(wt, e.file), e.before) === 0 && count(text(wt, e.file), e.after) > 0;

// One external model call inside a folder. The adapter can reject (a Windows shim that cannot take the prompt): that is a failed run
// with a fixed message, the raw error goes to `detail`.
async function call(cfg, n, kind, entry, opts) {
  const { vendor } = parseEntry(entry), S = cfg.paths.state;
  if (quota(S)[vendor]?.limitedUntil) return { limited: true };
  let r;
  try { r = await ask(cfg, { entry, ...opts }); } catch (e) { return { rejected: { status: 'failed', note: t(cfg.language, 'err.vendorStart', { entry }), detail: tail(e.message, 5) } }; }
  // The call is paid for and done: a busy quota file must not turn it into a failed step.
  bestEffort(() => logCall(S, vendor, n, kind, r.limited, r.until));
  const file = `${paths(cfg).jobs(n)}/.last-${kind}.txt`;
  mkdirSync(dirname(file), { recursive: true });
  // Kept so a "no VERDICT line" failure can be read afterwards.
  writeFileSync(file, r.text || r.err);
  return r;
}

// The last round's findings: every file of that round matching `files` that did not pass.
const findings = (cfg, n, round, files) => {
  const prev = `${paths(cfg).jobs(n)}/round-${round - 1}`, parts = [];
  if (round > 1 && existsSync(prev)) for (const f of readdirSync(prev).filter(f => files.test(f))) {
    const body = read(`${prev}/${f}`);
    if (!body.startsWith('VERDICT: PASS')) parts.push(`## ${f}\n${body.trim()}`);
  }
  return parts;
};

function feedback(cfg, n, round) {
  const dir = paths(cfg).jobs(n), parts = findings(cfg, n, round, /^(review-.+|owner)\.md$/);
  const b = read(`${dir}/build.md`);
  if (b.startsWith('BUILD: FAILED') && field(b, 'Round') === String(round)) parts.push(`## Last check output\n${b.trim()}`);
  return parts.length ? `\n\n# Fix these findings\n${parts.join('\n\n')}` : '';
}

// An Edits path is the spec's text, so it is untrusted: relative, inside the worktree after symlinks, and never a protected
// path (compared in lower case: Windows and macOS folders are case-insensitive) or a dependency folder. The checks run on the
// native long path of what exists, so a Windows 8.3 alias (FORJA~1) or a junction cannot slip past a glob.
function inside(wt, file) {
  if (isAbsolute(file) || /^([a-z]:|[\\/])/i.test(file)) return false;
  try {
    const root = realpathSync.native(wt), abs = resolve(wt, file), real = existsSync(abs) ? realpathSync.native(abs) : resolve(realpathSync.native(dirname(abs)), basename(abs));
    const rel = relative(root, real).replaceAll('\\', '/'), lex = relative(resolve(wt), abs).replaceAll('\\', '/');
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false;
    return ![rel, lex].some(p => globMatch(p.toLowerCase(), [...PROTECTED, 'node_modules/**', '**/node_modules/**', '.git', '.git/**', '**/.git/**']));
  } catch { return false; }
}

function exact(cfg, n, wt, spec) {
  const L = (k, v) => t(cfg.language, k, v), list = edits(spec);
  // Every path is judged before any file is read.
  if (!list.length) return L('err.noExactEdits');
  const out = list.find(e => !inside(wt, e.file));
  if (out) return L('err.exactPath', { file: out.file });
  const todo = list.filter(e => !applied(wt, e));
  const bad = todo.find(e => count(text(wt, e.file), e.before) !== 1);
  if (bad) return L('err.exactAmbiguous', { count: count(text(wt, bad.file), bad.before), file: bad.file });
  for (const e of todo) {
    const raw = read(`${wt}/${e.file}`), eol = raw.includes('\r\n') ? '\r\n' : '\n', crlf = s => s.replaceAll('\n', eol);
    writeFileSync(`${wt}/${e.file}`, raw.replace(crlf(e.before), () => crlf(e.after)));
  }
  return '';
}

export async function build(cfg, n, entry, round) {
  const P = paths(cfg), wt = P.wt(n), spec = read(`${P.jobs(n)}/spec.md`), { vendor, model } = parseEntry(entry);
  setupJob(cfg, n);
  const head = git(wt, 'rev-parse', 'HEAD').trim();
  if (vendor === 'local') {
    if (model !== 'exact') return { status: 'failed', note: t(cfg.language, 'err.unknownLocal', { entry }) };
    return check(cfg, n, entry, round, exact(cfg, n, wt, spec));
  }
  const a = await call(cfg, n, 'build', entry, { cwd: wt, write: true, prompt: prompt(cfg, 'build', { vendor, spec, diff: feedback(cfg, n, round) }) });
  if (a.rejected) return a.rejected;
  if (a.limited) return { status: 'limited', note: entry, usage: a.usage };
  // External CLIs may commit on their own; fold that back so check() makes the one commit with the spec's message.
  if (git(wt, 'rev-parse', 'HEAD').trim() !== head) git(wt, 'reset', '-q', '--soft', head);
  return { ...await check(cfg, n, entry, round, a.ok ? '' : t(cfg.language, 'err.execFailed', { entry, err: a.err })), usage: a.usage };
}

async function judge(cfg, n, kind, entry, { cwd, file, verdicts, vars, images = [], commit = false }) {
  const L = (k, v) => t(cfg.language, k, v), state = () => git(cwd, 'status', '--porcelain') + git(cwd, 'rev-parse', 'HEAD'), before = state();
  let body;
  try { body = prompt(cfg, kind, { vendor: parseEntry(entry).vendor, ...vars }); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    body = prompt(cfg, 'code', { vendor: parseEntry(entry).vendor, ...vars });
  }
  const a = await call(cfg, n, kind, entry, { cwd, prompt: body, images });
  if (a.rejected) return a.rejected;
  if (a.limited) return { status: 'limited', note: entry, usage: a.usage };
  if (!a.ok) return { status: 'failed', note: `${entry}: ${a.err}`, usage: a.usage };
  if (state() !== before) return { status: 'failed', note: L('err.reviewChanged', { entry, kind }), usage: a.usage };
  const lines = a.text.trim().split('\n'), i = lines.findIndex(l => new RegExp(`^VERDICT: (${verdicts})\\b`).test(l.trim()));
  if (i < 0) return { status: 'failed', note: L('err.noVerdict', { entry }), usage: a.usage };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${[lines[i].trim(), `Reviewer: ${entry}`, ...(commit ? [`Commit: ${git(cwd, 'rev-parse', 'HEAD').trim()}`] : []), ...lines.slice(i + 1, i + 21)].join('\n')}\n`);
  return { status: 'ok', note: lines[i].trim(), usage: a.usage };
}

export async function review(cfg, n, kind, entry, round) {
  const P = paths(cfg), wt = P.wt(n), spec = read(`${P.jobs(n)}/spec.md`), rd = `${P.jobs(n)}/round-${round}`, file = `${rd}/review-${kind}.md`;
  if (!existsSync(wt)) throw new Error(`no worktree ${wt}`);
  const vendor = parseEntry(entry).vendor, shots = `${rd}/shots`;
  const images = kind === 'ui' && existsSync(shots) ? readdirSync(shots).filter(f => /\.(png|jpe?g)$/i.test(f)).map(f => `${shots}/${f}`) : [];
  if (kind === 'ui' && !images.length) {
    mkdirSync(rd, { recursive: true });
    writeFileSync(file, `VERDICT: PASS\nReviewer: skipped\nCommit: ${git(wt, 'rev-parse', 'HEAD').trim()}\n- ${t(cfg.language, 'note.uiReviewSkipped')}\n`);
    return { status: 'ok', note: 'VERDICT: PASS (skipped)' };
  }
  const old = findings(cfg, n, round, /^review-.+\.md$/), vars = { spec, previous: old.length ? `# Previous round findings\n${old.join('\n\n')}` : '', diff: diffBlock(vendor, spec, git(wt, 'diff', `origin/${cfg.defaultBranch}...HEAD`)), images: images.length ? `# Screenshots\n${images.join('\n')}` : '' };
  return judge(cfg, n, kind, entry, { cwd: wt, file, verdicts: 'PASS|CHANGES', vars, images, commit: true });
}

// The blind check reads the repo at the default branch: the job has no worktree yet when it runs.
export async function goldfish(cfg, n, entry) {
  ensureMain(cfg);
  const P = paths(cfg);
  return judge(cfg, n, 'goldfish', entry, { cwd: P.main, file: `${P.jobs(n)}/spec-review.md`, verdicts: 'OK|GAPS', vars: { spec: read(`${P.jobs(n)}/spec.md`) } });
}
