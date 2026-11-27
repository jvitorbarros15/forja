import path from 'node:path';
import { exec, tail } from './proc.mjs';
import { usageOf } from './usage.mjs';

// Flags checked against `gemini --help`: -p turns on headless mode and is appended to stdin; --skip-trust is needed
// because a fresh worktree is an untrusted folder, which would otherwise downgrade the approval mode.
// The stats shape (stats.models.<name>.tokens.{prompt,candidates,total}) is not verified against a live call.
function usage(stats) {
  const models = Object.values(stats?.models ?? {});
  if (!models.length) return usageOf([stats]);
  const u = { input: 0, output: 0, total: 0 };
  for (const { tokens: t = {} } of models) { u.input += t.prompt ?? t.input ?? 0; u.output += t.candidates ?? 0; u.total += t.total ?? 0; }
  return u.total || u.input || u.output ? { ...u, total: u.total || u.input + u.output } : null;
}

export async function run(vcfg, model, { cwd, prompt, write, images = [], timeoutMs }) {
  const args = ['-m', model, '--output-format', 'json', '--skip-trust', ...(write ? ['--approval-mode', 'auto_edit'] : []), ...(images.length ? ['--include-directories', [...new Set(images.map((i) => path.dirname(i)))].join(',')] : []), '-p', 'Follow the instructions above.'];
  const r = await exec(vcfg.bin ?? 'gemini', args, { cwd, input: prompt, timeoutMs });
  try {
    const o = JSON.parse(r.out);
    return { ...r, ok: !o.error, text: o.response ?? '', usage: usage(o.stats), err: `${r.err}${o.error?.message ? `\n${o.error.message}` : ''}` };
  } catch { return { ...r, ok: false, text: '', usage: null, err: `${r.err}\n${tail(r.out, 5)}` }; }
}
