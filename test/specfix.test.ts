import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySpecFix, candidates, correctionOnly, countedFailure, dismissSpecFix, parseDraft, parseVerify, protectedReason, shapeProblem, specFixPass, undoSpecFix, type FixInput } from '../lib/specfix.ts';
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
  assert.equal(parseVerify('{"agree": true}'), null); assert.equal(parseVerify('{"agree": true, "reason": {}}'), null); // no reason: no verification
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

test('protectedReason and correctionOnly: auto only corrects a quantity on a feature that touches nothing sensitive; everything else waits for a person', () => {
  assert.equal(protectedReason(F(), draft), null);
  assert.equal(correctionOnly('The export must complete within 6 seconds.', 'The export must complete within 9 seconds on one lane.'), null);
  assert.match(correctionOnly('The export must complete within 6 seconds.', 'The export must complete within seconds.')!, /quantity .* no replacement/);
  assert.match(correctionOnly('The export must complete within 6 seconds.', 'The export must not complete within 6 seconds.')!, /adds "not"/);
  assert.match(correctionOnly('The export must complete within 6 seconds.', 'The export completes within 9 seconds.')!, /drops or reorders/);
  assert.match(correctionOnly('Exports are named by date.', 'Exports are named by date and time.')!, /only a corrected quantity/);
  assert.match(protectedReason(F(), { target: 1, old: 'Skip parser tests only on Windows.', new: 'Skip parser tests only on Windows and Linux.' })!, /about tests/);
  assert.match(protectedReason(F(), { target: 'description', old: 'a', new: 'b' })!, /description/);
  assert.match(protectedReason(F({ tier: 'risky' }), draft)!, /risky/);
  assert.match(protectedReason(F({ title: 'Refund payments faster' }), draft)!, /risky/);
  // Another acceptance item mentioning payments protects the whole feature, whatever risk override it carries.
  assert.match(protectedReason({ ...F({ acceptance: ['Payments must never be charged twice.', OLD] }), risk: 'normal' } as Feature, draft)!, /mention payments/i);
});

test('countedFailure: only a counted review rejection or own-code gate failure', () => {
  const e = (o: object) => [{ feature: 'a', event: 'failed', detail: '', ...o }];
  assert.ok(countedFailure(e({ stop: { attempt: 1, counted: true }, failure: 'review' }), 'a'));
  assert.ok(!countedFailure(e({ stop: { attempt: 1, counted: true }, failure: 'gate' }), 'a'));
  assert.ok(!countedFailure(e({ stop: { attempt: 1, counted: false }, failure: 'review' }), 'a'));
  assert.ok(countedFailure(e({ stop: { attempt: 1, counted: true }, detail: 'FAILED x' }), 'a'));
});

