import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passKind, passesOf, nextResult, selectPasses, parseFingerprint, promptFile, parseReview, eligible, promptRates, trend, promptSummary, renderPromptSection, reviewPrompt, reviewBudget, reviewTimeoutMin,
  type Pass, type PromptReview } from '../lib/promptreview.ts';
import { mergeNotes, fitNotes, parseNotes, noteBullet, notesBlock, notesHash, notesFile, readNotes, overCap } from '../lib/notes.ts';
import { promptFingerprint, builderPrompt } from '../lib/foreman.ts';
import { agentStats, versionKey } from '../lib/observe.ts';
import { DEFAULT_CONFIG } from '../lib/state.ts';
import type { Cause, Feature } from '../lib/types.ts';

const T0 = Date.parse('2026-10-01T10:00:00Z'), at = (min: number) => new Date(T0 + min * 60e3).toISOString();
const e = (min: number, feature: string, event: string, detail = '') => ({ ts: at(min), feature, event, detail });
const B = (notes = '') => `builder model=sonnet effort=medium lessons=aaaaaaaa briefs=-${notes ? ` notes=${notes}` : ''} profile=fable-sonnet`;
const EV = 'evaluator model=fable effort=high lessons=- briefs=-';
const RES = 'resolver model=sonnet effort=high lessons=- briefs=-';
const own: (f: string, d: string) => Cause = (_f, d) => (/FAIL a\.test\.ts|^FAILED /.test(d) ? 'own' : /exited/.test(d) ? 'untouched' : 'unknown'); // a stand-in for the observer's classify

test('passKind: what a prompt review is for, and what it is not', () => {
  assert.equal(passKind('FAILED check 1: missing route', 'failed', 'own'), 'evaluator-rejected');
  assert.equal(passKind('BLOCKING: money bug', 'stuck', 'unknown'), 'evaluator-rejected');
  assert.equal(passKind('Evaluator: evaluator output is not a JSON object', 'failed', 'own'), 'evaluator-run-failed');
  assert.equal(passKind('test command `g` exited 1:\nFAIL a.test.ts', 'failed', 'own'), 'gate-failed');
  assert.equal(passKind('test command `g` exited 1:\nFAIL a.test.ts', 'failed', 'untouched'), null, 'a test the feature does not change is not its prompt');
  assert.equal(passKind('test command `g` exited 1:\nout of shared memory', 'failed', 'infra'), null);
  assert.equal(passKind('The merge resolution lost lines that one side added. Put them back', 'failed', 'unknown'), 'keep-check');
  assert.equal(passKind('the resolver failed: x', 'resolve-failed', 'unknown'), 'resolver-failed');
  assert.equal(passKind('keep-check: 3 lines lost', 'resolve-failed', 'unknown'), 'keep-check', 'the resolver run\'s own keep-lines check');
  assert.equal(passKind('commit your work: no commits', 'failed', 'builder'), 'builder-failed');
  assert.equal(passKind('builder failed: timed out', 'failed', 'builder'), 'builder-failed');
  assert.equal(passKind('builder failed: exit 1: npm ERR!\nFAILED to install x', 'failed', 'builder'), 'builder-failed', 'stderr with a line starting FAILED is not an evaluator rejection');
  assert.equal(passKind('prepare `p` exited 1', 'failed', 'setup'), null);
  assert.equal(passKind('merge conflict with main: too many base refreshes (5)', 'stuck', 'conflict-loop'), null);
});

