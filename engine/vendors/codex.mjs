import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from './proc.mjs';
import { usageOf } from './usage.mjs';

// codex --json prints one event per line; only turn.completed carries usage.
const usage = (out) => usageOf(String(out ?? '').split('\n').map((l) => { try { const e = JSON.parse(l); return e.type === 'turn.completed' ? e.usage : null; } catch { return null; } }).filter(Boolean));

export async function run(vcfg, model, { cwd, prompt, write, images = [], timeoutMs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-codex-')), file = `${dir}/last.txt`;
  try {
    const args = ['exec', ...images.flatMap((i) => ['-i', i]), '-m', model, '-C', cwd, '-s', write ? 'workspace-write' : 'read-only', '-c', 'approval_policy="never"', '--json', '-o', file, '-'];
    const r = await exec(vcfg.bin ?? 'codex', args, { cwd, input: prompt, timeoutMs });
    return { ...r, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', usage: usage(r.out) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
