import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answer, buildStory, buildOutcome, reviewItems, reviewReasons, withResets, builderText, firstSentence, modelName, queueNote, reasonOf, reviewHeadline, testFailure, transitions, whoOf, type StoryRun } from '../lib/story.ts';
import type { Feature, LogEvent, Verdict } from '../lib/types.ts';

const F = (o: Partial<Feature> = {}): Feature => ({ id: 'a', title: 'Fix the store restore test', description: 'd', acceptance: ['x'], surface: 'any', deps: [], priority: 1,
  status: 'todo', attempts: 0, updatedAt: '2026-10-04T23:59:00Z', ...o });
let clock = Date.parse('2026-10-04T20:00:00Z');
const ev = (event: string, detail = '', o: Partial<LogEvent> = {}): LogEvent => ({ ts: new Date((clock += 60e3)).toISOString(), feature: 'a', event, detail, ...o });
const at = (min: number) => new Date(Date.parse('2026-10-04T20:00:00Z') + min * 60e3).toISOString();
const V = (o: Partial<Verdict>): Verdict => ({ pass: false, findings: [], cheating: [], blocking: [], notes: [], lesson: null, ...o });

test('sentences: Summary lines win, else a clean first sentence, else a pointer; never a code dump', () => {
  assert.equal(builderText('Summary: Renamed the evidence logs so they are committed.\n\nDetails…'), 'Renamed the evidence logs so they are committed.');
  assert.equal(builderText('The fixture now passes. More text.'), 'Builder reported: The fixture now passes.');
  assert.equal(builderText('```diff\n+x\n```'), 'Builder finished; its output is in the logs.');
  assert.equal(firstSentence('{"pass": true}'), null);
  assert.equal(buildOutcome('fix', { files: 1 }, undefined), 'Fixed: 1 file changed.');
  assert.equal(buildOutcome('resolve', undefined, 'abcdef1234'), 'Combined the changes: commit abcdef1.');
  assert.equal(reasonOf('FAILED x: y\nBLOCKING: Saved partial claims cannot be read. More.'), 'Saved partial claims cannot be read');
  assert.equal(reasonOf('The merge resolution lost lines that one side added.'), 'the merge lost lines one side added');
  assert.equal(reasonOf('test command `gate` exited 1:\nFAIL src/orders/tenant.test.ts > isolation\nAssertionError: expected 403'), 'checks failed in tenant.test.ts');
  assert.equal(reasonOf('test command `gate` exited 1:\nok\n\n[diagnosis]\nDiagnosis (x): code: ECONNREFUSED\nSuggested fix: y\n[/diagnosis]'), 'the checks failed', 'a diagnosis note is not evidence');
  assert.deepEqual(testFailure('FAIL src/a/b.test.ts > c\nError: timed out waiting'), { file: 'b.test.ts', error: 'Error: timed out waiting' });
});

test('reviewHeadline: a rejection comes from its structured reasons (never the evaluator\'s prose); a pass counts its checks', () => {
  assert.equal(reviewHeadline(V({ pass: true, findings: [{ check: 'a', ok: true, evidence: 'e' }, { check: 'b', ok: true, evidence: 'e' }] })), 'Passed all 2 checks.');
  assert.equal(reviewHeadline(V({ summary: 'Evidence logs are missing from the commit.', blocking: ['The README alone was committed.'] })), 'The README alone was committed.');
  assert.equal(reviewHeadline(V({ blocking: ['Required evidence is absent from the commit. Details.', 'Second.'], findings: [{ check: 'c', ok: false, evidence: 'e' }] })), 'Required evidence is absent from the commit (+2 more).');
});