test('apply, dismiss and undo: one guarded change for the current failure; auto needs valid auto mode, Codex with a reason, a counted failure and no protection; undo names its fix and needs the whole spec unchanged', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-fix-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os'));
  const L = join(root, '.fact-os/log.jsonl'), launch = '2026-10-05T10:00:00.000Z';
  writeFileSync(L, [{ ts: launch, feature: 'a', event: 'launch', detail: '' }, { ts: '2026-10-05T10:30:00.000Z', feature: 'a', event: 'failed', detail: 'FAILED t', stop: { attempt: 1, counted: true }, failure: 'review' }]
    .map((e) => JSON.stringify(e)).join('\n') + '\n');
  const config = loadConfig(root), base = F({ lastFeedback: 'FAILED timing: too slow', rejected: { sha: 's', tree: 't', inputs: 'i' } as never });
  const inputs = holdInputs(root, config, base);
  const hold = { cause: 'spec-error' as const, confidence: 'high' as const, evidence: ['x'], review: 'a/1', passEnd: '', inputs, ts: '' };
  const proposal = (o: Partial<SpecFixProposal> = {}): SpecFixProposal => ({ id: 'S1', ts: '', status: 'proposed', inputs, review: 'a/1', sha: null, launch, target: 2, old: OLD, new: NEW, why: 'w',
    evidence: draft.evidence, drafter: { model: 'opus' }, verifier: { provider: 'codex', model: 'gpt-6.1-sol', agree: true, reason: 'ok' }, counted: true, ...o });
  const write = (f: Feature, control: object = {}) => {
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [f] }));
    writeFileSync(join(root, '.fact-os/control.json'), JSON.stringify({ paused: false, maxParallel: null, ...control }));
  };
  const read = () => JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')).features[0] as Feature;
  const held = { ...base, planningHold: hold };

  write({ ...held, specFix: proposal() });
  assert.match((await applySpecFix(root, 'a', 'S1', 'auto'))!, /not in auto mode/);
  write({ ...held, specFix: proposal() }, { specFixes: 'auto', profile: 'misspelled-profile' });
  assert.match((await applySpecFix(root, 'a', 'S1', 'auto'))!, /control file is invalid/);
  write({ ...held, specFix: proposal({ verifier: { provider: 'codex', model: 'x', agree: false, reason: 'no' } }) }, { specFixes: 'auto' });
  assert.match((await applySpecFix(root, 'a', 'S1', 'auto'))!, /Codex did not verify/);
  write({ ...held, specFix: proposal({ launch: '2026-10-05T09:00:00.000Z' }) }, { specFixes: 'auto' });
  assert.match((await applySpecFix(root, 'a', 'S1', 'person'))!, /launched again/);
  write({ ...base, specFix: proposal() }, { specFixes: 'auto' }); // the hold it answered was released
  assert.match((await applySpecFix(root, 'a', 'S1', 'person'))!, /hold it answers is gone/);
  write({ ...held, specFix: proposal() }, { specFixes: 'auto' });
  assert.equal(await applySpecFix(root, 'a', 'S1', 'auto', { stopping: () => true }), 'stopping');
  assert.equal(await applySpecFix(root, 'a', 'S1', 'auto'), null);
  let f = read();
  assert.equal(f.acceptance[1], NEW); assert.deepEqual([f.attempts, f.planningHold, f.rejected, f.status, f.specFix!.status, f.specFixes![0]!.by, f.specFixes![0]!.verifier!.model], [0, undefined, undefined, 'todo', 'applied', 'auto', 'gpt-6.1-sol']);
  assert.match(f.lastFeedback!, /^\[This feedback was about the earlier requirements: acceptance item 2 has since been corrected/);
  assert.equal(f.specFixDecisions![inputs], 'applied');
  assert.match(readFileSync(L, 'utf8'), /"event":"acceptance-changed".*applied automatically.*"attemptsReset":true/);
  // Undo names the fix it was shown; another edit to the spec since makes it unavailable.
  assert.match((await undoSpecFix(root, 'a', 'S0'))!, /not the latest/);
  write({ ...read(), description: 'edited since' }); assert.match((await undoSpecFix(root, 'a', 'S1'))!, /spec changed/);
  write({ ...read(), description: base.description, status: 'building' }); assert.match((await undoSpecFix(root, 'a', 'S1'))!, /building/);
  write({ ...read(), status: 'todo', attempts: 2, envFailures: 1 } as Feature);
  assert.equal(await undoSpecFix(root, 'a', 'S1'), null);
  f = read(); assert.deepEqual([f.acceptance[1], f.attempts, !!f.specFixes![0]!.undone, f.envFailures], [OLD, 0, true, undefined]);
  // Dismiss records the decision; a protected proposal is refused automatically but a person may apply it, keeping a pause.
  const risky = { ...held, tier: 'risky' as const };
  write({ ...risky, specFix: proposal({ id: 'S2', inputs: holdInputs(root, config, risky), status: 'proposed' }), planningHold: { ...hold, inputs: holdInputs(root, config, risky) }, specFixes: [] }, { specFixes: 'auto' });
  assert.match((await applySpecFix(root, 'a', 'S2', 'auto'))!, /protected: the feature is risky/);
  assert.equal(await dismissSpecFix(root, 'a', 'S2'), null); assert.equal(read().specFixDecisions![holdInputs(root, config, risky)], 'declined');
  const paused = { ...risky, status: 'paused' as const };
  write({ ...paused, specFix: proposal({ id: 'S3', inputs: holdInputs(root, config, paused) }), planningHold: { ...hold, inputs: holdInputs(root, config, paused) } });
  assert.equal(await applySpecFix(root, 'a', 'S3', 'person'), null); assert.equal(read().status, 'paused');
});

test('specFixPass: a stopping observer applies nothing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-fix-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os'));
  const config = loadConfig(root), f = F(), inputs = holdInputs(root, config, f);
  writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [{ ...f, planningHold: { cause: 'spec-error', confidence: 'high', evidence: ['x'], review: 'a/1', passEnd: '', inputs, ts: '' },
    specFix: { id: 'S1', ts: '', status: 'proposed', inputs, review: 'a/1', sha: null, target: 2, old: OLD, new: NEW, why: 'w', drafter: { model: 'opus' }, verifier: { provider: 'codex', model: 'x', agree: true, reason: 'ok' } } }] }));
  writeFileSync(join(root, '.fact-os/control.json'), JSON.stringify({ paused: false, maxParallel: null, specFixes: 'auto' }));
  await specFixPass(root, config, { model: 'opus' }, null, {}, [], { out: () => {}, children: new Set(), stopping: () => true });
  assert.equal(JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')).features[0].acceptance[1], OLD);
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
  // A decision is remembered by its inputs even after another proposal replaced it; a stuck spec edited since its launch is not drafted.
  a.specFix = { id: 'S9', ts: '', status: 'none', inputs: 'other', review: 'a/1', sha: null, drafter: { model: null } }; a.specFixDecisions = { [ia]: 'declined' };
  const edited = [{ ...events[0]!, inputs: 'what-it-was-launched-with' }, events[1]!];
  assert.deepEqual(candidates(root, config, [a, b, c], byKey, edited).map((x) => x.f.id), []);
});
