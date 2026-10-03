import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { passesOf, promptRates, promptSummary, renderPromptSection, trend, type PromptState, type PromptSummary } from '../lib/promptreview.ts';
import { observeOnce } from '../lib/observe.ts';
import { startDash, type ProjectState } from '../lib/dash.ts';
import type { LogEvent, Role } from '../lib/types.ts';

const epoch = Date.now() - 3600e3, at = (n: number) => new Date(epoch + n * 1000).toISOString();
const ev = (n: number, feature: string, event: string, detail = ''): LogEvent => ({ ts: at(n), feature, event, detail });
const fingerprint = (role: Role, model = 'sol', notes = 'n1') => `${role} model=${model} effort=high notes=${notes}`;
const classified = (events: LogEvent[]) => passesOf(events, () => 'own');
const counts = (events: LogEvent[]) => promptRates(classified(events)).map(({ model, role, notes, ok, bad }) => ({ model, role, notes, ok, bad }));
function clean(feature: string, start = 0, notes = 'n1', repeats = 2, end = 'merged'): LogEvent[] {
  return [ev(start, feature, 'launch'), ev(start + 1, feature, 'prompt', fingerprint('builder')),
    ...Array.from({ length: repeats }, (_, i) => [ev(start + 2 + i * 3, feature, 'evaluating'),
      ev(start + 3 + i * 3, feature, 'prompt', fingerprint('evaluator', 'sol', notes)),
      ...(i < repeats - 1 ? [ev(start + 4 + i * 3, feature, 'revalidate'), ev(start + 4 + i * 3, feature, 'refreshed', 'before test, conflict-free')] : [])]).flat(),
    ev(start + 2 + repeats * 3, feature, end, end === 'failed' ? 'Evaluator: verdict.findings must be a nonempty array' : '')];
}

test('R12: clean revalidation counts one successful pass per role, not evaluator invocations', () => {
  assert.deepEqual(counts(clean('a', 0, 'n1', 3)), [
    { model: 'sol', role: 'builder', notes: 'n1', ok: 1, bad: 0 },
    { model: 'sol', role: 'evaluator', notes: 'n1', ok: 1, bad: 0 },
  ]);
});

test('R12: inline resolver continuations credit only each role final model and notes', () => {
  const events = [ev(0, 'a', 'launch'), ev(1, 'a', 'prompt', fingerprint('builder')),
    ev(2, 'a', 'evaluating'), ev(3, 'a', 'prompt', fingerprint('evaluator', 'old', 'old-notes')),
    ev(4, 'a', 'refreshed', 'conflicts in: a.ts'), ev(5, 'a', 'resolving'), ev(6, 'a', 'prompt', fingerprint('resolver', 'old', 'old-notes')),
    ev(7, 'a', 'resolved'), ev(8, 'a', 'evaluating'), ev(9, 'a', 'prompt', fingerprint('evaluator', 'new', 'new-notes')),
    ev(10, 'a', 'refreshed', 'conflicts in: b.ts'), ev(11, 'a', 'resolving'), ev(12, 'a', 'prompt', fingerprint('resolver', 'new', 'new-notes')),
    ev(13, 'a', 'resolved'), ev(14, 'a', 'evaluating'), ev(15, 'a', 'prompt', fingerprint('evaluator', 'new', 'new-notes')), ev(16, 'a', 'merged')];
  assert.equal(classified(events).length, 1);
  assert.deepEqual(counts(events), [
    { model: 'sol', role: 'builder', notes: 'n1', ok: 1, bad: 0 },
    { model: 'new', role: 'resolver', notes: 'new-notes', ok: 1, bad: 0 },
    { model: 'new', role: 'evaluator', notes: 'new-notes', ok: 1, bad: 0 },
  ]);
});

test('R12: failed passes count only the final prompt of the attributed role', () => {
  for (const [role, event, detail] of [
    ['builder', 'failed', 'FAILED check: defect'], ['evaluator', 'failed', 'Evaluator: verdict.pass must be a boolean'],
    ['resolver', 'resolve-failed', 'the resolver failed: exit 1'], ['resolver', 'resolve-failed', 'keep-check: lost lines'],
  ] as const) {
    const events = [ev(0, 'a', 'launch'), ev(1, 'a', 'prompt', fingerprint('builder')),
      ev(2, 'a', 'prompt', fingerprint('evaluator')), ev(3, 'a', 'prompt', fingerprint('resolver')),
      ev(4, 'a', 'prompt', fingerprint(role, 'final', 'final-notes')), ev(5, 'a', event, detail)];
    assert.deepEqual(counts(events), [{ model: 'final', role, notes: 'final-notes', ok: 0, bad: 1 }]);
  }
});

