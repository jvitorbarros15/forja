import path from 'node:path';
import { IS_WIN } from '../platform.mjs';
import { exec, tail } from './proc.mjs';
import { usageOf } from './usage.mjs';

// agy takes the prompt on the command line, which Windows caps at 32767 characters.
export const ARGV_MAX = 30000;

export async function run(vcfg, model, { cwd, prompt, write, images = [], timeoutMs = 40 * 60e3 }) {
  if (IS_WIN && prompt.length > ARGV_MAX) return { code: -1, out: '', err: `prompt of ${prompt.length} characters exceeds the ${ARGV_MAX} the command line allows`, text: '', usage: null, ok: false };
  // Never --dangerously-skip-permissions: builds use accept-edits (only file edits auto-approved), reviews plan (read-only).
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--mode', write ? 'accept-edits' : 'plan', '--print-timeout', `${Math.max(1, Math.floor(timeoutMs / 60e3) - 5)}m`, ...(images.length ? ['--add-dir', path.dirname(images[0])] : [])];
  const r = await exec(vcfg.bin ?? 'agy', args, { cwd, timeoutMs });
  try {
    const o = JSON.parse(r.out);
    return { ...r, ok: o.status === 'SUCCESS', text: o.response ?? '', usage: usageOf([o.stats ?? o.usage ?? o.usageMetadata]), err: `${r.err}${o.error?.message ? `\n${o.error.message}` : ''}` };
  } catch { return { ...r, ok: false, text: '', usage: null, err: `${r.err}\n${tail(r.out, 5)}` }; }
}
