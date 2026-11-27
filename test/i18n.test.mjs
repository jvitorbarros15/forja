import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, aliases, languages } from '../engine/i18n.mjs';
import en from '../engine/i18n/en.json' with { type: 'json' };
import ptBR from '../engine/i18n/pt-BR.json' with { type: 'json' };

const placeholders = s => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();

test('falls back to en then key', () => {
  assert.equal(t('xx', 'comment.spec'), en['comment.spec']);
  assert.equal(t('en', 'no.such.key'), 'no.such.key');
});

test('interpolates vars', () => {
  assert.match(t('en', 'comment.pr', { pr: 7 }), /#7/);
});

test('pt-BR has every en key', () => {
  assert.deepEqual(Object.keys(ptBR).sort(), Object.keys(en).sort());
});

test('placeholders match across languages', () => {
  for (const key of Object.keys(en)) {
    assert.deepEqual(placeholders(ptBR[key]), placeholders(en[key]), key);
  }
});

test('pt-BR has no Fábrica or Clareia leftovers', () => {
  for (const value of Object.values(ptBR)) {
    assert.doesNotMatch(value, /Fábrica|Clareia|CPF|deputad/);
  }
});

test('aliases pt-BR', () => {
  assert.deepEqual(aliases('pt-BR').approve, ['/approve', '/aprovar']);
  assert.deepEqual(aliases('pt-BR').redo, ['/redo', '/refazer']);
});

test('aliases en', () => {
  assert.deepEqual(aliases('en').approve, ['/approve']);
  assert.deepEqual(aliases('en').redo, ['/redo']);
});

test('languages lists en and pt-BR', () => {
  assert.deepEqual([...languages()].sort(), ['en', 'pt-BR']);
});

test('action.headMoved tells the owner to update the branch by hand instead of promising Approve pushes again', () => {
  assert.doesNotMatch(en['action.headMoved'], /Approve pushes/i);
  assert.doesNotMatch(ptBR['action.headMoved'], /Aprovar envia/i);
  assert.match(en['action.headMoved'], /by hand/i);
  assert.match(ptBR['action.headMoved'], /à mão/i);
});
