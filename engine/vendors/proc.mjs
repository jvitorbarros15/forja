import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IS_WIN, killTree } from '../platform.mjs';

const JS = /\.(mjs|cjs|js)$/i;
const quote = (a) => (/^[\w./:=\\@%+,-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

function findExe(bin) {
  if (/[\\/]/.test(bin) || /\.\w+$/.test(bin)) return null;
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const f = path.join(d, `${bin}.exe`);
    if (d && fs.existsSync(f)) return f;
  }
  return null;
}

// Bare names on Windows are usually npm .cmd shims, which only run through cmd.exe; a native .exe never needs it.
export function exec(bin, args, { cwd, input = '', env, timeoutMs, onPid } = {}) {
  let cmd = bin, argv = args, shell = false;
  if (JS.test(bin)) { cmd = process.execPath; argv = [bin, ...args]; }
  else if (IS_WIN) {
    const exe = findExe(bin);
    if (exe) cmd = exe;
    else if (!/\.exe$/i.test(bin)) { shell = true; cmd = [bin, ...args].map(quote).join(' '); argv = []; }
  }
  return new Promise((done) => {
    let out = '', err = '', timedOut = false;
    const c = spawn(cmd, argv, { cwd, env, shell, detached: !IS_WIN, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (c.pid) onPid?.(c.pid);
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(c.pid); }, timeoutMs) : null;
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.stdin.on('error', () => {});
    c.on('error', (e) => { clearTimeout(timer); done({ code: -1, out, err: `${err}${e}`, timedOut }); });
    c.on('close', (code) => { clearTimeout(timer); done({ code: timedOut ? -1 : code, out, err: timedOut ? `${err}\ntimed out` : err, timedOut }); });
    c.stdin.end(input);
  });
}
