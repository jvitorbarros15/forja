import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, openSync, symlinkSync } from 'node:fs';
import { uptime } from 'node:os';

export const IS_WIN = process.platform === 'win32';
const BOOT = Date.now() - uptime() * 1e3;
const run = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A pid recorded before the last boot belongs to nobody. Fast Startup keeps uptime running across a shutdown,
// so when an image is given the pid must also still be that program; anything else reusing it counts as dead.
export function alive(pid, startedAt, image) {
  pid = Number(pid);
  if (!(pid > 0) || new Date(startedAt).getTime() < BOOT) return false;
  try {
    if (IS_WIN) return run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).toLowerCase().startsWith(image ? `"${image.toLowerCase()}"` : '"');
    process.kill(pid, 0);
    return !image || run('ps', ['-p', String(pid), '-o', 'comm=']).toLowerCase().includes(image.toLowerCase().replace(/\.exe$/, ''));
  } catch { return false; }
}

export function killTree(pid) {
  try {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
  } catch {}
}

export function spawnDetached(cmd, args, { cwd, env, logFile } = {}) {
  const fd = logFile ? openSync(logFile, 'a') : 'ignore';
  try {
    const c = spawn(cmd, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    c.on('error', () => {});
    c.unref();
    return c;
  } finally { if (logFile) closeSync(fd); }
}

export const linkDir = (target, path) => symlinkSync(target, path, IS_WIN ? 'junction' : 'dir');

let toast;
export function notify(text, { desktop, logFile } = {}) {
  if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
  if (!desktop) return;
  let c;
  if (IS_WIN) {
    toast ??= spawnSync('powershell', ['-NoProfile', '-Command', 'if (Get-Module -ListAvailable BurntToast) { exit 0 } else { exit 1 }'], { stdio: 'ignore', windowsHide: true }).status === 0;
    if (!toast) return;
    c = spawn('powershell', ['-NoProfile', '-Command', 'Import-Module BurntToast; New-BurntToastNotification -Text "Forja", $env:FORJA_MSG'], { env: { ...process.env, FORJA_MSG: text }, stdio: 'ignore', windowsHide: true });
  } else if (process.platform === 'darwin') {
    c = spawn('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Forja"', '-e', 'end run', text], { stdio: 'ignore' });
  } else {
    c = spawn('notify-send', ['Forja', text], { stdio: 'ignore' });
  }
  c.on('error', () => {});
  c.unref();
}