test('buildStory: a review fix inside one try, then a merge — steps, artifacts and the outcome come from events, sentences from artifacts', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const events = [ev('launch'), ev('testing', 'sha1'), ev('evaluating'), ev('review-fix', 'resuming'), ev('refreshed', 'before test, conflict-free'), ev('testing', 'sha2'), ev('evaluating'), ev('merged', 'task/a')];
  const runs: StoryRun[] = [
    { tag: '1', role: 'build', at: at(1.5), text: 'Summary: Made the queue exist before publishing.' },
    { tag: '1', role: 'eval', at: at(3.5), text: '', verdict: V({ blocking: ['The evidence logs are not committed.'], findings: [{ check: 'evidence', ok: false, evidence: 'only README' }] }) },
    { tag: '1.2', role: 'build', at: at(4.5), text: 'Renamed the logs to .txt and committed them.' },
    { tag: '1.3', role: 'eval', at: at(7.5), text: '', verdict: V({ pass: true, findings: [{ check: 'evidence', ok: true, evidence: 'ok' }] }) },
  ];
  const s = buildStory({ feature: F({ status: 'merged' }), events, runs, maxAttempts: 3, base: 'main' });
  assert.equal(s.state.word, 'Merged'); assert.equal(s.state.why, 'Merged into main after a same-session fix.');
  assert.deepEqual(s.current!.steps.map((x) => [x.label, x.state]), [['Build', 'done'], ['Test', 'done'], ['Review', 'needs-changes'], ['Fix', 'done'], ['Test again', 'done'], ['Review again', 'done'], ['Merge', 'done']]);
  assert.equal(s.current!.steps[0]!.text, 'Built; no file list or commit was recorded.', 'never the agent\'s own words');
  assert.equal(s.current!.steps[0]!.said, 'Summary: Made the queue exist before publishing.', 'kept for the expand control');
  assert.match(s.current!.steps[2]!.text, /^Needs changes: The evidence logs are not committed/);
  assert.equal(s.current!.steps[2]!.reasons!.length, 2);
  assert.equal(s.current!.steps[3]!.text, 'Fixed; no file list or commit was recorded.');
  assert.equal(s.current!.steps[3]!.said, 'Renamed the logs to .txt and committed them.');
  assert.equal(s.current!.steps[4]!.note, 'Updated from main first.');
  assert.equal(s.current!.steps[5]!.text, 'Passed all 1 checks.');
  assert.equal(s.needsYou, null);
});

test('buildStory: a counted review rejection ends the try and queues the next; the problem shows the review reasons, not the "try ended" line', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const events = [ev('launch'), ev('testing', 's'), ev('evaluating'), ev('failed', 'BLOCKING: Incomplete records are counted.', { stop: { attempt: 1, counted: true } })];
  const runs: StoryRun[] = [{ tag: '1', role: 'eval', at: at(3.5), text: '', verdict: V({ blocking: ['Incomplete records are counted.'] }) }];
  const s = buildStory({ feature: F({ status: 'todo', attempts: 1, lastFeedback: 'BLOCKING: Incomplete records are counted.' }), events, runs, maxAttempts: 3, base: 'main' });
  assert.equal(s.state.word, 'Queued for try 2 of 3'); assert.equal(s.nextTry, 2);
  assert.equal(s.state.why, 'Review rejected: Incomplete records are counted.');
  assert.equal(s.current!.steps.at(-1)!.label, 'Try ended');
  assert.match(s.problems.active!.title, /^Rejected: Incomplete records are counted/);
});

test('buildStory: environment stops and base-defect holds spend no try; a gate failure names its test; a reset archives older tries', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const events = [ev('launch'), ev('failed', 'prepare `x` exited 1', { stop: { attempt: 1, counted: true } }),
    ev('acceptance-changed', 'by a person'), ev('retrying', 'by a person', { attemptsReset: true }),
    ev('launch'), ev('testing', 's'), ev('env-rerun', 'environment fault', { test: { code: 1, file: 'process-webhook.db.test.ts', error: 'Error: timed out waiting for the receipt to settle' } }),
    ev('testing', 's'), ev('failed', 'test command `g` exited 1:\nFAIL x.test.ts', { cause: 'environment', stop: { attempt: 1, counted: false } })];
  const s = buildStory({ feature: F({ status: 'todo', envRetryAt: new Date(Date.now() + 60e3).toISOString() }), events, runs: [], maxAttempts: 3, base: 'main' });
  assert.equal(s.state.word, 'Waiting to retry');
  const steps = s.current!.steps.map((x) => [x.label, x.state, x.text]);
  assert.deepEqual(steps[1], ['Test', 'failed', 'Checks failed in process-webhook.db.test.ts: Error: timed out waiting for the receipt to settle.']);
  assert.equal(s.current!.steps[2]!.note, 'Same code, after a diagnosed environment fault.');
  assert.match(String(steps.at(-1)![2]), /no retry used/);
  assert.equal(s.archive.length, 1); assert.equal(s.archive[0]!.label, 'Earlier work (before the spec was edited): 1 try');

  clock = Date.parse('2026-10-04T20:00:00Z');
  const held = buildStory({ feature: F({ status: 'todo', planningHold: { cause: 'base-defect', confidence: 'high', evidence: ['gate: Queue x does not exist'], review: 'a/1', passEnd: '', inputs: '', ts: '' } }),
    events: [ev('launch'), ev('testing', 's'), ev('evaluating'), ev('failed', 'BASE DEFECT …', { cause: 'base-defect', stop: { attempt: 1, counted: false } })], runs: [], maxAttempts: 3, base: 'main' });
  assert.equal(held.state.word, 'On hold'); assert.equal(held.needsYou, null, 'a base defect is not the person\'s action');
  assert.equal(held.current!.outcome, 'held');
});

