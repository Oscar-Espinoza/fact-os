import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentWorker } from '../lib/dash.ts';
import type { LogEvent } from '../lib/types.ts';

let clock = Date.parse('2026-10-05T00:00:00Z');
const ev = (event: string, detail = '', o: Partial<LogEvent> = {}): LogEvent => ({ ts: new Date((clock += 60e3)).toISOString(), feature: 'a', event, detail, ...o });

test('currentWorker: only the invocation running in this launch and stage; nobody during the checks', () => {
  const first = [ev('launch'), ev('prompt', 'builder model=sonnet effort=high'), ev('testing', 's'), ev('evaluating'), ev('prompt', 'evaluator model=gpt-6.1-sol effort=high')];
  assert.equal(currentWorker({ id: 'a', status: 'evaluating' }, first), 'Reviewing: GPT-6.1 Sol · high');
  assert.equal(currentWorker({ id: 'a', status: 'testing' }, first.slice(0, 3)), null);
  assert.equal(currentWorker({ id: 'a', status: 'building' }, first.slice(0, 2)), 'Building: Sonnet · high');
  // A new launch that skips its build: the previous launch's reviewer is not working on it.
  const relaunch = [...first, ev('launch'), ev('build-skipped', 'revalidating'), ev('testing', 's'), ev('evaluating')];
  assert.equal(currentWorker({ id: 'a', status: 'evaluating' }, relaunch), null);
  assert.equal(currentWorker({ id: 'a', status: 'testing' }, [...relaunch.slice(0, -1), ev('prompt', 'diagnoser model=opus effort=high')]), 'Diagnosing: Opus · high');
});
