import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySpecFix, candidates, countedFailure, dismissSpecFix, keepsWording, parseDraft, parseVerify, protectedReason, shapeProblem, undoSpecFix, type FixInput } from '../lib/specfix.ts';
import { holdInputs } from '../lib/foreman.ts';
import { loadConfig } from '../lib/state.ts';
import type { Feature, SpecFixProposal } from '../lib/types.ts';

const OLD = 'Wall time of the step phase on a branch touching only reports is at least 6 minutes lower than with the base selection, measured back to back (both numbers recorded).';
const NEW = 'Wall time of the step phase on a branch touching only reports is at least 3 minutes lower than with the base selection, measured back to back on one lane (both numbers recorded).';
const F = (o: Partial<Feature> = {}): Feature => ({ id: 'a', title: 'Run cheap suites only when their module changes', description: 'Speed up the gate.', acceptance: ['Risk suites always run.', OLD],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 1, updatedAt: '', ...o });
const input = (f: Feature): FixInput => ({ feature: f, feedback: 'FAILED timing: narrowed 107 steps in 437.0 s versus 651.7 s; the saving is 214.7 seconds.', reviewEvidence: ['the audit times came from eight parallel gates'],
  files: [{ path: 'tasks/evidence/a/README.md', text: 'The 6-minute target cannot be met by this config.' }] });
const draft = { target: 2 as const, old: OLD, new: NEW, why: 'The 6 came from busy-machine timings.', evidence: [{ quote: 'the saving is 214.7 seconds', source: 'feedback' }, { quote: 'The 6-minute target cannot be met', source: 'tasks/evidence/a/README.md' }] };

test('parseDraft and parseVerify: a fix, no fix, or a refusal; malformed is an error', () => {
  const ok = parseDraft(JSON.stringify({ fix: { ...draft, target: 2 }, reason: '' }));
  assert.ok(!('error' in ok) && ok.fix!.target === 2 && ok.fix!.evidence.length === 2);
  assert.deepEqual(parseDraft('{"fix": null, "reason": "unfinished implementation"}'), { fix: null, reason: 'unfinished implementation' });
  assert.match((parseDraft('{"fix": {"target": 0, "old": "a", "new": "b", "why": "c"}}') as { error: string }).error, /target/);
  assert.deepEqual(parseVerify('{"agree": true, "reason": "evidence shows it"}'), { agree: true, reason: 'evidence shows it' }); assert.equal(parseVerify('{"agree": "yes"}'), null);
});

test('shapeProblem: the old text must be current, the change real and bounded, every quote verbatim in its source', () => {
  const f = F();
  assert.equal(shapeProblem(f, draft, input(f)), null);
  assert.match(shapeProblem(f, { ...draft, old: 'something else' }, input(f))!, /not the current text/);
  assert.match(shapeProblem(f, { ...draft, target: 9 as never }, input(f))!, /does not exist/);
  assert.match(shapeProblem(f, { ...draft, new: OLD }, input(f))!, /empty or unchanged/);
  assert.match(shapeProblem(f, { ...draft, new: 'x'.repeat(2000) }, input(f))!, /too long/);
  assert.match(shapeProblem(f, { ...draft, evidence: [{ quote: 'the saving is … seconds', source: 'feedback' }] }, input(f))!, /verbatim/);
  assert.match(shapeProblem(f, { ...draft, evidence: [{ quote: 'x', source: '/etc/passwd' }] }, input(f))!, /not one of the inputs/);
});

test('protectedReason: description rewrites, risky features, sensitive wording, test weakening and dropped wording stay manual', () => {
  assert.equal(protectedReason(F(), draft), null);
  assert.ok(keepsWording(OLD, NEW)); assert.ok(!keepsWording(OLD, 'Wall time is at least 3 minutes lower.'));
  assert.match(protectedReason(F(), { target: 'description', old: 'a', new: 'b' })!, /description/);
  assert.match(protectedReason(F({ tier: 'risky' }), draft)!, /risky/);
  assert.match(protectedReason(F({ title: 'Refund payments faster' }), draft)!, /risky/);
  assert.match(protectedReason(F(), { target: 1, old: 'Each tenant sees only its rows.', new: 'Each tenant sees only its rows mostly.' })!, /tenant/);
  assert.match(protectedReason(F(), { target: 1, old: 'The parser test covers nulls.', new: 'The parser test covers nulls; skip the flaky tests.' })!, /weaken a test/);
});

test('countedFailure: only a counted review rejection or own-code gate failure', () => {
  const e = (o: object) => [{ feature: 'a', event: 'failed', detail: '', ...o }];
  assert.ok(countedFailure(e({ stop: { attempt: 1, counted: true }, failure: 'review' }), 'a'));
  assert.ok(!countedFailure(e({ stop: { attempt: 1, counted: true }, failure: 'gate' }), 'a'));
  assert.ok(!countedFailure(e({ stop: { attempt: 1, counted: false }, failure: 'review' }), 'a'));
  assert.ok(countedFailure(e({ stop: { attempt: 1, counted: true }, detail: 'FAILED x' }), 'a'));
});