test('R12: skipped builds credit only currently prompted roles; incomplete and other passes are excluded', () => {
  const events = [...clean('a'), ev(20, 'a', 'launch'), ev(21, 'a', 'build-skipped'),
    ev(22, 'a', 'evaluating'), ev(23, 'a', 'prompt', fingerprint('evaluator')), ev(24, 'a', 'ready'),
    ev(30, 'a', 'lesson'), ev(31, 'a', 'lesson-error'), ev(32, 'orphan', 'merged'),
    ev(40, 'interrupted', 'launch'), ev(41, 'interrupted', 'prompt', fingerprint('builder')), ev(42, 'interrupted', 'interrupted'),
    ev(50, 'infra', 'launch'), ev(51, 'infra', 'prompt', fingerprint('builder')), ev(52, 'infra', 'error', 'disk failed'),
    ev(60, 'incomplete', 'launch'), ev(61, 'incomplete', 'prompt', fingerprint('builder')),
    ev(70, 'no-builder', 'launch'), ev(71, 'no-builder', 'prompt', fingerprint('evaluator')), ev(72, 'no-builder', 'failed', 'FAILED defect')];
  assert.deepEqual(counts(events), [
    { model: 'sol', role: 'builder', notes: 'n1', ok: 1, bad: 0 },
    { model: 'sol', role: 'evaluator', notes: 'n1', ok: 2, bad: 0 },
  ]);
});

test('R12: repeated evaluations cannot satisfy the five-pass comparison threshold', () => {
  const events = [...clean('a', 0, 'old', 3), ...clean('b', 20, 'old', 3), ...clean('bad', 40, 'old', 3, 'failed'),
    ...Array.from({ length: 5 }, (_, i) => clean(`new-${i}`, 60 + i * 10, 'new', 1)).flat()];
  const rates = promptRates(classified(events)).filter((r) => r.role === 'evaluator');
  assert.deepEqual(rates.map((r) => [r.notes, r.ok, r.bad]), [['old', 2, 1], ['new', 5, 0]]);
  assert.equal(trend(rates[0], rates[1]!), 'too few passes to say');
});

test('R12: existing parked exclusions remain distinct from an evaluated conflict bounce', () => {
  const events = [...clean('parked', 0, 'n1', 2, 'merge-skipped'), ...clean('refused', 20, 'n1', 2, 'merge-failed'),
    ...clean('tampered', 40, 'n1', 2, 'merge-skipped'),
    ev(60, 'bounce', 'launch'), ev(61, 'bounce', 'prompt', fingerprint('builder')),
    ev(62, 'bounce', 'evaluating'), ev(63, 'bounce', 'prompt', fingerprint('evaluator')),
    ev(64, 'bounce', 'revalidate'), ev(65, 'bounce', 'refreshed', 'before test, conflict-free'),
    ev(66, 'bounce', 'evaluating'), ev(67, 'bounce', 'prompt', fingerprint('evaluator')),
    ev(68, 'bounce', 'refreshed', 'conflicts in: x.ts'), ev(69, 'parked', 'merged')];
  assert.deepEqual(classified(events).map((p) => [p.feature, p.outcome]),
    [['parked', 'other'], ['refused', 'other'], ['tampered', 'other'], ['bounce', 'ok']]);
  assert.deepEqual(counts(events), [
    { model: 'sol', role: 'builder', notes: 'n1', ok: 1, bad: 0 },
    { model: 'sol', role: 'evaluator', notes: 'n1', ok: 1, bad: 0 },
  ]);
});

test('R12: version since is the earliest contributing final prompt despite completion ordering', () => {
  const events = [ev(0, 'slow', 'launch'), ev(1, 'slow', 'prompt', fingerprint('evaluator', 'sol', 'old')),
    ev(2, 'middle', 'launch'), ev(3, 'middle', 'prompt', fingerprint('evaluator', 'sol', 'new')), ev(4, 'middle', 'merged'),
    ev(5, 'fast', 'launch'), ev(6, 'fast', 'prompt', fingerprint('evaluator', 'sol', 'old')), ev(7, 'fast', 'merged'), ev(8, 'slow', 'merged')];
  const rates = promptRates(classified(events));
  assert.deepEqual(rates.map((r) => [r.notes, r.since, r.ok]), [['old', at(1), 2], ['new', at(3), 1]]);
});

test('R12: legacy cached rates wait for regeneration without discarding notes or review costs', () => {
  const old: PromptState = { promptRates: [{ model: 'sol', role: 'evaluator', notes: 'n1', since: at(1), ok: 10, bad: 1 }], promptReviewCost: 7 };
  const summary = promptSummary(old, () => '- Check evidence.');
  assert.equal((summary as PromptSummary & { ratesPending?: boolean }).ratesPending, true);
  assert.deepEqual(summary.rows[0]!.versions, []);
  assert.equal(summary.rows[0]!.notes!.text, '- Check evidence.');
  assert.equal(summary.cost, 7);
  const report = renderPromptSection(summary, () => 'today').join('\n');
  assert.match(report, /Rates will update after the next observer pass\./);
  assert.doesNotMatch(report, /\| n1 \|/);
});