test('buildStory: a spec hold and a stuck feature say what the person should do; an unmet dependency names it', () => {
  const hold = buildStory({ feature: F({ planningHold: { cause: 'spec-error', confidence: 'high', evidence: ['the document lists every table unchanged'], review: 'a/1', passEnd: '', inputs: '', ts: '' } }), events: [], runs: [], maxAttempts: 3, base: 'main' });
  assert.equal(hold.needsYou!.what, 'Clarify the conflicting requirement');
  const stuck = buildStory({ feature: F({ status: 'stuck', attempts: 3, lastFeedback: 'BLOCKING: Duplicated helper.' }), events: [], runs: [], maxAttempts: 3, base: 'main' });
  assert.equal(stuck.needsYou!.what, 'Retry it, or change the spec');
  const dep = buildStory({ feature: F(), events: [], runs: [], maxAttempts: 3, base: 'main', unmetDeps: [{ id: 'b', title: 'Store restore test' }] });
  assert.equal(dep.state.why, 'Waiting on Store restore test to merge first.');
  assert.equal(buildStory({ feature: F({ goal: 'Make restores work.', shortTitle: 'Restore test' }), events: [], runs: [], maxAttempts: 3, base: 'main' }).title, 'Restore test');
});

test('transitions: one line per meaningful change, newest first, with where the feature went', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const evs = [ev('launch'), ev('review-fix', 'r'), ev('failed', 'BLOCKING: Incomplete records are counted.', { stop: { attempt: 1, counted: true } }), { ...ev('launch'), feature: 'b' }, { ...ev('merged', ''), feature: 'b' }];
  const t = transitions(evs, { a: 'Timing pairs', b: 'Producer queue' }, 3, 'main');
  assert.deepEqual(t.map((x) => [x.id, x.badge]), [['b', 'Merged'], ['b', 'Running'], ['a', 'Queued · try 2 of 3'], ['a', 'Fixing'], ['a', 'Running']]);
  assert.equal(t[2]!.text, 'Try 1 ended: Incomplete records are counted. Queued for try 2.');
});

test('queueNote: why a todo feature is waiting, in one line', () => {
  assert.equal(queueNote(F({ attempts: 1, lastFeedback: 'BLOCKING: Incomplete records are counted.' }), 3, 'main', []), 'Queued for try 2 of 3 · Incomplete records are counted.');
  assert.equal(queueNote(F(), 3, 'main', [{ title: 'Restore test' }]), 'Waiting on Restore test to merge first.');
  assert.equal(queueNote(F(), 3, 'main', []), null);
  assert.equal(queueNote(F({ status: 'building' }), 3, 'main', []), null);
});

test('buildStory: a failure logged outside any recorded try is kept under earlier problems, not dropped', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const s = buildStory({ feature: F({ status: 'stuck', attempts: 1 }), events: [ev('stuck', 'merge conflict with main: too many base refreshes (5)')], runs: [], maxAttempts: 3, base: 'main' });
  assert.match(s.problems.earlier[0]!.text, /^A failure whose try was not recorded: merge conflicts kept coming back/);
});

