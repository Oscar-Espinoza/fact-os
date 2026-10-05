import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodes, scorecard, JUDGE_MIN, type RunFile } from '../lib/scorecard.ts';
import type { LogEvent, Verdict } from '../lib/types.ts';

let clock = Date.parse('2026-10-05T00:00:00Z');
const ev = (event: string, detail = '', o: Partial<LogEvent> = {}): LogEvent => ({ ts: new Date((clock += 60e3)).toISOString(), feature: 'a', event, detail, ...o });
const V = (pass: boolean, o: Partial<Verdict> = {}): Verdict => ({ pass, findings: [], cheating: [], blocking: [], notes: [], lesson: null, ...o });
const file = (tag: string, role: 'build' | 'eval', o: Partial<RunFile> = {}): RunFile => ({ tag, role, mtime: 0, cost: role === 'build' ? 1 : null, verdict: null, invalid: false, ...o });
const run = (tag: string, model: string, effort: string, o = {}) => ({ run: { phase: 'build' as const, tag, role: 'builder', provider: 'claude', model, effort, tier: 'normal', resumed: false, promptBytes: 1, ...o } });

test('episodes: a fresh build owns the repairs and reviews written until the next fresh build; first and final review, issue kinds, cost and merge', () => {
  clock = Date.parse('2026-10-05T00:00:00Z');
  const events = [ev('launch'), ev('prompt', 'builder', run('1', 'sonnet', 'medium')), ev('prompt', 'evaluator model=x effort=y'), ev('prompt', 'builder', { run: { ...run('1.2', 'sonnet', 'medium').run, phase: 'fix-review', resumed: true } }),
    ev('failed', 'BLOCKING: x'), ev('launch'), ev('prompt', 'builder', run('2', 'sonnet', 'high', { rule: 'ladder: 1 counted failure this cycle → sonnet high (from sonnet medium)' })), ev('merged')];
  const t = (i: number) => Date.parse(events[i]!.ts) + 30e3; // written after the event at index i
  const files = [file('1', 'build', { mtime: t(1) }), file('1', 'eval', { mtime: t(2), verdict: V(false, { findings: [{ check: 'c', ok: false, evidence: 'e', kind: 'weak-test' }], blocking: ['b'], blockingKinds: ['duplicated-helper'] }) }),
    file('1.2', 'build', { mtime: t(3) }), file('1.3', 'eval', { mtime: t(3) + 1000, verdict: V(false) }), file('2', 'build', { mtime: t(6), cost: null }), file('2', 'eval', { mtime: t(6) + 1000, verdict: V(true) })];
  const [a, b] = episodes('a', events, files);
  assert.deepEqual([a!.firstReview, a!.finalReview, a!.repairs, a!.kinds, a!.cost, a!.merged, a!.escalated], ['rejected', 'rejected', 1, ['weak-test', 'duplicated-helper'], 2, false, false]);
  assert.deepEqual([b!.model, b!.effort, b!.tier, b!.firstReview, b!.cost, b!.merged, b!.escalated], ['sonnet', 'high', 'normal', 'accepted', null, true, true]);
});

test('episodes: time decides ownership, not tags (a reset restarts tags; a held build reviewed later stays its builder\'s); older fingerprints keep their recorded tier', () => {
  clock = Date.parse('2026-10-05T00:00:00Z');
  const events = [ev('launch'), ev('prompt', 'builder model=opus effort=medium notes=- tier=risky'), ev('launch'), ev('prompt', 'builder model=sonnet effort=high notes=-'), ev('retrying'), ev('launch')];
  const t = (i: number) => Date.parse(events[i]!.ts) + 30e3;
  const [a, b] = episodes('a', events, [file('1', 'eval', { mtime: t(1), verdict: V(false) }), file('2', 'build', { mtime: t(3) }), file('1.2', 'eval', { mtime: t(5), verdict: V(true) })]);
  assert.deepEqual([a!.model, a!.tier, a!.firstReview], ['opus', 'risky', 'rejected']);
  assert.deepEqual([b!.model, b!.tier, b!.firstReview, b!.finalReview], ['sonnet', 'unknown', 'accepted', 'accepted']);
});

test('scorecard: cells by model, effort and recorded tier with feature counts; unknown tiers and small cells never make a comparison', () => {
  const ep = (feature: string, model: string, tier: string, firstReview: 'accepted' | 'rejected') => ({ feature, ts: '2026-10-05T00:00:00Z', model, effort: 'high', tier, escalated: false,
    firstReview, finalReview: firstReview, repairs: 0, kinds: [], cost: 1, merged: firstReview === 'accepted' });
  const few = scorecard([ep('a', 'sonnet', 'unknown', 'accepted'), ep('a', 'sonnet', 'unknown', 'rejected'), ep('b', 'opus', 'normal', 'accepted')]);
  assert.deepEqual(few.cells.map((c) => [c.model, c.tier, c.episodes, c.features, c.firstAccepted, c.reviewed, c.judged]), [['opus', 'normal', 1, 1, 1, 1, false], ['sonnet', 'unknown', 2, 1, 1, 2, false]]);
  assert.match(few.verdict, /^Insufficient comparable evidence: .*largest tier-recorded row: 1 feature\)/);
  const many = Array.from({ length: JUDGE_MIN }, (_, i) => [ep(`s${i}`, 'sonnet', 'normal', 'rejected'), ep(`o${i}`, 'opus', 'normal', 'accepted')]).flat();
  assert.match(scorecard(many).verdict, /^Same-tier rows with 8\+ features each: normal\. .*not a fair comparison\. Routing stays as configured\.$/);
});

test('recheck: a review written just before the next fresh prompt stays with the build it reviewed', () => {
  clock = Date.parse('2026-10-05T00:00:00Z');
  const events = [ev('launch'), ev('prompt', 'builder', run('1', 'sonnet', 'medium')), ev('launch'), ev('prompt', 'builder', run('2', 'opus', 'high'))];
  const at = (i: number) => Date.parse(events[i]!.ts);
  const [a, b] = episodes('a', events, [file('1', 'eval', { mtime: at(3) - 1000, verdict: V(false) }), file('2', 'eval', { mtime: at(3) + 5000, verdict: V(true) })]);
  assert.deepEqual([a!.firstReview, b!.firstReview, b!.finalReview], ['rejected', 'accepted', 'accepted']);
});
