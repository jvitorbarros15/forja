import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ask, prompt, diffBlock, runAgent } from '../engine/vendors/index.mjs';
import { roles } from '../engine/registry.mjs';
import { DEFAULTS } from '../engine/config.mjs';
import { IS_WIN } from '../engine/platform.mjs';
import { exec } from '../engine/vendors/proc.mjs';

const FAKE = path.resolve(import.meta.dirname, 'fixtures/fake-cli.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forja-vendors-')).replace(/\\/g, '/');

function mkCfg() {
  const root = tmp();
  const cfg = structuredClone(DEFAULTS);
  cfg.language = 'en';
  cfg.paths = { project: `${root}/p`, main: `${root}/main`, worktreeRoot: root, state: `${root}/p/.forja/state`, plugin: path.resolve(import.meta.dirname, '..').replace(/\\/g, '/') };
  for (const v of ['codex', 'gemini', 'agy']) Object.assign(cfg.vendors[v], { enabled: true, bin: FAKE });
  cfg.vendors.claude = { bin: FAKE };
  return { cfg, root };
}

const withLog = async (fn) => {
  const log = `${tmp()}/calls.jsonl`;
  process.env.FAKE_LOG = log;
  try { await fn(); } finally { delete process.env.FAKE_LOG; }
  return fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
};

test('codex adapter passes read-only sandbox and parses usage', async () => {
  const { cfg, root } = mkCfg();
  let r;
  const [call] = await withLog(async () => { r = await ask(cfg, { entry: 'codex:gpt-6.2-sol', cwd: root, prompt: 'hello codex' }); });
  assert.equal(r.ok, true);
  assert.deepEqual(call.argv.slice(0, 5), ['exec', '-m', 'gpt-6.2-sol', '-C', root]);
  assert.equal(call.argv[call.argv.indexOf('-s') + 1], 'read-only');
  assert.ok(call.argv.includes('approval_policy="never"'));
  assert.equal(call.argv.at(-1), '-');
  assert.equal(call.stdin, 'hello codex');
  assert.deepEqual(r.usage, { input: 10, output: 5, total: 15 });
  assert.equal(JSON.parse(r.text).stdin, 'hello codex');
});

test('codex write mode uses workspace-write, images go through -i, and aliases resolve through models', async () => {
  const { cfg, root } = mkCfg();
  cfg.vendors.codex.models = { sol: 'gpt-6.2-sol' };
  const [call] = await withLog(async () => { await ask(cfg, { entry: 'codex:sol', cwd: root, prompt: 'x', write: true, images: ['a.png'] }); });
  assert.equal(call.argv[call.argv.indexOf('-m') + 1], 'gpt-6.2-sol');
  assert.equal(call.argv[call.argv.indexOf('-s') + 1], 'workspace-write');
  assert.equal(call.argv[call.argv.indexOf('-i') + 1], 'a.png');
});

test('gemini adapter adds approval mode only when write', async () => {
  const { cfg, root } = mkCfg();
  let r;
  const calls = await withLog(async () => {
    r = await ask(cfg, { entry: 'gemini:gemini-4-neon-high', cwd: root, prompt: 'review' });
    await ask(cfg, { entry: 'gemini:gemini-4-neon-high', cwd: root, prompt: 'build', write: true });
  });
  assert.ok(!calls[0].argv.includes('--approval-mode'));
  assert.equal(calls[1].argv[calls[1].argv.indexOf('--approval-mode') + 1], 'auto_edit');
  assert.equal(calls[0].argv[calls[0].argv.indexOf('-m') + 1], 'gemini-4-neon-high');
  assert.ok(calls[0].argv.includes('json'));
  assert.equal(calls[0].stdin, 'review');
  assert.deepEqual(r.usage, { input: 10, output: 5, total: 15 });
  assert.equal(JSON.parse(r.text).stdin, 'review');
});

test('agy adapter passes the prompt on argv with the mode for read or write', async () => {
  const { cfg, root } = mkCfg();
  let r;
  const calls = await withLog(async () => {
    r = await ask(cfg, { entry: 'agy:gemini-4-hydrogen-medium', cwd: root, prompt: 'p1' });
    await ask(cfg, { entry: 'agy:gemini-4-hydrogen-medium', cwd: root, prompt: 'p2', write: true });
  });
  assert.equal(calls[0].argv[calls[0].argv.indexOf('-p') + 1], 'p1');
  assert.equal(calls[0].argv[calls[0].argv.indexOf('--mode') + 1], 'plan');
  assert.equal(calls[1].argv[calls[1].argv.indexOf('--mode') + 1], 'accept-edits');
  assert.equal(r.ok, true);
  assert.deepEqual(r.usage, { input: 7, output: 3, total: 10 });
});