test('passesOf cuts the log into passes and sorts each one: bad (reviewable), ok, or other', () => {
  const events = [
    // a: the evaluator rejects, then the next pass merges
    e(0, 'a', 'launch'), e(0, 'a', 'prompt', B()), e(1, 'a', 'testing', 's'), e(2, 'a', 'evaluating'), e(2, 'a', 'prompt', EV), e(5, 'a', 'failed', 'FAILED check 1: missing route'),
    e(6, 'a', 'launch'), e(6, 'a', 'prompt', B('n1')), e(7, 'a', 'refreshed', 'before test, conflict-free'), e(8, 'a', 'testing', 's'), e(9, 'a', 'evaluating'), e(9, 'a', 'prompt', EV), e(12, 'a', 'merged', 'ship/a'),
    // b: its own tests fail in the gate; c: a test it does not change; d: infrastructure
    e(0, 'b', 'launch'), e(0, 'b', 'prompt', B()), e(3, 'b', 'testing', 's'), e(8, 'b', 'failed', 'test command `g` exited 1:\n FAIL a.test.ts'),
    e(0, 'c', 'launch'), e(0, 'c', 'prompt', B()), e(3, 'c', 'testing', 's'), e(8, 'c', 'failed', 'test command `g` exited 1:\nwhatever'),
    // e: a conflict a resolver takes over does not end the pass; the resolver fails
    e(0, 'e', 'launch'), e(0, 'e', 'prompt', B()), e(1, 'e', 'testing', 's'), e(2, 'e', 'evaluating'), e(3, 'e', 'refreshed', 'conflicts in: x.ts'), e(3, 'e', 'resolving', 'x.ts'),
    e(3, 'e', 'prompt', RES), e(6, 'e', 'resolve-failed', 'the resolver failed: exit 1'),
    // f: no builder prompt (the build was skipped); g: passed evaluation then bounced by a conflict; h: before the window
    e(0, 'f', 'launch'), e(1, 'f', 'failed', 'builder failed: timed out'),
    e(0, 'k', 'launch'), e(0, 'k', 'prompt', B()), e(1, 'k', 'refreshed', 'conflicts in: x.ts'), e(1, 'k', 'resolving', 'x.ts'), e(1, 'k', 'prompt', RES), e(2, 'k', 'resolve-failed', 'keep-check: 3 lines lost'),
    e(0, 'm', 'launch'), e(0, 'm', 'prompt', B()), e(1, 'm', 'merge-hook-failed', 'mergeHook exited 1'),
    e(0, 'g', 'launch'), e(0, 'g', 'prompt', B()), e(1, 'g', 'testing', 's'), e(2, 'g', 'evaluating'), e(4, 'g', 'refreshed', 'conflicts in: y.ts'),
    e(-5000, 'h', 'launch'), e(-5000, 'h', 'prompt', B()), e(-4990, 'h', 'failed', 'FAILED x'),
    e(20, 'z', 'prompt', B()), e(21, 'z', 'failed', 'FAILED a pass that never started'),
  ];
  const passes = passesOf(events, own, T0 - 3600e3);
  const sum = passes.map((p) => `${p.feature}:${p.outcome}${p.kind ? `:${p.kind}:${p.role}` : ''}`).sort();
  assert.deepEqual(sum, ['a:bad:evaluator-rejected:builder', 'a:ok', 'b:bad:gate-failed:builder', 'c:other', 'e:bad:resolver-failed:resolver', 'f:other', 'g:ok', 'k:bad:keep-check:resolver', 'm:other']);
  const e1 = passes.find((p) => p.feature === 'e')!;
  assert.deepEqual(e1.prompts.map((p) => p.role), ['builder', 'resolver'], 'the resolver run belongs to the pass that hit the conflict');
  assert.equal(passes.find((p) => p.feature === 'a' && p.outcome === 'ok')!.prompts[0]!.notes, 'n1');
  assert.equal(passes.find((p) => p.feature === 'f')!.outcome, 'other', 'no prompt, nothing to review');
});

test('selectPasses: bad passes ended in the window, newest first, not reviewed yet, at most max', () => {
  const p = (feature: string, min: number, outcome: Pass['outcome'] = 'bad'): Pass => ({ feature, start: at(min - 1), end: at(min), endEvent: 'failed', detail: '', outcome, prompts: [] });
  const passes = [p('a', 1), p('b', 2), p('c', 3), p('d', 4, 'ok'), p('e', 5), p('old', -9999)];
  const pick = (max: number, reviewed: string[] = []) => selectPasses(passes, { since: T0 - 3600e3, max, reviewed: (x) => reviewed.includes(x.feature) }).map((x) => x.feature);
  assert.deepEqual(pick(6), ['e', 'c', 'b', 'a']);
  assert.deepEqual(pick(2), ['e', 'c']);
  assert.deepEqual(pick(6, ['e', 'b']), ['c', 'a'], 'a reviewed pass is never picked again');
  assert.deepEqual(pick(0), []);
});

test('nextResult says how the feature\'s next pass went', () => {
  const events = [e(0, 'a', 'launch'), e(0, 'a', 'prompt', B()), e(1, 'a', 'testing', 's'), e(2, 'a', 'evaluating'), e(5, 'a', 'failed', 'FAILED check 1'),
    e(6, 'a', 'launch'), e(6, 'a', 'prompt', B()), e(9, 'a', 'merged', 'b'), e(0, 'b', 'launch'), e(0, 'b', 'prompt', B()), e(1, 'b', 'failed', 'FAILED check 1')];
  const ps = passesOf(events, own);
  assert.match(nextResult(ps, ps.find((p) => p.feature === 'a' && p.outcome === 'bad')!), /^it passed \(builder sonnet, effort medium\): merged$/);
  assert.match(nextResult(ps, ps.find((p) => p.feature === 'b')!), /not known yet/);
});

