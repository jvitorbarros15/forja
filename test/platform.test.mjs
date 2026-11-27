import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { IS_WIN, alive, aliveAsync, killOne, killTree, spawnDetached, linkDir, notify } from '../engine/platform.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'forja-plat-'));

test('alive is true for current process', () => {
  assert.equal(alive(process.pid, new Date().toISOString()), true);
});

test('alive is false for pid started before boot', () => {
  assert.equal(alive(process.pid, '2000-01-01T00:00:00Z'), false);
});

test('alive is false for dead pid', async () => {
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(r => child.on('close', r));
  assert.equal(alive(child.pid, startedAt), false);
});

test('alive checks the image name when given', () => {
  const startedAt = new Date().toISOString();
  assert.equal(alive(process.pid, startedAt, IS_WIN ? 'node.exe' : 'node'), true);
  assert.equal(alive(process.pid, startedAt, 'definitely-not-this.exe'), false);
});

test('alive matches image without .exe', () => {
  const startedAt = new Date().toISOString(), name = basename(process.execPath).replace(/\.exe$/i, '');
  assert.equal(alive(process.pid, startedAt, name), true);
  assert.equal(alive(process.pid, startedAt, name.toUpperCase()), true);
  assert.equal(alive(process.pid, startedAt, `${name}.exe`), true);
  assert.equal(alive(process.pid, startedAt, 'definitely-not-this'), false);
});

test('killTree stops a detached child', async () => {
  const startedAt = new Date().toISOString();
  const child = spawnDetached(process.execPath, ['-e', 'setInterval(()=>{},1e3)']);
  assert.equal(alive(child.pid, startedAt), true);
  killTree(child.pid);
  const end = Date.now() + 5000;
  while (alive(child.pid, startedAt) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  assert.equal(alive(child.pid, startedAt), false);
});

test('killTree never throws on a dead pid', () => {
  killTree(2 ** 22 - 1);
});

test('killTree ignores invalid pids', () => {
  for (const pid of [0, null, undefined, NaN, 1, -1, 'x']) killTree(pid);
  assert.equal(alive(process.pid, new Date().toISOString()), true);
});

test('spawnDetached appends output to logFile', async () => {
  const dir = tmp(), logFile = join(dir, 'out.log');
  spawnDetached(process.execPath, ['-e', 'console.log("hello");console.error("oops")'], { logFile });
  let log = '';
  for (let i = 0; i < 100 && !(/hello/.test(log) && /oops/.test(log)); i++) { await new Promise(r => setTimeout(r, 50)); log = readFileSync(logFile, 'utf8'); }
  assert.match(log, /hello/);
  assert.match(log, /oops/);
  rmSync(dir, { recursive: true, force: true });
});

test('linkDir creates a usable link', () => {
  const dir = tmp(), target = join(dir, 'target'), link = join(dir, 'link');
  mkdirSync(target);
  writeFileSync(join(target, 'f.txt'), 'content');
  linkDir(target, link);
  assert.equal(readFileSync(join(link, 'f.txt'), 'utf8'), 'content');
  rmSync(dir, { recursive: true, force: true });
});

test('notify writes log line when desktop is false', () => {
  const dir = tmp(), logFile = join(dir, 'notify.log');
  notify('build done', { desktop: false, logFile });
  assert.ok(existsSync(logFile));
  assert.match(readFileSync(logFile, 'utf8'), /^\S+ build done\n$/);
  rmSync(dir, { recursive: true, force: true });
});

test('killOne stops the process and leaves its child alive', async () => {
  const dir = tmp(), file = join(dir, 'child.pid');
  const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e3)'], { detached: true, stdio: 'ignore', windowsHide: true }); require('node:fs').writeFileSync(${JSON.stringify(file)}, String(c.pid)); c.unref(); setInterval(() => {}, 1e3);`;
  const parent = spawnDetached(process.execPath, ['-e', script]);
  let childPid;
  try {
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 50));
    childPid = Number(readFileSync(file, 'utf8'));
    killOne(parent.pid);
    const at = new Date(Date.now() - 5000).toISOString();
    for (let i = 0; i < 100 && alive(parent.pid, at, 'node'); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(alive(parent.pid, at, 'node'), false);
    assert.equal(alive(childPid, at, 'node'), true);
  } finally { killTree(childPid); killTree(parent.pid); rmSync(dir, { recursive: true, force: true }); }
});

test('killOne ignores invalid pids', () => {
  for (const pid of [0, null, undefined, NaN, 1, -1, 'x']) killOne(pid);
});

test('aliveAsync checks current, pre-boot, dead, and image-named processes', async () => {
  const now = new Date().toISOString();
  assert.equal(await aliveAsync(process.pid, now), true);
  assert.equal(await aliveAsync(process.pid, '2000-01-01T00:00:00Z'), false);
  assert.equal(await aliveAsync(process.pid, now, 'node'), true);
  assert.equal(await aliveAsync(process.pid, now, 'definitely-not-this'), false);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(r => child.on('close', r));
  assert.equal(await aliveAsync(child.pid, now), false);
});
