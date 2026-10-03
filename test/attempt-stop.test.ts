import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyFailure, recoverInFlight } from '../lib/foreman.ts';
import { apply, act } from '../lib/actions.ts';
import { observeOnce } from '../lib/observe.ts';
import type { Feature } from '../lib/types.ts';

const feature = (attempts = 0): Feature => ({ id: 'a', title: 'A', description: '', acceptance: ['check'],
  surface: 'any', deps: [], priority: 1, status: 'testing', attempts, updatedAt: '' });

test('R16: counted failures replace prior uncounted stop identity using the incremented counter', () => {
  const f = { ...feature(1), stop: { attempt: 2, counted: false } };
  applyFailure(f, 'FAILED check: defect', 2);
  assert.deepEqual([f.status, f.attempts, f.stop], ['stuck', 2, { attempt: 2, counted: true }]);
});

test('R16: overdue recovery records the executed try without consuming a failure', () => {
  for (const attempts of [0, 1]) {
    const f = { ...feature(attempts), pid: 8, stop: undefined as { attempt: number; counted: boolean } | undefined };
    const result = recoverInFlight([f], { overdue: () => true });
    assert.deepEqual(result.stuck, ['a']);
    assert.deepEqual([f.status, f.attempts, f.pid, f.stop], ['stuck', attempts, 8, { attempt: attempts + 1, counted: false }]);
  }
});

test('R16: recovery clears resolved stop metadata and preserves it for an alive child', () => {
  const fs = ['todo', 'merged', 'alive'].map((id) => ({ ...feature(), id, stop: { attempt: 1, counted: false } }));
  recoverInFlight(fs, { merged: (f) => f.id === 'merged', alive: (f) => f.id === 'alive' });
  assert.deepEqual(fs.map((f) => f.stop), [undefined, undefined, { attempt: 1, counted: false }]);
});

test('R16: human pause preserves a stop; successful resume and retry clear it', () => {
  const paused = { ...feature(1), status: 'stuck' as const, stop: { attempt: 2, counted: false } };
  assert.equal(apply(paused, 'pause', 3), null);
  assert.deepEqual(paused.stop, { attempt: 2, counted: false });
  assert.equal(apply(paused, 'resume', 3), null);
  assert.equal(paused.stop, undefined);
  assert.equal(paused.attempts, 1);
  const retried = { ...feature(1), status: 'stuck' as const, stop: { attempt: 2, counted: false } };
  assert.equal(apply(retried, 'retry', 3), null);
  assert.deepEqual([retried.attempts, retried.stop], [0, undefined]);
});

test('R16: observer send-back clears stop metadata when it resets the counter', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factos-stop-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('commit', '-q', '--allow-empty', '-m', 'init');
  const dir = join(root, '.fact-os'); mkdirSync(dir);
  const feedback = 'test command `gate` exited 1: ECONNREFUSED';
  writeFileSync(join(dir, 'features.json'), JSON.stringify({ features: [{ ...feature(1), status: 'stuck', lastFeedback: feedback, stop: { attempt: 1, counted: true } }] }));
  writeFileSync(join(dir, 'human.json'), '{"tasks":[]}'); writeFileSync(join(dir, 'config.json'), '{"observer":{"agent":null}}');
  writeFileSync(join(dir, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), feature: 'a', event: 'stuck', detail: feedback, stop: { attempt: 1, counted: true } }) + '\n');
  await observeOnce(root, { out: () => {} });
  const f = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')).features[0];
  assert.deepEqual([f.status, f.attempts, f.stop], ['todo', 0, undefined]);
  const reset = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((e) => e.event === 'observer-retry');
  assert.equal(reset.attemptsReset, true);
});

test('R16: human resume records whether numbering reset and clears stop metadata in either case', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factos-stop-actions-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.fact-os'); mkdirSync(dir);
  writeFileSync(join(dir, 'config.json'), '{"maxAttempts":3}');
  writeFileSync(join(dir, 'features.json'), JSON.stringify({ features: [1, 3].map((attempts) => ({ ...feature(attempts), id: String(attempts), status: 'paused', stop: { attempt: attempts, counted: true } })) }));
  assert.deepEqual(await act(root, 'resume', ['1', '3']), { 1: null, 3: null });
  const fs = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')).features;
  assert.deepEqual(fs.map((f: Feature) => [f.attempts, f.stop]), [[1, undefined], [0, undefined]]);
  const events = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((e) => [e.feature, e.attemptsReset]), [['1', false], ['3', true]]);
});
