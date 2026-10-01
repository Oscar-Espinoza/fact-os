import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTag, promptFingerprint } from '../lib/foreman.ts';
import { parseVerdict, parseClaudeOutput, applyFailure, recoverInFlight, feedbackFromVerdict, appendLesson,
  waitForChange, stamp, childAlive, procStart, groupOf } from '../lib/foreman.ts';
import type { Feature } from '../lib/types.ts';

// Only the fields these pure helpers read; the rest of a Feature doesn't matter to them.
const feat = (o: Partial<Feature>) => o as Feature;

const verdict = (o = {}) => JSON.stringify({ pass: true, findings: [{ check: 'c1', ok: true, evidence: 'e' }], cheating: [], lesson: null, ...o });

test('parseVerdict accepts a bare JSON verdict and one wrapped in prose/fences', () => {
  assert.equal(parseVerdict(verdict()).pass, true);
  const v = parseVerdict('Here is my verdict:\n```json\n' + verdict({ lesson: 'L' }) + '\n```\nThanks');
  assert.equal(v.pass, true);
  assert.equal(v.lesson, 'L');
});

test('parseVerdict fails closed on unparseable or malformed output', () => {
  for (const bad of ['', 'looks good to me!', '{"pass": true', JSON.stringify({ pass: 'true', findings: [] }),
    JSON.stringify({ findings: [] }), JSON.stringify({ pass: true }), '[true]']) {
    const v = parseVerdict(bad);
    assert.equal(v.pass, false, bad);
    assert.ok(v.error, bad);
  }
});

test('parseVerdict: pass:true with a failed finding or cheating is still a fail', () => {
  assert.equal(parseVerdict(verdict({ findings: [{ check: 'c', ok: false, evidence: 'no' }] })).pass, false);
  assert.equal(parseVerdict(verdict({ cheating: ['test asserts true'] })).pass, false);
});

test('parseClaudeOutput reads result and cost (total_cost_usd, falling back to cost_usd)', () => {
  assert.deepEqual(parseClaudeOutput(JSON.stringify({ type: 'result', is_error: false, result: 'hi', total_cost_usd: 0.5 })),
    { ok: true, text: 'hi', cost: 0.5 });
  assert.equal(parseClaudeOutput(JSON.stringify({ result: 'x', cost_usd: 0.25 })).cost, 0.25);
  const err = parseClaudeOutput(JSON.stringify({ is_error: true, result: 'budget exceeded', total_cost_usd: 1 }));
  assert.equal(err.ok, false); assert.equal(err.cost, 1);
  assert.equal(parseClaudeOutput('not json').ok, false);
});

test('applyFailure: attempts increment, feedback kept, stuck at maxAttempts', () => {
  const f = feat({ id: 'a', status: 'evaluating', attempts: 0 });
  applyFailure(f, 'fb1', 2);
  assert.deepEqual([f.status, f.attempts, f.lastFeedback], ['todo', 1, 'fb1']);
  applyFailure(f, 'fb2', 2);
  assert.deepEqual([f.status, f.attempts, f.lastFeedback], ['stuck', 2, 'fb2']);
});

test('recoverInFlight resets only in-flight statuses and keeps attempts', () => {
  const fs = (['building', 'testing', 'evaluating', 'todo', 'ready', 'merged', 'stuck'] as const).map((s) => feat({ id: s, status: s, attempts: 1 }));
  assert.deepEqual(recoverInFlight(fs).todo, ['building', 'testing', 'evaluating']);
  assert.deepEqual(fs.map((f) => f.status), ['todo', 'todo', 'todo', 'todo', 'ready', 'merged', 'stuck']);
  assert.ok(fs.every((f) => f.attempts === 1));
});

test('recoverInFlight: a merged branch wins; an overdue live child makes the feature stuck with its pid', () => {
  const fs = [feat({ id: 'm', status: 'testing', pid: 7 }), feat({ id: 'o', status: 'building', pid: 8 }), feat({ id: 'd', status: 'evaluating', pid: 9 })];
  const r = recoverInFlight(fs, { merged: (f) => f.id === 'm', overdue: (f) => f.id !== 'd' });
  assert.deepEqual([r.merged, r.stuck, r.todo], [['m'], ['o'], ['d']]);
  assert.deepEqual(fs.map((f) => f.status), ['merged', 'stuck', 'todo']);
  assert.equal(fs[1].lastFeedback, 'previous child still running (pid 8)');
});