test('apply, dismiss and undo: one guarded change; auto needs auto mode, Codex agreement, a counted failure and no protection; undo restores while unchanged', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-fix-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os'));
  const config = loadConfig(root), base = F({ planningHold: { cause: 'spec-error', confidence: 'high', evidence: ['x'], review: 'a/1', passEnd: '', inputs: '', ts: '' }, rejected: { sha: 's', tree: 't', inputs: 'i' } as never });
  const inputs = holdInputs(root, config, base);
  const proposal = (o: Partial<SpecFixProposal> = {}): SpecFixProposal => ({ id: 'S1', ts: '', status: 'proposed', inputs, review: 'a/1', sha: null, target: 2, old: OLD, new: NEW, why: 'w',
    evidence: draft.evidence, drafter: { model: 'opus' }, verifier: { provider: 'codex', model: 'gpt-6.1-sol', agree: true, reason: 'ok' }, counted: true, ...o });
  const write = (f: Feature, mode?: string) => {
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [f] }));
    writeFileSync(join(root, '.fact-os/control.json'), JSON.stringify({ paused: false, maxParallel: null, ...(mode ? { specFixes: mode } : {}) }));
  };
  const read = () => JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')).features[0] as Feature;
  const held = { ...base, planningHold: { ...base.planningHold!, inputs } };

  write({ ...held, specFix: proposal() });
  assert.match((await applySpecFix(root, 'a', 'S1', 'auto'))!, /not in auto mode/);
  write({ ...held, specFix: proposal({ verifier: { provider: 'codex', model: 'x', agree: false, reason: 'no' } }) }, 'auto');
  assert.match((await applySpecFix(root, 'a', 'S1', 'auto'))!, /Codex did not verify/);
  write({ ...held, specFix: proposal({ counted: false }) }, 'auto');
  assert.match((await applySpecFix(root, 'a', 'S1', 'auto'))!, /counted/);
  write({ ...held, specFix: proposal() }, 'auto');
  assert.match((await applySpecFix(root, 'a', 'S0', 'auto'))!, /no such proposal/);
  assert.equal(await applySpecFix(root, 'a', 'S1', 'auto'), null);
  let f = read();
  assert.equal(f.acceptance[1], NEW); assert.deepEqual([f.attempts, f.planningHold, f.rejected, f.status, f.specFix!.status, f.specFixes![0]!.by], [0, undefined, undefined, 'todo', 'applied', 'auto']);
  assert.match(readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8'), /"event":"acceptance-changed".*applied automatically.*"attemptsReset":true/);
  // A second automatic fix on the same feature is refused; a person may still apply one.
  write({ ...f, specFix: { ...proposal({ id: 'S2', inputs: holdInputs(root, config, f), old: NEW, new: NEW.replace('3 minutes', '2 minutes') }) } }, 'auto');
  assert.match((await applySpecFix(root, 'a', 'S2', 'auto'))!, /one automatic fix/);
  assert.equal(await dismissSpecFix(root, 'a', 'S2'), null); assert.equal(read().specFix!.status, 'declined');
  // Undo restores the earlier text while it is unchanged, starts a new cycle, and never touches an in-flight feature.
  write({ ...read(), status: 'building' });
  assert.match((await undoSpecFix(root, 'a'))!, /building/);
  write({ ...read(), status: 'todo', attempts: 2 });
  assert.equal(await undoSpecFix(root, 'a'), null);
  f = read(); assert.deepEqual([f.acceptance[1], f.attempts, !!f.specFixes![0]!.undone], [OLD, 0, true]);
  assert.match((await undoSpecFix(root, 'a'))!, /no applied spec fix/);
  // A protected proposal is refused automatically but applied by a person; a paused feature keeps its pause.
  const risky = { ...held, tier: 'risky' as const, status: 'paused' as const };
  write({ ...risky, specFix: proposal({ inputs: holdInputs(root, config, risky) }) }, 'auto');
  assert.match((await applySpecFix(root, 'a', 'S1', 'auto'))!, /protected: the feature is risky/);
  assert.equal(await applySpecFix(root, 'a', 'S1', 'person'), null); assert.equal(read().status, 'paused');
  // A changed spec makes an old proposal unusable.
  write({ ...held, description: 'changed', specFix: proposal() });
  assert.match((await applySpecFix(root, 'a', 'S1', 'person'))!, /changed since it was drafted/);
});

test('candidates: a held todo with matching inputs, or a stuck feature reviewed after its last launch; never twice for the same inputs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-fix-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os'));
  const config = loadConfig(root), rev = (feature: string, ts: string) => ({ ts, feature, tag: '1', role: 'builder', model: 'opus', effort: 'medium', notes: '-', kind: 'evaluator-rejected', next: '',
    cause: 'spec-error', evidence: ['q'], confidence: 'high', suggestion: '', target: null, cost: 0 }) as never;
  const a = F({ id: 'a' }), b = F({ id: 'b', status: 'stuck' }), c = F({ id: 'c', status: 'stuck' });
  const ia = holdInputs(root, config, a);
  a.planningHold = { cause: 'spec-error', confidence: 'high', evidence: ['q'], review: 'a/1', passEnd: '', inputs: ia, ts: '' };
  const byKey = { 'a/1': rev('a', '2026-10-05T10:00:00Z'), 'b/1': rev('b', '2026-10-05T10:00:00Z'), 'c/1': rev('c', '2026-10-05T08:00:00Z') };
  const events = [{ feature: 'b', event: 'launch', ts: '2026-10-05T09:00:00Z' }, { feature: 'c', event: 'launch', ts: '2026-10-05T09:00:00Z' }];
  assert.deepEqual(candidates(root, config, [a, b, c], byKey, events).map((x) => x.f.id), ['a', 'b']);
  a.specFix = { id: 'S', ts: '', status: 'declined', inputs: ia, review: 'a/1', sha: null, drafter: { model: null } };
  assert.deepEqual(candidates(root, config, [a, b, c], byKey, events).map((x) => x.f.id), ['b']);
});
