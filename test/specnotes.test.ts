import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRule, lessonsToLearn, parseIssues, parseRule, readSpecNotes, retireRule, specNotesPass, SPEC_NOTES_MAX } from '../lib/specnotes.ts';
import { candidates } from '../lib/specfix.ts';
import { loadConfig } from '../lib/state.ts';
import type { Feature, LogEvent } from '../lib/types.ts';

const F = (o: Partial<Feature> = {}): Feature => ({ id: 'a', title: 'Faster gate', description: 'Resume it only if the conflicts stay above 5 a day. Skip cheap suites.', acceptance: ['The gate is at least 6 minutes faster.'],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });
const ev = (event: string, detail: string, o: Partial<LogEvent> = {}): LogEvent => ({ ts: `2026-10-05T10:0${Math.floor(Math.random() * 9)}:00Z`, feature: 'a', event, detail, ...o });
const tmp = (t: { after: (fn: () => void) => void }) => { const r = mkdtempSync(join(tmpdir(), 'fact-os-notes-')); t.after(() => rmSync(r, { recursive: true, force: true })); mkdirSync(join(r, '.fact-os')); return r; };

test('lessonsToLearn: an applied spec fix, or a person\'s edit after a spec-error hold; each source once', () => {
  const f = F({ specFixes: [{ id: 'S1', ts: '', by: 'person', target: 1, old: 'at least 6 minutes', new: 'at least 3 minutes', why: 'busy-machine timings', evidence: [{ quote: 'saving is 214.7 s', source: 'feedback' }] }] });
  const events = [ev('spec-fix-applied', 'S1 person: acceptance item 1: "6" → "3"'), ev('acceptance-changed', 'by a person (Oscar): the 6 came from parallel gates'), ev('planning-hold', 'spec-error (high), review a/1: q'),
    ev('acceptance-changed', 'spec fix S1 applied by a person (…)')];
  const l = lessonsToLearn(events, [f], new Set());
  assert.deepEqual(l.map((x) => x.change.slice(0, 26)), ['Acceptance item 1 changed ', 'the 6 came from parallel g']);
  assert.deepEqual(lessonsToLearn(events, [f], new Set(l.map((x) => x.key))), []);
  assert.deepEqual(lessonsToLearn(events.slice(1, 2), [f], new Set()), []); // a person's edit with no spec-error hold teaches nothing
});

test('parseRule: one bounded general sentence, never a feature id; null is a valid "no rule"', () => {
  assert.deepEqual(parseRule('{"rule": "Base timing targets on an isolated back-to-back measurement.", "why": "parallel timings mislead"}'), { rule: 'Base timing targets on an isolated back-to-back measurement.', why: 'parallel timings mislead' });
  assert.deepEqual(parseRule('{"rule": null, "why": "specific"}'), { rule: null, why: 'specific' });
  assert.equal(parseRule('{"rule": "Like F99-32, measure alone.", "why": "x"}'), null);
  assert.equal(parseRule(`{"rule": "${'x'.repeat(300)}", "why": "x"}`), null); assert.equal(parseRule('{"rule": "r"}'), null);
});

test('addRule and retireRule: merged, capped with the oldest archived, retired on request', (t) => {
  const root = tmp(t);
  assert.ok(addRule(root, 'Never put launch conditions in a spec\'s text; use a pause or a dependency.'));
  assert.ok(!addRule(root, 'Never put launch conditions in a spec\'s text; use a pause or a dependency.'));
  for (let i = 0; i < 20; i++) addRule(root, `Rule number ${i} ${'y'.repeat(200)}`);
  assert.ok(Buffer.byteLength(readSpecNotes(root).join('\n')) <= SPEC_NOTES_MAX);
  assert.match(readFileSync(join(root, '.fact-os/spec-notes.archive.md'), 'utf8'), /oldest dropped/);
  const last = readSpecNotes(root).at(-1)!;
  assert.ok(retireRule(root, last, 'released twice')); assert.ok(!readSpecNotes(root).includes(last));
});

test('parseIssues: a real rule and a word-for-word quote from the spec, or nothing', () => {
  const notes = ['- Never put launch conditions in a spec\'s text.', '- Base timing targets on an isolated measurement.'];
  const out = parseIssues(JSON.stringify({ issues: [{ rule: 1, quote: 'Resume it only if the conflicts stay above 5 a day.', why: 'a launch condition' },
    { rule: 3, quote: 'Skip cheap suites.', why: 'no such rule' }, { rule: 2, quote: 'at least 6 … faster', why: 'ellipsis' }, { rule: 2, quote: 'ten minutes faster', why: 'not in the spec' }] }), F(), notes);
  assert.deepEqual(out, [{ note: 'Never put launch conditions in a spec\'s text.', quote: 'Resume it only if the conflicts stay above 5 a day.', why: 'a launch condition' }]);
  assert.equal(parseIssues('nope', F(), notes), null);
});

test('specNotesPass: a never-launched feature breaking a learned rule is held for a spec fix; launched or checked ones are not; a stopping observer does nothing', async (t) => {
  const root = tmp(t), fake = join(root, 'fake-claude');
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ issues: [{ rule: 1, quote: 'Resume it only if the conflicts stay above 5 a day.', why: 'launch condition' }] }) })}'\n`);
  chmodSync(fake, 0o755);
  const prev = process.env.FACTOS_CLAUDE; process.env.FACTOS_CLAUDE = fake; t.after(() => { if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev; });
  addRule(root, 'Never put launch conditions in a spec\'s text; use a pause or a dependency.');
  writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [F(), F({ id: 'b' }), F({ id: 'c', attempts: 1 })] }));
  writeFileSync(join(root, '.fact-os/log.jsonl'), JSON.stringify({ ts: 't', feature: 'b', event: 'launch', detail: '' }) + '\n');
  const config = loadConfig(root), state = {}, io = { out: () => {}, children: new Set<never>(), stopping: () => false };
  await specNotesPass(root, config, { model: 'opus' }, state, [{ ts: 't', feature: 'b', event: 'launch', detail: '' }], { ...io, stopping: () => true });
  assert.equal(JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')).features[0].planningHold, undefined);
  await specNotesPass(root, config, { model: 'opus' }, state, [{ ts: 't', feature: 'b', event: 'launch', detail: '' }], io);
  const [a, b, c] = JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')).features as Feature[];
  assert.equal(a!.planningHold!.cause, 'spec-error'); assert.match(a!.planningHold!.review, /^precheck:/); assert.equal(a!.specCheck!.issues.length, 1);
  assert.deepEqual([b!.planningHold, c!.planningHold], [undefined, undefined]);
  assert.match(readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8'), /"event":"planning-hold".*pre-launch check/);
  // The spec-fix flow picks the pre-launch hold up, with the check's quotes as evidence and no launch.
  const cand = candidates(root, config, [a!], {}, []);
  assert.deepEqual(cand.map((x) => [x.f.id, x.key.startsWith('precheck:'), x.launch, x.review.evidence[0]]), [['a', true, undefined, 'Resume it only if the conflicts stay above 5 a day.']]);
});