test('parseFingerprint and promptFile', () => {
  assert.deepEqual(parseFingerprint(B('abc12345')), { role: 'builder', model: 'sonnet', effort: 'medium', notes: 'abc12345' });
  assert.equal(parseFingerprint(EV)!.notes, '-');
  assert.equal(parseFingerprint('garbage'), null);
  const files = [{ name: '1-build.prompt.md', mtime: T0 }, { name: '1-eval.prompt.md', mtime: T0 + 60e3 }, { name: '1.2-build.prompt.md', mtime: T0 + 600e3 }, { name: '1-build.json', mtime: T0 }];
  assert.deepEqual(promptFile(files, 'builder', at(10), 5000), { tag: '1.2', name: '1.2-build.prompt.md' });
  assert.deepEqual(promptFile(files, 'evaluator', at(1)), { tag: '1', name: '1-eval.prompt.md' });
  assert.equal(promptFile(files, 'resolver', at(0)), null);
  assert.equal(promptFile(files, 'builder', at(60)), null, 'no file written at that time');
});

const good = { cause: 'prompt-missing-info', evidence: ['"run the typecheck"', 'FAILED check 2'], confidence: 'high', suggestion: 'Run bun run typecheck before committing.', target: 'briefs' };

test('parseReview accepts each of the six causes and refuses an invalid answer', () => {
  const r = parseReview(JSON.stringify(good));
  assert.deepEqual(r, { cause: 'prompt-missing-info', evidence: ['"run the typecheck"', 'FAILED check 2'], confidence: 'high', suggestion: 'Run bun run typecheck before committing.', target: 'briefs' });
  for (const cause of ['prompt-ambiguous', 'prompt-conflict']) assert.deepEqual((parseReview('Here:\n```json\n' + JSON.stringify({ ...good, cause }) + '\n```') as { cause: string }).cause, cause);
  for (const cause of ['model-limitation', 'environment', 'spec-error']) {
    const x = parseReview(JSON.stringify({ ...good, cause, suggestion: '', target: undefined }));
    assert.equal((x as { cause: string }).cause, cause);
    assert.equal((x as { target: unknown }).target, null);
  }
  const bad = (o: object | string) => (parseReview(typeof o === 'string' ? o : JSON.stringify(o)) as { error?: string }).error;
  assert.match(bad('looks like the model\'s fault')!, /not a JSON object/);
  assert.match(bad({ ...good, cause: 'bad-luck' })!, /unknown cause "bad-luck"/);
  assert.match(bad({ ...good, evidence: 'a quote' })!, /evidence/);
  assert.match(bad({ ...good, confidence: 'certain' })!, /confidence/);
  assert.match(bad({ ...good, suggestion: '' })!, /needs a suggestion and a target/);
  assert.match(bad({ ...good, target: 'everywhere' })!, /needs a suggestion and a target/);
  assert.match(bad({ ...good, cause: ['prompt-missing-info'] })!, /unknown cause/);
});

const R = (o: Partial<PromptReview> = {}): PromptReview => ({ ts: at(0), feature: 'a', tag: '1', role: 'builder', model: 'sonnet', effort: 'medium', notes: '-', kind: 'evaluator-rejected', next: '', cause: 'prompt-missing-info',
  evidence: ['q'], confidence: 'medium', suggestion: 'Do x.', target: 'briefs', cost: 0, ...o });

test('eligible: a high-confidence prompt-* suggestion, or one whose cause came again for the same model and role', () => {
  const a = R(), b = R({ feature: 'b' }), hi = R({ confidence: 'high' }), other = R({ model: 'opus' }), lim = R({ cause: 'model-limitation', suggestion: '' });
  assert.equal(eligible(a, [a], 'model'), false, 'medium and alone');
  assert.equal(eligible(a, [a, b], 'model'), true, 'recurring');
  assert.equal(eligible(hi, [hi], 'model'), true);
  assert.equal(eligible(a, [a, other], 'model'), false, 'another model\'s failure is not this model\'s recurrence');
  assert.equal(eligible(a, [a, other], 'role'), true, 'but it is one for the role\'s template');
  assert.equal(eligible(lim, [lim, R({ cause: 'model-limitation' })], 'model'), false, 'only prompt-* causes');
  assert.equal(eligible(R({ confidence: 'high', suggestion: '' }), [], 'model'), false);
  assert.equal(eligible(R({ cause: null, confidence: null }), [], 'model'), false, 'an invalid answer');
});