test('review fixes: a passing review stays passed when merging stops; a later repair\'s output is not the Build\'s; a ready feature merges; an uncounted hold resumes the same try; a contradicting summary is ignored; a requeue is explained', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const pass = V({ pass: true, findings: [{ check: 'a', ok: true, evidence: 'e' }] });
  const s1 = buildStory({ feature: F({ status: 'stuck', attempts: 1 }), events: [ev('launch'), ev('testing', 's'), ev('evaluating'), ev('stuck', 'merge conflict with main: too many base refreshes (10)', { stop: { attempt: 1, counted: true } })],
    runs: [{ tag: '1', role: 'eval', at: at(3.5), text: '', verdict: pass }], maxAttempts: 3, base: 'main' });
  assert.deepEqual(s1.current!.steps.slice(2, 4).map((x) => [x.label, x.state]), [['Review', 'done'], ['Merge', 'failed']]);
  assert.match(s1.current!.summary, /^Merging stopped: merge conflicts kept coming back/);

  clock = Date.parse('2026-10-04T20:00:00Z');
  const s2 = buildStory({ feature: F({ status: 'testing' }), events: [ev('launch'), ev('commit-fix', 'resuming'), ev('testing', 's')],
    runs: [{ tag: '1', role: 'build', at: at(1.9), text: 'The gate is still running; nothing committed.' }, { tag: '1.2', role: 'build', at: at(2.5), text: 'The work is committed and clean.' }], maxAttempts: 3, base: 'main' });
  assert.equal(s2.current!.steps[0]!.said, 'The gate is still running; nothing committed.');

  clock = Date.parse('2026-10-04T20:00:00Z');
  const s3 = buildStory({ feature: F({ status: 'merged' }), events: [ev('launch'), ev('testing', 's'), ev('evaluating'), ev('ready', 'b'), ev('merged', '')], runs: [], maxAttempts: 3, base: 'main' });
  assert.equal(s3.current!.outcome, 'merged'); assert.equal(s3.current!.steps.at(-1)!.label, 'Merge');
  const s3b = buildStory({ feature: F({ status: 'merged' }), events: [ev('launch'), ev('failed', 'prepare `x` exited 1', { stop: { attempt: 1, counted: false } }), ev('stuck', 'prepare', { stop: { attempt: 1, counted: false } }), ev('merged', 'external')], runs: [], maxAttempts: 3, base: 'main' });
  assert.match(s3b.state.why!, /outside a factory try/);

  clock = Date.parse('2026-10-04T20:00:00Z');
  const s4 = buildStory({ feature: F({ status: 'testing' }), events: [ev('launch'), ev('testing', 's'), ev('evaluating'), ev('failed', 'BASE', { cause: 'base-defect', stop: { attempt: 1, counted: false } }), ev('planning-hold-released', 'recheck'), ev('launch'), ev('testing', 's')], runs: [], maxAttempts: 3, base: 'main' });
  assert.equal(s4.current!.n, 1, 'no retry was spent');

  assert.equal(reviewHeadline(V({ error: 'pass:true contradicted', summary: 'All checks passed; the feature is ready to merge.', blocking: ['Cross-tenant leak.'] })), 'Cross-tenant leak.');

  clock = Date.parse('2026-10-04T20:00:00Z');
  const s5 = buildStory({ feature: F({ status: 'todo' }), events: [ev('launch'), ev('testing', 's'), ev('gate-fix', 'r'), ev('refresh-skipped', 'config.json changed on disk during the run; back to todo')], runs: [], maxAttempts: 3, base: 'main' });
  assert.match(s5.state.why!, /factory settings changed during the run/);
  const t = transitions([ev('launch'), ev('refresh-skipped', 'config.json changed on disk during the run; back to todo')], { a: 'A' }, 3, 'main');
  assert.equal(t[0]!.badge, 'Queued'); assert.match(t[0]!.text, /no retry used/);
});

