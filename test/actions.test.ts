import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, act } from '../lib/actions.ts';
import { analyze } from '../lib/ready.ts';
import type { Feature } from '../lib/types.ts';

const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: id, description: '', acceptance: ['x'], surface: 'any', deps: [], priority: 1,
  status: 'todo', attempts: 0, updatedAt: '', ...o });

test('pause only applies to todo/stuck features; in-flight ones belong to the foreman', () => {
  for (const status of ['building', 'testing', 'evaluating', 'ready', 'merged', 'paused'] as const)
    assert.ok(apply(F('a', { status }), 'pause', 2), status);
  const f = F('a');
  assert.equal(apply(f, 'pause', 2), null);
  assert.equal(f.status, 'paused');
  assert.ok(f.pausedAt);
});

test('a paused feature is never ready, and its dependents wait for it', () => {
  const a = analyze([F('a', { status: 'paused' }), F('b', { deps: ['a'] })], []);
  assert.deepEqual(a.ready, []);
});

test('resume gives a feature paused from stuck a fresh set of attempts (bug: stuck again on first failure)', () => {
  const f = F('a', { status: 'stuck', attempts: 2 });
  apply(f, 'pause', 2);
  assert.equal(apply(f, 'resume', 2), null);
  assert.equal(f.status, 'todo');
  assert.equal(f.attempts, 0);
  assert.equal(f.pausedAt, undefined);
  const g = F('b', { status: 'paused', attempts: 1 });
  apply(g, 'resume', 2);
  assert.equal(g.attempts, 1, 'attempts left alone when some remain');
});

test('retry resets attempts and refreshes of a stuck feature and keeps its feedback for the next build', () => {
  const f = F('a', { status: 'stuck', attempts: 2, refreshes: 5, lastFeedback: 'tests failed' });
  assert.equal(apply(f, 'retry', 2), null);
  assert.deepEqual([f.status, f.attempts, f.refreshes, f.lastFeedback], ['todo', 0, 0, 'tests failed']);
  assert.ok(apply(F('b'), 'retry', 2));
});

test('act writes under the lock, logs applied actions and reports unknown ids', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-act-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os'));
  writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [F('a'), F('b', { status: 'building' })] }));
  const r = await act(root, 'pause', ['a', 'b', 'nope']);
  assert.equal(r.a, null);
  assert.match(r.b!, /building/);
  assert.equal(r.nope, 'unknown feature');
  assert.equal(JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')).features[0].status, 'paused');
  assert.match(readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8'), /"feature":"a","event":"paused"/);
});