test('notes: merging dedupes, the cap drops the oldest, the curator\'s answer is checked', () => {
  assert.equal(noteBullet('  Run the\n typecheck.  '), '- Run the typecheck.');
  assert.equal(noteBullet('- already a bullet'), '- already a bullet');
  assert.equal(noteBullet('   '), '');
  const first = mergeNotes([], ['Run the typecheck.', 'Read CONTRACTS.md first.']);
  assert.deepEqual(first, ['- Run the typecheck.', '- Read CONTRACTS.md first.']);
  assert.deepEqual(mergeNotes(first, ['run the TYPECHECK', 'Keep edits additive.', '']), [...first, '- Keep edits additive.'], 'near-duplicates and empties are dropped');
  const many = Array.from({ length: 10 }, (_, i) => `- note number ${i} with some words`);
  const f = fitNotes(many, 150);
  assert.deepEqual(f.kept, many.slice(-f.kept.length));
  assert.deepEqual([...f.dropped, ...f.kept], many);
  assert.ok(Buffer.byteLength(f.kept.join('\n') + '\n') <= 150 && f.dropped.length > 0);
  assert.equal(overCap(many, 150), true);
  assert.equal(fitNotes(['- one very long note that is over the cap by itself ....'], 10).kept.length, 1, 'the newest note always stays');
  assert.deepEqual(parseNotes('ok:\n<notes>\n- a\n- b\n</notes>', 100), { bullets: ['- a', '- b'] });
  for (const [t, why] of [['nothing', /no <notes>/], ['<notes>\n- a\nprose\n</notes>', /other than bullets/], ['<notes>\n</notes>', /no bullets/], ['<notes>\n- ' + 'x'.repeat(200) + '\n</notes>', /over the limit/]] as const)
    assert.match((parseNotes(t, 100) as { error: string }).error, why);
});

test('the notes go into the prompt under their heading, for that model and role only, and into the fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factos-notes-'));
  try {
    mkdirSync(join(dir, '.fact-os/prompt-notes'), { recursive: true });
    writeFileSync(notesFile(dir, 'sonnet', 'builder'), '- Run the typecheck before you commit.\n');
    const f = { id: 'a', title: 'Feature a', description: 'Build a', acceptance: ['a.txt exists'] } as Feature;
    const sonnet = readNotes(dir, 'sonnet', 'builder');
    assert.equal(sonnet, '- Run the typecheck before you commit.');
    const withNotes = builderPrompt(dir, DEFAULT_CONFIG, f, 'ship/a', [], [], notesBlock('sonnet', 'builder', sonnet));
    assert.match(withNotes, /\n## Notes for sonnet as builder\n\n.*\n\n- Run the typecheck before you commit\.\n$/);
    assert.ok(withNotes.indexOf('## Notes for') > withNotes.indexOf('Rules:'), 'appended after the rules');
    assert.equal(readNotes(dir, 'opus', 'builder'), null, 'another model has no notes');
    assert.equal(readNotes(dir, 'sonnet', 'evaluator'), null, 'nor does another role');
    assert.equal(readNotes(dir, undefined, 'builder'), null);
    assert.equal(builderPrompt(dir, DEFAULT_CONFIG, f, 'ship/a', [], [], notesBlock('opus', 'builder', readNotes(dir, 'opus', 'builder'))), builderPrompt(dir, DEFAULT_CONFIG, f, 'ship/a', []), 'no notes: the prompt is unchanged');
    assert.equal(notesBlock('sonnet', 'builder', '  '), '');
    // the fingerprint: unchanged without notes, a hash of them with, so the stats split by notes version
    const plain = promptFingerprint('builder', { model: 'sonnet', effort: 'medium' }, 'l', 'b'), noted = promptFingerprint('builder', { model: 'sonnet', effort: 'medium' }, 'l', 'b', null, null, sonnet);
    assert.equal(noted, `${plain} notes=${notesHash(sonnet!)}`);
    assert.notEqual(noted, promptFingerprint('builder', { model: 'sonnet', effort: 'medium' }, 'l', 'b', null, null, '- other'));
    assert.match(promptFingerprint('builder', { model: 'sonnet', effort: 'medium' }, 'l', 'b', 'fable-sonnet', 'medium', sonnet), /briefs=\S+ notes=[0-9a-f]{8} profile=fable-sonnet risk=high effortBase=medium$/);
    assert.equal(parseFingerprint(noted)!.notes, notesHash(sonnet!));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agentStats starts a new version when the notes change', () => {
  const ev = (min: number, feature: string, event: string, detail = '') => ({ ts: at(min), feature, event, detail });
  const events = [ev(0, 'a', 'launch'), ev(0, 'a', 'prompt', B()), ev(1, 'a', 'testing', 's'), ev(10, 'b', 'launch'), ev(10, 'b', 'prompt', B('abcd1234')), ev(11, 'b', 'testing', 's'),
    ev(20, 'c', 'launch'), ev(20, 'c', 'prompt', B('abcd1234')), ev(21, 'c', 'testing', 's')];
  const eras = agentStats(events, [], T0 - 60e3);
  assert.deepEqual(eras.map((x) => [x.launches, x.built]), [[1, 1], [2, 2]]);
  assert.match(eras[1]!.change, /notes=abcd1234/);
  assert.notEqual(versionKey(B()), versionKey(B('abcd1234')));
});