test('recheck fixes: an interruption keeps the try (stop.attempt wins); a rejection never takes a success-sounding summary; output written after a step ends is not its own', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const evs = [ev('launch'), ev('failed', 'BLOCKING: x', { stop: { attempt: 1, counted: true } }), ev('launch'), ev('interrupted'), ev('launch'), ev('failed', 'BLOCKING: Duplicated helper.', { stop: { attempt: 2, counted: true } })];
  const t = transitions(evs, { a: 'A' }, 3, 'main');
  assert.equal(t[0]!.badge, 'Queued · try 3 of 3'); assert.match(t[0]!.text, /^Try 2 ended/);
  const s = buildStory({ feature: F({ status: 'todo', attempts: 2, lastFeedback: 'BLOCKING: Duplicated helper.' }), events: evs, runs: [], maxAttempts: 3, base: 'main' });
  assert.equal(s.state.word, 'Queued for try 3 of 3');
  assert.equal(reviewHeadline(V({ summary: 'All checks passed.', blocking: ['A cross-tenant leak.'], findings: [{ check: 'tenant isolation', ok: false, evidence: 'e' }] })), 'A cross-tenant leak (+1 more).');
  clock = Date.parse('2026-10-04T20:00:00Z');
  const s2 = buildStory({ feature: F({ status: 'testing' }), events: [ev('launch'), ev('commit-fix', 'r'), ev('testing', 's')],
    runs: [{ tag: '1.2', role: 'build', at: new Date(Date.parse(at(2)) + 2e3).toISOString(), text: 'The work is committed and clean.' }], maxAttempts: 3, base: 'main' });
  assert.equal(s2.current!.steps[0]!.text, 'Built; no build record was found for this step.'); assert.equal(s2.current!.steps[0]!.said, undefined);
});

test('transitions: a base-defect hold and its release keep the same try in the feed', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const t = transitions([ev('launch'), ev('failed', 'BASE', { cause: 'base-defect', stop: { attempt: 1, counted: false } }), ev('planning-hold-released', 'recheck'), ev('launch')], { a: 'A' }, 3, 'main');
  assert.ok(!t.some((x) => /Started try 2/.test(x.text)));
  assert.equal(t[0]!.text, 'Resumed try 1.');
});

test('who ran each step: the run record names the model and effort; older fingerprints still work; a fallback and a resumed session are said', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const run = (role: string, model: string, effort: string, o = {}) => ({ run: { phase: 'build' as const, tag: '1', role, provider: 'claude', model, effort, tier: null, resumed: false, promptBytes: 10, ...o } });
  const events = [ev('launch'), ev('prompt', 'builder model=sonnet effort=high', run('builder', 'sonnet', 'high')), ev('testing', 'sha1'), ev('evaluating'),
    ev('prompt', 'evaluator model=gpt-6.1-sol effort=xhigh'), ev('review-fix', 'resuming'), ev('prompt', 'builder', run('builder', 'opus', 'high', { resumed: true, fallback: true })),
    ev('testing', 'sha2'), ev('evaluating'), ev('merged', 'task/a')];
  const s = buildStory({ feature: F({ status: 'merged' }), events, runs: [], maxAttempts: 3, base: 'main' });
  assert.deepEqual(s.current!.steps.map((x) => x.who ?? null), ['Built by Sonnet · high', null, 'Reviewed by GPT-6.1 Sol · xhigh', 'Built by Opus · high (fallback, same session)', null, null, null]);
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5'); assert.equal(modelName(null), 'an unrecorded model');
});

test('a fallback diagnosis names the model that actually diagnosed', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const d = (model: string, o = {}) => ({ run: { phase: 'diagnose' as const, tag: '1', role: 'diagnoser', provider: 'claude', model, effort: 'high', tier: null, resumed: false, promptBytes: 1, ...o } });
  const events = [ev('launch'), ev('testing', 'sha1'), ev('prompt', 'diagnoser model=gpt-6.1-sol effort=high', d('gpt-6.1-sol', { provider: 'codex' })), ev('codex-fallback', 'codex unavailable; opus high instead'),
    ev('prompt', 'diagnoser model=opus effort=high', d('opus', { fallback: true })), ev('diagnosis', 'code: the test asserts the old shape')];
  const s = buildStory({ feature: F({ status: 'testing' }), events, runs: [], maxAttempts: 3, base: 'main' });
  assert.equal(s.current!.steps.find((x) => x.kind === 'diagnose')!.who, 'Diagnosed by Opus · high (fallback)');
});