// Exercise the registered renderer from the actual served observer script without
// a browser layout engine. Other observer sections use empty fixture state.
async function observerMarkup(url: string, project: ProjectState): Promise<string> {
  const nodes = new Map<string, any>();
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', hidden: false, querySelectorAll: () => [] }); return nodes.get(id); };
  let view: { render: () => void } | undefined;
  const sandbox = { F: { $: node, esc: (x: unknown) => String(x), setHTML: (n: any, s: string) => { n.innerHTML = s; },
    featureHref: (id: string) => '#f/' + id, store: { get: () => 'agents' }, LABEL: {}, P: project,
    shortId: (id: string) => id, title: (f: { title: string }) => f.title, byId: () => undefined,
    view: (_name: string, v: { render: () => void }) => { view = v; } }, document: { activeElement: null } };
  runInContext(await (await fetch(url + '/dash/observer.js')).text(), createContext(sandbox));
  view!.render();
  return node('o-body').innerHTML;
}

test('R12: observer rebuilds legacy rates and report API and served UI agree on pass counts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factos-rates-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('commit', '-q', '--allow-empty', '-m', 'init');
  const dir = join(root, '.fact-os'); mkdirSync(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ observer: { agent: null } }));
  writeFileSync(join(dir, 'features.json'), JSON.stringify({ features: [] }));
  writeFileSync(join(dir, 'human.json'), JSON.stringify({ tasks: [] }));
  const events = [...clean('a'), ...clean('b', 20), ...clean('bad', 40, 'n1', 3, 'failed')];
  writeFileSync(join(dir, 'log.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dir, 'observer.json'), JSON.stringify({ offset: 0, retried: {}, diagnoses: [], alerts: [],
    promptReviewCost: 7, promptRates: [{ model: 'sol', role: 'evaluator', notes: 'n1', since: at(1), ok: 99, bad: 1 }] }));
  const dash = await startDash({ root, port: 0 }); t.after(() => dash.server.close());
  const api = async () => ((await (await fetch(dash.url + '/api/state')).json()) as { projects: ProjectState[] }).projects[0]!;
  const before = await api();
  assert.equal((before.observer!.prompts as PromptSummary & { ratesPending?: boolean }).ratesPending, true);
  assert.match(await observerMarkup(dash.url, before), /Rates will update after the next observer pass\./);
  const state = await observeOnce(root, { out: () => {} });
  const saved = JSON.parse(readFileSync(join(dir, 'observer.json'), 'utf8'));
  assert.equal(saved.promptRatesUnit, 'final-role-pass-v1');
  assert.deepEqual(saved.promptRates, state.promptRates);
  const after = await api(), summary = after.observer!.prompts;
  assert.equal((summary as PromptSummary & { ratesPending?: boolean }).ratesPending, undefined);
  const row = summary.rows.find((r) => r.role === 'evaluator')!;
  assert.deepEqual(row.versions.map((v) => [v.notes, v.ok, v.bad]), [['n1', 2, 1]]);
  assert.equal(summary.cost, 7);
  const report = readFileSync(join(dir, 'observer-report.md'), 'utf8');
  assert.match(report, /\| n1 \|[^\n]+\| 3 \| 1 \(33%\) \|/);
  const markup = await observerMarkup(dash.url, after);
  assert.match(markup, /1 of 3 passes failed \(33%\)/);
  assert.match(markup, /final prompt/);
  assert.match(report, /final prompt/);
  assert.doesNotMatch(markup, /99 of|100 passes|Rates will update/);
});

test('I01: a resumed gate fix stays in its pass; the final builder prompt gets the credit or the blame', () => {
  const fixed = (feature: string, end: LogEvent[]) => [ev(0, feature, 'launch'), ev(1, feature, 'prompt', fingerprint('builder', 'sol', 'n1')),
    ev(2, feature, 'testing', 's1'), ev(3, feature, 'gate-fix', 'resuming the builder after a test-gate failure'),
    ev(4, feature, 'prompt', fingerprint('builder', 'sol', 'n2')), ev(5, feature, 'test-edits', 'in the fix: a.test.ts: removes 1 line'),
    ev(6, feature, 'testing', 's2'), ...end];
  const passes = classified([...fixed('a', [ev(7, 'a', 'evaluating'), ev(8, 'a', 'prompt', fingerprint('evaluator')), ev(9, 'a', 'merged')]),
    ...fixed('b', [ev(10, 'b', 'diagnosis', 'code: broken'), ev(11, 'b', 'failed', 'test command `gate` exited 1:\nboom')])]);
  assert.equal(passes.length, 2, 'one pass per launch');
  assert.deepEqual(promptRates(passes).map(({ role, notes, ok, bad }) => ({ role, notes, ok, bad })), [
    { role: 'builder', notes: 'n2', ok: 1, bad: 1 },
    { role: 'evaluator', notes: 'n1', ok: 1, bad: 0 },
  ]);
});