test('promptRates and trend: failure rates per notes version', () => {
  const pr = (notes: string, min: number) => ({ role: 'builder' as const, model: 'sonnet', effort: 'medium', notes, ts: at(min), detail: '' });
  const pass = (outcome: Pass['outcome'], notes: string, min: number): Pass => ({ feature: 'x', start: at(min), end: at(min + 1), endEvent: 'x', detail: '', outcome, ...(outcome === 'bad' ? { role: 'builder' as const, kind: 'gate-failed' as const } : {}), prompts: [pr(notes, min)] });
  const passes = [...Array.from({ length: 4 }, (_, i) => pass('bad', '-', i)), pass('ok', '-', 5), ...Array.from({ length: 5 }, (_, i) => pass('ok', 'n1', 10 + i)), pass('bad', 'n1', 20), pass('other', 'n1', 30)];
  const rates = promptRates(passes);
  assert.deepEqual(rates.map((r) => [r.notes, r.ok, r.bad]), [['-', 1, 4], ['n1', 5, 1]]);
  assert.equal(trend(rates[0], rates[1]!), 'better');
  assert.equal(trend(rates[1], rates[0]!), 'worse');
  assert.equal(trend({ ok: 2, bad: 1 }, rates[1]!), 'too few passes to say');
  assert.equal(trend({ ok: 5, bad: 1 }, { ok: 6, bad: 1 }), 'about the same');
  assert.equal(trend(undefined, rates[0]!), 'too few passes to say');
});