test('spec fixes: a waiting proposal is what the person must do; applied fixes are listed and only the latest unchanged one can be undone', () => {
  clock = Date.parse('2026-10-04T20:00:00Z');
  const hold = { cause: 'spec-error' as const, confidence: 'high' as const, evidence: ['needs 6 minutes'], review: 'a/1', passEnd: '', inputs: 'h', ts: '' };
  const fix = { id: 'S1', ts: '', status: 'proposed' as const, inputs: 'h', review: 'a/1', sha: null, target: 1, old: 'x', new: 'y', why: 'w', drafter: { model: 'opus' }, protectedBy: 'the feature is risky' };
  const s = buildStory({ feature: F({ planningHold: hold, specFix: fix, attempts: 1 }), events: [ev('launch'), ev('failed', 'FAILED t: e', { stop: { attempt: 1, counted: true } })], runs: [], maxAttempts: 3, base: 'main', specFixMode: 'auto' });
  assert.equal(s.needsYou!.what, 'Review the proposed spec fix'); assert.match(s.state.next!, /Review the proposed spec fix below/);
  assert.deepEqual([s.specFix!.id, s.specFix!.protectedBy, s.specFix!.mode], ['S1', 'the feature is risky', 'auto']);
  assert.equal(queueNote(F({ planningHold: hold, specFix: fix }), 3, 'main', []), 'Waiting for you: a proposed spec fix.');
  const rec = (id: string, o = {}) => ({ id, ts: '', by: 'auto' as const, target: 1, old: 'x', new: 'y', why: 'w', ...o });
  const t = buildStory({ feature: F({ acceptance: ['y'], specFixes: [rec('S0', { undone: 't' }), rec('S1')] }), events: [], runs: [], maxAttempts: 3, base: 'main' });
  assert.deepEqual(t.fixes.map((x) => [x.id, x.undoable]), [['S0', false], ['S1', true]]); assert.equal(t.specFix, null);
  assert.equal(buildStory({ feature: F({ acceptance: ['edited'], specFixes: [rec('S1')] }), events: [], runs: [], maxAttempts: 3, base: 'main' }).fixes[0]!.undoable, false);
  const feed = transitions([ev('spec-fix-proposed', 'S1: acceptance item 1: "x" → "y"; Codex agrees'), ev('spec-fix-applied', 'S1 auto: acceptance item 1: "x" → "y"')], { a: 'A' }, 3, 'main', 10);
  assert.deepEqual(feed.map((x) => [x.badge, x.needsYou]), [['Spec fixed', false], ['Spec fix · needs you', true]]);
  assert.match(feed[0]!.text, /^Spec fixed automatically: acceptance item 1/);
});

test('the planner row comes before the Build row it planned for, names the planner, and says its effort is a recommendation for the builder', () => {
  // F99-47 (ecommerce-builder): a setup failure, a relaunch, the planner (Opus high), then the builder (Opus medium), still building.
  const t = (s: string) => `2026-10-05T${s}Z`;
  const run = (phase: 'plan' | 'build', role: string, model: string, effort: string) => ({ run: { phase, tag: '1', role, provider: 'claude', model, effort, tier: null, resumed: false, promptBytes: 10 } });
  const E = (ts: string, event: string, detail = '', o: Partial<LogEvent> = {}): LogEvent => ({ ts: t(ts), feature: 'a', event, detail, ...o });
  const events = [E('20:13:01.234', 'launch'), E('20:13:01.629', 'failed', 'prepare `p` exited 1: (setup failure 1 of 3; no attempt spent)', { stop: { attempt: 1, counted: false } }),
    E('20:14:02.081', 'launch'), E('20:14:26.191', 'prompt', 'planner model=opus effort=high', run('plan', 'planner', 'opus', 'high')),
    E('20:15:31.787', 'planned', 'FEASIBLE, effort medium', run('plan', 'planner', 'opus', 'high')),
    E('20:15:31.933', 'prompt', 'builder model=opus effort=medium', run('build', 'builder', 'opus', 'medium'))];
  const s = buildStory({ feature: F({ status: 'building', updatedAt: t('20:16:00') }), events, runs: [], maxAttempts: 3, base: 'main' });
  const steps = s.current!.steps;
  assert.deepEqual(steps.map((x) => x.label), ['Build', 'Stopped', 'Resumed', 'Planned', 'Build']);
  const [plan, build] = [steps[3]!, steps[4]!];
  assert.deepEqual([plan.who, build.who, build.state], ['Planned by Opus · high', 'Built by Opus · medium', 'running']);
  assert.match(plan.text, /recommends builder effort medium\.$/);
  assert.deepEqual([plan.start, plan.end, build.start], [t('20:14:26.191'), t('20:15:31.787'), t('20:15:31.787')]);
  const starts = steps.map((x) => Date.parse(x.start!)); assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  // An older planned event without a run record takes the planner's prompt; with neither, nothing is guessed.
  const old = buildStory({ feature: F({ status: 'building' }), events: [E('20:14:02', 'launch'), E('20:15:31', 'planned', 'FEASIBLE, effort high; split suggested: two parts')], runs: [], maxAttempts: 3, base: 'main' });
  assert.equal(old.current!.steps[0]!.label, 'Planned'); assert.equal(old.current!.steps[0]!.who, undefined);
  assert.match(old.current!.steps[0]!.text, /recommends builder effort high; it suggests splitting the feature: two parts\.$/);
});

