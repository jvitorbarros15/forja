// The mechanical half of a Forja step: worktree setup, one external model call, the build checks and the commit,
// the PR, the deploy. tick.mjs says when to run each one.
//   node call.mjs --project <dir> <command> ...
//   setup <n> | build <n> <entry> <round> | check <n> <entry> <round> | review <n> <kind> <entry> <round>
//   goldfish <n> <entry> | pr <n> | deploy <id...> | deploy-test <id...> | cilog <n> <round> <pr> | triage <n> | log <vendor> <n> [kind]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './checks.mjs';
import { loadConfig } from './config.mjs';
import { build, goldfish, review } from './external.mjs';
import { logCall } from './models.mjs';
import { ciLog, deploy, deployTest, pr, runDeploy, tracked } from './ship.mjs';
import { ID_RE } from './tick.mjs';
import { triage } from './triage.mjs';
import { setupJob } from './worktree.mjs';

const int = s => (/^\d+$/.test(String(s)) ? Number(s) : null);
const KIND = /^[\w-]+$/, ENTRY = /^[a-z]+:[\w.:-]+$/;

export async function run(argv) {
  const args = [...argv], p = args.indexOf('--project'), project = p >= 0 ? args.splice(p, 2)[1] : process.cwd();
  let cfg = loadConfig(project);
  if (existsSync(`${cfg.paths.main}/.forja/config.json`)) cfg = loadConfig(project, { mainDir: cfg.paths.main });
  const [cmd, n0, ...a] = args, n = int(n0);
  const done = res => { console.log(JSON.stringify(res)); return res.status === 'ok' ? 0 : res.status === 'limited' ? 3 : 1; };
  const step = (kind, fn, role = null, entry = null, round = 0) => tracked(cfg, n, kind, fn, { w: role && { role, model: entry, round } }).then(done);
  const bad = () => { console.error('usage: see the header of call.mjs'); return 2; };

  if (['deploy', 'deploy-test'].includes(cmd)) {
    const ids = [n0, ...a].filter(Boolean);
    return ids.length && ids.every(id => ID_RE.test(id)) ? done(await runDeploy(cfg, cmd === 'deploy-test', ids)) : bad();
  }
  if (cmd === 'log') return KIND.test(n0 ?? '') && int(a[0]) !== null ? (logCall(cfg.paths.state, n0, int(a[0]), a[1] ?? 'call'), 0) : bad();
  if (n === null) return bad();
  const round = int(a.at(-1));
  if (cmd === 'setup') setupJob(cfg, n);
  else if (cmd === 'build' && ENTRY.test(a[0] ?? '') && round !== null) return step('build', () => build(cfg, n, a[0], round), 'build', a[0], round);
  else if (cmd === 'check' && ENTRY.test(a[0] ?? '') && round !== null) return step('check', () => check(cfg, n, a[0], round));
  else if (cmd === 'review' && KIND.test(a[0] ?? '') && ENTRY.test(a[1] ?? '') && round !== null) return step(`review-${a[0]}`, () => review(cfg, n, a[0], a[1], round), `review-${a[0]}`, a[1], round);
  else if (cmd === 'goldfish' && ENTRY.test(a[0] ?? '')) return step('goldfish', () => goldfish(cfg, n, a[0]), 'goldfish', a[0], 0);
  else if (cmd === 'pr') console.log(pr(cfg, n));
  else if (cmd === 'cilog' && int(a[0]) !== null && int(a[1]) !== null) ciLog(cfg, n, int(a[0]), int(a[1]));
  else if (cmd === 'triage') console.log(JSON.stringify(await triage(cfg, n)));
  else return bad();
  return 0;
}

if (resolve(process.argv[1] ?? '').toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  try { process.exitCode = await run(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
