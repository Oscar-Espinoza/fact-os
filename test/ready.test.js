import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, validate } from '../lib/ready.js';

const F = (id, o = {}) => ({ id, title: id, description: '', acceptance: ['works'], surface: 'any',
  deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '2026-01-01T00:00:00Z', ...o });
const T = (id, unblocks, o = {}) => ({ id, title: id, steps: [], unblocks, mockable: false, status: 'open', ...o });

test('ready only when every dep is merged (bug: checking direct deps exist instead of their status)', () => {
  const fs = [F('a', { status: 'merged' }), F('b', { deps: ['a'] }), F('c', { deps: ['b'] }), F('d', { deps: ['a', 'c'] })];
  assert.deepEqual(analyze(fs, [], 'auto').ready, ['b']);
});

test('manual merge treats "ready" deps as satisfied; auto merge does not', () => {
  const fs = [F('a', { status: 'ready' }), F('b', { deps: ['a'] })];
  assert.deepEqual(analyze(fs, [], 'manual').ready, ['b']);
  assert.deepEqual(analyze(fs, [], 'auto').ready, []);
});

test('only todo features are ready (bug: relaunching building/stuck/merged features)', () => {
  const fs = ['building', 'testing', 'evaluating', 'ready', 'merged', 'stuck'].map((s) => F(s, { status: s }));
  assert.deepEqual(analyze(fs, [], 'manual').ready, []);
});

test('open non-mockable human task makes a feature waiting-on-human; a done task does not block', () => {
  const fs = [F('a'), F('b')];
  const r = analyze(fs, [T('h1', ['a']), T('h2', ['b'], { status: 'done' })], 'auto');
  assert.deepEqual(r.ready, ['b']);
  assert.deepEqual(r.waiting, ['a']);
});

test('open mockable task → ready and flagged onMock; any non-mockable blocker still wins', () => {
  const fs = [F('a'), F('b')];
  const r = analyze(fs, [T('m', ['a', 'b'], { mockable: true }), T('h', ['b'])], 'auto');
  assert.deepEqual(r.ready, ['a']);
  assert.ok(r.mock.has('a'));
  assert.deepEqual(r.waiting, ['b']);
});

test('cycles, self-deps and unknown deps are reported and never ready', () => {
  const fs = [F('a', { deps: ['b'] }), F('b', { deps: ['a'] }), F('s', { deps: ['s'] }),
    F('u', { deps: ['ghost'] }), F('ok')];
  const r = analyze(fs, [], 'auto');
  assert.deepEqual(r.ready, ['ok']);
  for (const id of ['a', 'b', 's', 'u']) assert.ok(r.bad.has(id), id);
  const errs = validate(fs, []).join('\n');
  assert.match(errs, /cycle.*a/);
  assert.match(errs, /cycle.*s/);
  assert.match(errs, /u.*unknown dep.*ghost/);
});

test('a todo feature in a cycle is never ready, even when its dep in the cycle is merged (bug: no cycle check)', () => {
  const r = analyze([F('a', { deps: ['b'], status: 'merged' }), F('b', { deps: ['a'] })], [], 'auto');
  assert.deepEqual(r.ready, []);
  assert.ok(r.bad.has('b'));
});

test('ids that are not slugs are bad and never ready (bug: path traversal through the worktree path)', () => {
  const r = analyze([F('../evil'), F('a b'), F(''), F('ok')], [], 'auto');
  assert.deepEqual(r.ready, ['ok']);
  for (const id of ['../evil', 'a b', '']) assert.ok(r.bad.has(id), id);
});

test('duplicate ids and unknown unblocks are reported', () => {
  const errs = validate([F('a'), F('a')], [T('h', ['nope'])]).join('\n');
  assert.match(errs, /duplicate.*a/);
  assert.match(errs, /h.*unknown feature.*nope/);
});

test('order: priority, then transitive dependents (more first), then id', () => {
  const fs = [
    F('x'), F('a0'), F('y'), F('z'), F('q', { priority: 0 }),
    F('w', { deps: ['y'], priority: 9 }), F('v', { deps: ['w'], priority: 9 }), // y has 2 transitive dependents
    F('u', { deps: ['z'], priority: 9 }), // z has 1
  ];
  assert.deepEqual(analyze(fs, [], 'auto').ready, ['q', 'y', 'z', 'a0', 'x']);
});