test('a Codex reviewer is named as Codex', () => {
  const r = { phase: 'review' as const, tag: '1', role: 'evaluator', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', tier: null, resumed: false, promptBytes: 1 };
  assert.equal(whoOf({ ts: '', feature: 'a', event: 'prompt', detail: '', run: r })!.who, 'Codex GPT-6.1 Sol · high');
});

// F99-17 (ecommerce-builder, 2026-10-05): two tries, an interruption, a planner hold, then the spec was edited by hand and
// its tries reset to 0 without a log event; the re-plan and an Opus build followed.
const F99_17 = (): LogEvent[] => readFileSync(new URL('./fixtures/story-f99-17.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const F99_RUNS: StoryRun[] = [
  { tag: '2', role: 'build', at: '2026-10-05T15:32:10.000Z', text: 'This is the last of the leftover gate-polling commands finishing, and it changes nothing.', files: 9, unsure: ['a', 'b'] },
  { tag: '1.2', role: 'build', at: '2026-10-05T23:36:00.000Z', text: 'This is the last of the leftover gate-polling commands finishing.', files: 12, unsure: ['x'] },
];

test('F99-17: after an unlogged spec edit the current try starts at the re-plan; the earlier tries are grouped as earlier work; rows are in time order', () => {
  const s = buildStory({ feature: F({ status: 'testing', attempts: 0, updatedAt: '2026-10-05T23:40:00Z' }), events: F99_17(), runs: F99_RUNS, maxAttempts: 3, base: 'main' });
  const cur = s.current!;
  assert.equal(cur.n, 1); assert.equal(s.version, 'testing|0');
  assert.deepEqual(cur.steps.map((x) => [x.label, x.state]), [['Planned', 'info'], ['Build', 'done'], ['Test', 'running']]);
  assert.equal(cur.steps[0]!.who, 'Planned by Opus · high'); assert.equal(cur.steps[1]!.who, 'Built by Opus · medium');
  assert.equal(cur.steps[1]!.text, 'Built: 12 files changed, commit ec0ed62. It flagged 1 open point.');
  assert.match(cur.steps[1]!.said!, /^This is the last of the leftover gate-polling/); assert.match(cur.steps[1]!.said!, /Unsure:\n- x$/);
  assert.equal(s.earlier.length, 0);
  assert.deepEqual(s.archive.map((a) => a.label), ['Earlier work (before the spec was edited): 2 tries']);
  const [t2, t1] = s.archive[0]!.tries;
  assert.deepEqual(t2!.steps.map((x) => x.label), ['Build', 'Test', 'Review', 'Fix', 'Test again', 'Sent back', 'Resumed', 'On hold'], 'the planner held it before any builder: no Build row');
  assert.equal(t2!.summary, 'Ended when the spec was edited.');
  assert.equal(t2!.steps[0]!.text, 'Built: 9 files changed, commit 7e35f76. It flagged 2 open points.');
  assert.equal(t1!.outcome, 'failed');
  for (const t of [cur, t2!, t1!]) { const at = t.steps.map((x) => Date.parse(x.start!)); assert.deepEqual(at, [...at].sort((a, b) => a - b)); }
  for (const t of [cur, t2!]) for (const x of t.steps) assert.doesNotMatch(x.text, /leftover gate-polling/, 'the agent\'s chat message is never a row');
  // The feed agrees: try 1 starts again after the reset.
  assert.equal(transitions(F99_17(), { a: 'A' }, 3, 'main', 1)[0]!.text, 'Started try 1.');
});

test('a logged spec edit (acceptance-changed) also closes the earlier work, and the re-plan still goes before its Build; normal tags insert no reset', () => {
  const t = (s: string) => `2026-10-05T${s}Z`;
  const run = (phase: 'plan' | 'build', role: string, tag: string) => ({ run: { phase, tag, role, provider: 'claude', model: 'opus', effort: 'high', tier: null, resumed: false, promptBytes: 1 } });
  const E = (ts: string, event: string, detail = '', o: Partial<LogEvent> = {}): LogEvent => ({ ts: t(ts), feature: 'a', event, detail, ...o });
  const events = [E('10:00:00', 'launch'), E('10:00:05', 'prompt', '', run('build', 'builder', '1')), E('10:05:00', 'failed', 'BLOCKING: x', { stop: { attempt: 1, counted: true } }),
    E('11:00:00', 'acceptance-changed', 'spec fix S1 applied by a person', { attemptsReset: true }),
    E('11:01:00', 'launch'), E('11:01:04', 'prompt', '', run('plan', 'planner', '1')), E('11:03:00', 'planned', 'FEASIBLE, effort low', run('plan', 'planner', '1')),
    E('11:03:01', 'prompt', '', run('build', 'builder', '1'))];
  const s = buildStory({ feature: F({ status: 'building' }), events, runs: [], maxAttempts: 3, base: 'main' });
  assert.deepEqual(s.current!.steps.map((x) => x.label), ['Planned', 'Build']);
  assert.equal(s.archive[0]!.label, 'Earlier work (before the spec was edited): 1 try');
  const normal = [E('10:00:00', 'launch'), E('10:00:05', 'prompt', '', run('build', 'builder', '1')), E('10:05:00', 'failed', 'x', { stop: { attempt: 1, counted: true } }),
    E('10:06:00', 'launch'), E('10:06:05', 'prompt', '', run('build', 'builder', '2')), E('10:07:00', 'interrupted'), E('10:08:00', 'launch'), E('10:08:05', 'prompt', '', run('build', 'builder', '2.2'))];
  assert.equal(withResets(normal).length, normal.length);
  assert.equal(withResets([...normal, E('10:09:00', 'launch', '', { inputs: 'b' }), E('10:09:05', 'prompt', '', run('build', 'builder', '1.2'))]).filter((e) => e.event === 'attempts-reset').length, 1);
});

test('review answers: reasons in the fix prompt\'s order get each answer by key (or by number), and the fix row counts them', () => {
  const v = V({ findings: [{ check: 'c1', ok: false, evidence: 'e1' }, { check: 'ok', ok: true, evidence: '' }], blocking: ['b1'], cheating: ['x1'] });
  assert.deepEqual(reviewItems(v).map((i) => i.key), ['blocking:b1', 'cheating:x1', 'failed:c1']);
  const rs = reviewReasons(v);
  assert.deepEqual(rs.map((r) => r.key), ['blocking:b1', 'cheating:x1', 'failed:c1']);
  const a = answer(rs, [{ finding: 9, status: 'fixed', how: 'h', where: 'w', key: 'failed:c1' }, { finding: 1, status: 'cannot', how: 'spec conflict', where: '', key: 'blocking:b1' }]);
  assert.deepEqual(rs.map((r) => r.handled?.status ?? null), ['cannot', null, 'fixed'], 'matched by key, whatever the number');
  assert.equal(buildOutcome('fix', { files: 2 }, 'abcdef1234', a), '1 fixed, 0 disputed, 1 cannot, 1 not answered (2 files changed, commit abcdef1).');
  const rs2 = reviewReasons(v); answer(rs2, [{ finding: 2, status: 'disputed', how: 'h', where: '' }]);
  assert.deepEqual(rs2.map((r) => r.handled?.status ?? null), [null, 'disputed', null], 'no keys: matched by number');
  assert.equal(buildOutcome('fix', undefined, 'abcdef1234', { responses: [], findings: 3 }), 'No answers to the review findings were recorded (commit abcdef1).');
});