test('waitForChange returns at once when the files changed after the caller\'s stamp (bug: missed wakeup)', async (t) => {
  const d = mkdtempSync(join(tmpdir(), 'fact-os-wait-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const P = { features: join(d, 'features.json'), human: join(d, 'human.json') };
  writeFileSync(P.features, '{}');
  const before = stamp(P);
  writeFileSync(P.human, '{}'); // e.g. `shipyard done` lands between load() and the wait
  const r = await Promise.race([waitForChange(P, before, () => false).then(() => 'woke'), new Promise((r) => setTimeout(r, 1000, 'slept'))]);
  assert.equal(r, 'woke');
});

test('feedbackFromVerdict lists failed findings and cheating, not passing findings', () => {
  const fb = feedbackFromVerdict({ pass: false, findings: [{ check: 'good', ok: true, evidence: 'fine' },
    { check: 'bad', ok: false, evidence: 'returns 42 always' }], cheating: ['skipped test'] });
  assert.match(fb, /bad.*returns 42 always/);
  assert.match(fb, /skipped test/);
  assert.doesNotMatch(fb, /good/);
  assert.match(feedbackFromVerdict({ pass: false, error: 'unparseable', findings: [], cheating: [] }), /unparseable/);
});

test('appendLesson: creates heading once, dedupes by exact text, keeps later sections intact', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'fact-os-lesson-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const file = join(d, 'CLAUDE.md');
  assert.equal(appendLesson(file, 'Run the linter', '2026-01-01'), true);
  assert.equal(appendLesson(file, 'Run the linter', '2026-02-02'), false);
  assert.equal(appendLesson(file, 'Multi\nline  lesson', '2026-01-01'), true);
  let s = readFileSync(file, 'utf8');
  assert.equal(s.match(/## fact-os lessons/g)!.length, 1);
  assert.equal(s.match(/Run the linter/g)!.length, 1);
  assert.match(s, /- 2026-01-01: Multi line lesson/);
  writeFileSync(file, '# Proj\n\n## Shipyard lessons\n\n- 2026-01-01: A\n\n## Other\n\ntext\n');
  appendLesson(file, 'B', '2026-01-03');
  s = readFileSync(file, 'utf8');
  assert.ok(s.indexOf('- 2026-01-03: B') < s.indexOf('## Other'), s);
  assert.match(s, /## Other\n\ntext\n$/);
});

test('childAlive: a foreign pid (EPERM), a reused pid or a missing start time is not our child (bug: pid 1 waited on forever)', (t) => {
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout);
  const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => kid.kill());
  // Without /proc: dead once the recorded foreman is dead, otherwise by pid.
  assert.equal(childAlive({ pid: kid.pid, foremanPid: dead }, { proc: false }), false);
  assert.equal(childAlive({ pid: kid.pid, foremanPid: process.pid }, { proc: false }), true);
  assert.equal(childAlive({ pid: dead, foremanPid: process.pid }, { proc: false }), false);
  if (!existsSync('/proc/self/stat')) return;
  assert.equal(childAlive({ pid: 1 }), false, 'pid 1 exists but has no recorded start time');
  assert.equal(childAlive({ pid: 1, pidStart: procStart(1)!, foremanPid: process.pid }), false, 'EPERM: not our user');
  const start = procStart(kid.pid!)!;
  assert.match(start, /^\d+$/);
  assert.equal(childAlive({ pid: kid.pid, pidStart: start }), true);
  assert.equal(childAlive({ pid: kid.pid, pidStart: String(Number(start) + 1) }), false, 'same pid, other process');
  assert.equal(childAlive({ pid: dead, pidStart: start }), false);
});

test('groupOf: explicit group wins; idPrefix:<n> defaults to the first n chars of the id; null or unknown groupBy means no group', () => {
  assert.equal(groupOf({ id: 'F05-02-x' }, 'idPrefix:3'), 'F05');
  assert.equal(groupOf({ id: 'F05-02-x', group: 'db' }, 'idPrefix:3'), 'db');
  assert.equal(groupOf({ id: 'F05-02-x', group: 'db' }, null), 'db');
  assert.equal(groupOf({ id: 'F05-02-x' }, null), null);
  assert.equal(groupOf({ id: 'F05-02-x' }, 'bogus'), null);
});

test('runTag never reuses an earlier pass\'s run files', () => {
  assert.equal(runTag([], 1), '1');
  assert.equal(runTag(['1-build.json', '1-eval.json'], 1), '1.2');
  assert.equal(runTag(['1-build.json', '1.2-build.json'], 1), '1.3');
  assert.equal(runTag(['1-build.json'], 2), '2');
});

test('promptFingerprint names the role, model and effort, and hashes lessons and briefs', () => {
  const a = promptFingerprint('builder', { model: 'opus', effort: 'medium' }, 'lessons v1', 'brief');
  assert.match(a, /^builder model=opus effort=medium lessons=[0-9a-f]{8} briefs=[0-9a-f]{8}$/);
  assert.notEqual(a, promptFingerprint('builder', { model: 'opus', effort: 'medium' }, 'lessons v2', 'brief'));
  assert.equal(promptFingerprint('evaluator', {}, null, ''), 'evaluator model=- effort=- lessons=- briefs=-');
});
