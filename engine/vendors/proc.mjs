import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IS_WIN, killTree } from '../platform.mjs';

const JS = /\.(mjs|cjs|js)$/i;
const quote = (a) => (/^[\w./:=\\@%+,-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
const SHELL_MAX = 8000;

export const tail = (s, n = 40) => String(s ?? '').trim().split('\n').slice(-n).join('\n');

function resolveWin(bin) {
  const hasPath = /[\\/]/.test(bin), names = /\.\w+$/.test(bin) ? [bin] : [`${bin}.exe`, `${bin}.cmd`];
  const dirs = hasPath ? [''] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const n of names) {
    const f = d ? path.join(d, n) : n;
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// npm shims end in `"%dp0%\<package path>.js|exe" %*`; running that target directly avoids cmd.exe.
function shimTarget(file) {
  const found = [...fs.readFileSync(file, 'utf8').matchAll(/"%~?dp0%?\\([^"%]+\.(?:[mc]?js|exe))"/gi)].map((m) => m[1]).filter((p) => !/^node\.exe$/i.test(p));
  return found.length ? path.join(path.dirname(file), found.at(-1)) : null;
}

export function exec(bin, args, { cwd, input = '', env, timeoutMs, onPid } = {}) {
  let cmd = bin, argv = args, shell = false;
  if (JS.test(bin)) { cmd = process.execPath; argv = [bin, ...args]; }
  else if (IS_WIN) {
    const file = resolveWin(bin) ?? bin, target = /\.(cmd|bat)$/i.test(file) ? shimTarget(file) : null;
    if (target) { cmd = JS.test(target) ? process.execPath : target; argv = JS.test(target) ? [target, ...args] : args; }
    else if (/\.(cmd|bat)$/i.test(file)) {
      if (args.some((a) => /[\r\n]/.test(a)) || args.join(' ').length > SHELL_MAX) {
        return Promise.reject(new Error(`${bin} resolves to a .cmd/.bat shim; multi-line or long arguments cannot pass through cmd.exe — set vendors.${path.basename(bin).replace(/\.\w+$/, '')}.bin to the .exe or .js entry`));
      }
      shell = true; cmd = [file, ...args].map(quote).join(' '); argv = [];
    } else cmd = file;
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
