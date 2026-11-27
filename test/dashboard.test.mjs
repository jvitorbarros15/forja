import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadConfig } from '../engine/config.mjs';
import { serve } from '../engine/server.mjs';
import en from '../engine/i18n/en.json' with { type: 'json' };
import ptBR from '../engine/i18n/pt-BR.json' with { type: 'json' };
import { seed } from './fixtures/demo-project/seed.mjs';

const ROOT = resolve(import.meta.dirname, '..').replaceAll('\\', '/');
const html = readFileSync(`${ROOT}/engine/dashboard/index.html`, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const markup = html.replace(/<script>[\s\S]*<\/script>/, '').replace(/<style>[\s\S]*<\/style>/, '');
const used = [...new Set([...html.matchAll(/['"`](ui\.[\w.]+)['"`]/g)].map(m => m[1]))];

test('dashboard has no hardcoded user text', () => {
  assert.doesNotMatch(html, /clareia|jvito|Fábrica/i);
  assert.doesNotMatch(html, /[À-ÖØ-öø-ÿ]/, 'accented letters belong in i18n');
  const visible = markup.replace(/<svg[\s\S]*?<\/svg>|<!--[\s\S]*?-->|<kbd[^>]*>[\s\S]*?<\/kbd>|<h1>Forja<\/h1>|<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  assert.equal(visible, '', 'static markup text must come from data-i18n');
  const prose = [...script.matchAll(/'([^'\\\n]{4,})'/g)].map(m => m[1]).filter(s => /^[A-Z][a-z]+( [a-z]+)+/.test(s) || /\b[a-z]{4,} [a-z]{4,} [a-z]{3,}/i.test(s) && !/[.#\[\]=>:;{}()$%]/.test(s));
  assert.deepEqual(prose, [], 'user-facing prose in script must go through t()');
});

test('every ui key used exists in en.json and pt-BR.json', () => {
  assert.ok(used.length > 200, `found ${used.length} ui keys`);
  for (const k of used) {
    assert.ok(k in en, `${k} missing from en.json`);
    assert.ok(k in ptBR, `${k} missing from pt-BR.json`);
  }
});

test('no ui key in en.json goes unused', () => {
  assert.deepEqual(Object.keys(en).filter(k => k.startsWith('ui.') && !used.includes(k)), []);
});

test('dashboard is one self-contained file', () => {
  assert.doesNotThrow(() => new vm.Script(script), 'script must parse');
  assert.doesNotMatch(html, /<link[^>]+rel=["']?stylesheet|@import|url\(\s*["']?https?:|\s(src|href)=["']https?:/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});

test('server serves the dashboard and every ui string for the demo project', async () => {
  const project = mkdtempSync(`${tmpdir()}/forja-dash-`).replaceAll('\\', '/');
  mkdirSync(`${project}/.forja`, { recursive: true });
  cpSync(`${ROOT}/test/fixtures/demo-project/.forja/config.json`, `${project}/.forja/config.json`);
  for (const language of ['en', 'pt-BR']) {
    const cfg = loadConfig(project, { pluginRoot: ROOT });
    cfg.language = language;
    seed(cfg.paths.state);
    const s = await serve(cfg, { port: 0, gh: async () => '[]' });
    try {
      const page = await fetch(`http://127.0.0.1:${s.port}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      const text = await page.text();
      assert.match(text, /<title>Forja<\/title>/);
      assert.equal(text.match(/<meta name="forja-boot-failed" content="([^"]*)">/)?.[1], (language === 'en' ? en : ptBR)['server.bootFailed']);
      const c = await (await fetch(`http://127.0.0.1:${s.port}/api/config`)).json();
      for (const k of used) assert.ok(c.strings[k], `${language}: ${k} not served`);
      const jobs = await (await fetch(`http://127.0.0.1:${s.port}/api/jobs`)).json();
      assert.deepEqual([...new Set(jobs.map(j => j.stage))].sort(), ['approve', 'build', 'deployed', 'failed', 'merged', 'needs-you', 'pr', 'review', 'spec']);
    } finally { await s.close(); }
  }
});

test('dashboard animates only new cards, guards SSE frames and a failed boot, and says tokens', () => {
  assert.match(html, /\.grid>\.card\.rise\{animation/);
  assert.doesNotMatch(html, /\.grid>\.card\{animation/);
  assert.equal(html.match(/JSON\.parse\(e\.data\)/g).length, 1, 'every SSE payload goes through the guarded parser');
  assert.match(html, /meta\[name="forja-boot-failed"\]/);
  assert.equal(en['ui.tokens'], 'tokens');
  assert.equal(ptBR['ui.tokens'], 'tokens');
  assert.match(html, /t\('ui\.dur\.ms'/);
  assert.doesNotMatch(html, /' ms'/);
});