test('limited output sets limited', async () => {
  const { cfg, root } = mkCfg();
  process.env.FAKE_LIMIT = '1';
  try {
    for (const entry of ['codex:m', 'gemini:m', 'agy:m']) {
      const r = await ask(cfg, { entry, cwd: root, prompt: 'x' });
      assert.equal(r.ok, false, entry);
      assert.equal(r.limited, true, entry);
      assert.match(r.err, /429/);
    }
  } finally { delete process.env.FAKE_LIMIT; }
});

test('a plain failure is not limited', async () => {
  const { cfg, root } = mkCfg();
  cfg.vendors.gemini.bin = path.join(root, 'missing-cli.mjs');
  const r = await ask(cfg, { entry: 'gemini:m', cwd: root, prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.limited, false);
});

test('ollama adapter posts to url', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => { seen.push({ url: req.url, body: JSON.parse(b) }); res.end(JSON.stringify({ message: { content: 'hi there' }, prompt_eval_count: 4, eval_count: 6 })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { cfg, root } = mkCfg();
    cfg.vendors.ollama = { enabled: true, url: `http://127.0.0.1:${srv.address().port}/`, models: { small: 'gemma4:e4b' } };
    const r = await ask(cfg, { entry: 'ollama:small', cwd: root, prompt: 'triage this' });
    assert.equal(r.ok, true);
    assert.equal(r.text, 'hi there');
    assert.deepEqual(r.usage, { input: 4, output: 6, total: 10 });
    assert.equal(seen[0].url, '/api/chat');
    assert.equal(seen[0].body.model, 'gemma4:e4b');
    assert.equal(seen[0].body.stream, false);
    assert.equal(seen[0].body.messages[0].content, 'triage this');
  } finally { srv.close(); }
});

test('ollama adapter reports http errors', async () => {
  const srv = http.createServer((req, res) => { res.statusCode = 429; res.end('too many requests'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { cfg, root } = mkCfg();
    cfg.vendors.ollama = { enabled: true, url: `http://127.0.0.1:${srv.address().port}` };
    const r = await ask(cfg, { entry: 'ollama:m', cwd: root, prompt: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.limited, true);
  } finally { srv.close(); }
});

test('ask rejects vendors without an adapter', async () => {
  const { cfg, root } = mkCfg();
  await assert.rejects(ask(cfg, { entry: 'local:exact', cwd: root, prompt: 'x' }), /no adapter/);
});

test('prompts fill placeholders from config', () => {
  const { cfg } = mkCfg();
  cfg.privacy = { denyRead: ['data/**'], promptRules: ['Never print a CPF.'] };
  cfg.checks.test = 'npm test';
  const b = prompt(cfg, 'build', { spec: 'SPEC TEXT', vendor: 'codex' });
  assert.match(b, /SPEC TEXT/);
  assert.match(b, /Never print a CPF\./);
  assert.match(b, /files matching data\/\*\*/);
  assert.match(b, /- test: npm test/);
  assert.match(b, /Run the checks listed below/);
  assert.ok(!/\{\{/.test(b));
  assert.match(prompt(cfg, 'build', { spec: 's', vendor: 'gemini' }), /cannot run shell commands/);
  const c = prompt(cfg, 'code', { spec: 's', diff: '\n\n# Diff\nDIFFTEXT' });
  assert.match(c, /VERDICT: PASS or VERDICT: CHANGES/);
  assert.match(c, /senior developer who gets paged/);
  assert.match(c, /DIFFTEXT/);
  assert.match(prompt(cfg, 'ui', { spec: 's', images: 'shot.png' }), /shot\.png/);
  assert.match(prompt(cfg, 'goldfish', { spec: 's' }), /VERDICT: OK or VERDICT: GAPS/);
});

test('prompt override in main wins', () => {
  const { cfg } = mkCfg();
  fs.mkdirSync(`${cfg.paths.main}/.forja/prompts`, { recursive: true });
  fs.writeFileSync(`${cfg.paths.main}/.forja/prompts/code.md`, 'custom review of {{spec}}');
  assert.equal(prompt(cfg, 'code', { spec: 'S' }), 'custom review of S');
  assert.match(prompt(cfg, 'build', { spec: 'S' }), /Implement the spec below/);
  assert.throws(() => prompt(cfg, '../x'), /bad prompt kind/);
});

test('diffBlock cuts the diff for agy to fit the command line', () => {
  const diff = 'x'.repeat(30000);
  assert.match(diffBlock('agy', 'spec', diff), /cut at 21996 characters of 30000/);
  assert.ok(!diffBlock('codex', 'spec', diff).includes('cut at'));
  assert.match(diffBlock('agy', 'y'.repeat(20000), diff), /cut at 4000 /);
});

test('runAgent passes allow, deny and add-dir', async () => {
  const { cfg, root } = mkCfg();
  cfg.limits.agentTimeoutMin = 1;
  const role = roles(cfg).builder;
  let r;
  const [call] = await withLog(async () => { r = await runAgent(cfg, role, { model: 'sonnet', cwd: root, prompt: 'do the job', issue: 7 }, () => {}); });
  const { argv } = call;
  assert.equal(r.code, 0);
  assert.equal(call.stdin, 'do the job');
  assert.ok(argv.includes('--restricted'));
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Grep,Glob,Edit,Write,Bash');
  const after = (flag) => argv.slice(argv.indexOf(flag) + 1, argv.findIndex((a, i) => i > argv.indexOf(flag) && a.startsWith('--')));
  assert.ok(after('--allowedTools').includes('Edit(./**)'));
  assert.ok(after('--allowedTools').includes('Bash(git diff:*)'));
  assert.ok(after('--disallowedTools').includes('Edit(./.forja/**)'));
  assert.ok(after('--disallowedTools').includes('WebFetch'));
  assert.deepEqual(after('--add-dir'), [`${cfg.paths.state}/jobs/7`]);
  assert.match(argv[argv.indexOf('--append-system-prompt') + 1], /spec\.md/);
});

const shim = (body) => {
  const dir = tmp();
  fs.copyFileSync(FAKE, `${dir}/fake-cli.mjs`);
  fs.writeFileSync(`${dir}/tool.cmd`, `@echo off\r\n${body}\r\n`);
  return `${dir}/tool.cmd`;
};

test('a .cmd shim rejects multi-line arguments instead of truncating them', { skip: !IS_WIN }, async () => {
  const bin = shim(`"${process.execPath}" "${FAKE.replace(/\//g, '\\')}" %*`);
  await assert.rejects(exec(bin, ['--x', 'line one\nline two']), /resolves to a \.cmd\/\.bat shim.*set vendors\.tool\.bin/);
  await assert.rejects(exec(bin, ['--x', 'y'.repeat(9000)]), /resolves to a \.cmd\/\.bat shim/);
});

test('a .cmd shim rejects arguments cmd.exe would read as syntax', { skip: !IS_WIN }, async () => {
  const bin = shim(`"${process.execPath}" "${FAKE.replace(/\//g, '\\')}" %*`), marker = `${tmp()}/pwned.txt`;
  for (const arg of ['a & echo x > ' + marker, 'a | b', '%PATH%', 'a ^ b', 'a < b', 'a > b', 'say "hi"', 'a\rb']) {
    await assert.rejects(exec(bin, ['--x', arg]), /resolves to a \.cmd\/\.bat shim/, arg);
  }
  assert.equal(fs.existsSync(marker), false);
});

test('a .cmd shim passes single-line arguments intact', { skip: !IS_WIN }, async () => {
  const bin = shim(`"${process.execPath}" "${FAKE.replace(/\//g, '\\')}" %*`);
  const log = `${tmp()}/calls.jsonl`;
  const r = await exec(bin, ['--x', 'one two'], { input: 'in', env: { ...process.env, FAKE_LOG: log } });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')).argv, ['--x', 'one two']);
});

test('an npm-style shim runs its .js target directly, so multi-line arguments survive', { skip: !IS_WIN }, async () => {
  const bin = shim('"%~dp0\\fake-cli.mjs" %*');
  const log = `${tmp()}/calls.jsonl`;
  const r = await exec(bin, ['--x', 'line one\nline two'], { env: { ...process.env, FAKE_LOG: log } });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')).argv, ['--x', 'line one\nline two']);
});

test('prompts read cleanly when denyRead is empty', () => {
  const { cfg } = mkCfg();
  cfg.privacy.denyRead = [];
  assert.match(prompt(cfg, 'goldfish', { spec: 's' }), /Do not read anything outside this folder\./);
});

test('runAgent kills a run that outlives the agent timeout and reports the pid', async () => {
  const { cfg, root } = mkCfg();
  const slow = `${root}/slow.mjs`;
  fs.writeFileSync(slow, 'setTimeout(() => {}, 60000);');
  cfg.vendors.claude.bin = slow;
  cfg.limits.agentTimeoutMin = 0.01;
  let pid = 0;
  const t0 = Date.now();
  const r = await runAgent(cfg, roles(cfg).builder, { model: 'sonnet', cwd: root, prompt: 'x', jobDir: root }, (p) => { pid = p; });
  assert.ok(pid > 0);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < 20000);
});