test('promptSummary and the report section: causes, top suggestions, notes and results by notes version', () => {
  const now = new Date().toISOString();
  const reviews: Record<string, PromptReview> = {
    'a/1': R({ ts: now, suggestion: 'Run the typecheck.' }), 'b/1': R({ ts: now, feature: 'b', suggestion: 'run the typecheck.', confidence: 'high' }),
    'c/1': R({ ts: now, feature: 'c', cause: 'model-limitation', suggestion: '', target: null }), 'd/1': R({ ts: now, feature: 'd', cause: null, confidence: null, suggestion: '', target: null, error: 'invalid answer: x' }),
    'old/1': R({ ts: '2020-01-01T00:00:00Z' }) };
  const s = promptSummary({ promptReviews: reviews, promptRates: [{ model: 'sonnet', role: 'builder', notes: '-', since: at(0), ok: 1, bad: 4 }, { model: 'sonnet', role: 'builder', notes: 'n1', since: at(10), ok: 5, bad: 1 }] },
    (m, r) => (m === 'sonnet' && r === 'builder' ? '- Run the typecheck.\n- Read CONTRACTS.md.\n' : ''));
  assert.equal(s.reviewed, 3);
  assert.equal(s.invalid, 1);
  assert.equal(s.rows.length, 1);
  const row = s.rows[0]!;
  assert.deepEqual(row.causes, [{ cause: 'prompt-missing-info', n: 2 }, { cause: 'model-limitation', n: 1 }]);
  assert.deepEqual(row.suggestions, [{ text: 'Run the typecheck.', n: 2, target: 'briefs' }]);
  assert.equal(row.notes!.bytes, 41);
  assert.deepEqual(row.versions.map((v) => v.trend), ['', 'better']);
  const md = renderPromptSection(s, () => 'Oct 1').join('\n');
  assert.match(md, /^## Why runs failed, by model/);
  assert.match(md, /### sonnet as builder/);
  assert.match(md, /Causes: the prompt left something out 2, the model got it wrong despite a clear prompt 1\./);
  assert.match(md, /- 2× Run the typecheck\. \(briefs\)/);
  assert.match(md, /Notes in force: 2, 41 bytes\./);
  assert.match(md, /\| n1 \| Oct 1 \| 6 \| 1 \(17%\) \| better \|/);
  assert.deepEqual(renderPromptSection({ reviewed: 0, invalid: 0, cost: 0, runs24h: 0, rows: [] }, () => ''), []);
  const costly = promptSummary({ promptReviews: reviews, promptReviewCost: 1.5, promptReviewRuns: [now, '2020-01-01T00:00:00Z'] }, () => '');
  assert.deepEqual([costly.cost, costly.runs24h, costly.invalid], [1.5, 1, 1], 'the cost so far, the runs of the last 24 hours, the invalid ones of the last 7 days (not the old review)');
  assert.match(renderPromptSection(costly, () => '').join('\n'), /Review cost so far: \$1\.50 \(1 review runs in the last 24 hours\)/);
});

test('reviewPrompt carries the saved prompt, the outcome, the model and the six causes, and shortens a long prompt in the middle', () => {
  const p = reviewPrompt({ feature: 'F1', title: 'Cart', role: 'builder', model: 'sonnet', effort: 'medium', kind: 'gate-failed', outcome: 'test command `g` exited 1:\n FAIL cart.test.ts',
    diffStat: ' cart.ts | 4 ++--', next: 'it passed: merged', prompt: 'HEAD ' + 'x'.repeat(30000) + ' TAIL', file: '/r/runs/F1/1-build.prompt.md' });
  assert.match(p, /^You review one failed pass/);
  for (const c of ['prompt-missing-info', 'prompt-ambiguous', 'prompt-conflict', 'model-limitation', 'environment', 'spec-error']) assert.ok(p.includes(`- ${c}:`), c);
  for (const t of ['Feature: F1: Cart', 'Model: sonnet', 'the feature\'s own tests failed', 'FAIL cart.test.ts', 'cart.ts | 4', 'it passed: merged', 'HEAD', ' TAIL', 'characters omitted', '/r/runs/F1/1-build.prompt.md']) assert.ok(p.includes(t), t);
  assert.ok(p.length < 30000);
});

test('reviewBudget: one batch per everyMinutes, at most maxPerDay runs in 24 hours, at most maxPerPass at once; reviews are cut off after at most 20 minutes', () => {
  const cfg = { enabled: true, maxPerPass: 6, notesMaxBytes: 3000, everyMinutes: 30, maxPerDay: 24 }, t = Date.parse('2026-10-01T12:00:00Z'), ago = (min: number) => new Date(t - min * 60e3).toISOString();
  assert.deepEqual(reviewBudget(cfg, {}, t), { wait: false, max: 6 }, 'the first batch starts at once');
  assert.deepEqual(reviewBudget(cfg, { promptReviewAt: ago(10) }, t), { wait: true, max: 0 }, 'a batch ran 10 minutes ago');
  assert.deepEqual(reviewBudget(cfg, { promptReviewAt: ago(31) }, t), { wait: false, max: 6 });
  assert.deepEqual(reviewBudget({ ...cfg, everyMinutes: 0 }, { promptReviewAt: ago(0) }, t), { wait: false, max: 6 });
  const runs = (n: number, min = 60) => Array.from({ length: n }, () => ago(min));
  assert.equal(reviewBudget(cfg, { promptReviewAt: ago(60), promptReviewRuns: runs(21) }, t).max, 3, 'what is left of the day');
  assert.equal(reviewBudget(cfg, { promptReviewAt: ago(60), promptReviewRuns: runs(24) }, t).max, 0, 'the day\'s limit');
  assert.equal(reviewBudget(cfg, { promptReviewAt: ago(60), promptReviewRuns: runs(24, 25 * 60) }, t).max, 6, 'runs older than a day do not count');
  assert.equal(reviewTimeoutMin({ timeoutMin: null }), 20);
  assert.equal(reviewTimeoutMin({ timeoutMin: 90 }), 20);
  assert.equal(reviewTimeoutMin({ timeoutMin: 5 }), 5);
});
