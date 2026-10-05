// The planner (lib/plan.ts): the output contract, skip rules and the daily cap, role resolution, and end to end with
// fixtures/fake-claude.ts (mode "plan"): an INFEASIBLE spec is held before any build, a FEASIBLE plan reaches the builder and the
// evaluator, a broken planner never blocks a build, and a plan is reused until the spec changes.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePlan, planSkip, plannerRunsSince, plannerPrompt } from '../lib/plan.ts';
import { plannedEffort, plannerRole, profileProblems } from '../lib/profiles.ts';
import { DEFAULT_CONFIG, loadConfig } from '../lib/state.ts';
import { builderPrompt, evaluatorPrompt, holdInputs, planSection } from '../lib/foreman.ts';
import { candidates, currentFailure } from '../lib/specfix.ts';
import type { Config, Feature, FeaturesFile, LogEvent, Verdict } from '../lib/types.ts';
import { reap } from './reap.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id}.txt exists`],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });
const C = (o: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...o });

// ---- the output contract ----

test('parsePlan: FEASIBLE with effort, split and the plan body', () => {
  assert.deepEqual(parsePlan('VERDICT: FEASIBLE\nEFFORT: high\nSPLIT: no\n\n1. Change lib/a.ts using parse() (rg: lib/b.ts:3).\n2. Order: a then b.'),
    { verdict: 'FEASIBLE', effort: 'high', split: null, plan: '1. Change lib/a.ts using parse() (rg: lib/b.ts:3).\n2. Order: a then b.', words: 12 });
  const s = parsePlan('\n  VERDICT: FEASIBLE\nEFFORT: medium\nSPLIT: yes: the API and the UI\nplan');
  assert.deepEqual(s, { verdict: 'FEASIBLE', effort: 'medium', split: 'the API and the UI', plan: 'plan', words: 1 });
});

test('parsePlan: INFEASIBLE needs numbered conflicts, each quoting file:line', () => {
  const ok = parsePlan('VERDICT: INFEASIBLE\nEFFORT: medium\nSPLIT: no\nCONFLICTS\n1. "no runtime change" vs "fail safely": lib/pay.ts:40 throws.\n   Resolutions: allow a change.\n2) src/x.tsx:7 has no such export');
  assert.deepEqual(ok, { verdict: 'INFEASIBLE', effort: 'medium', split: null,
    conflicts: ['"no runtime change" vs "fail safely": lib/pay.ts:40 throws.\nResolutions: allow a change.', 'src/x.tsx:7 has no such export'] });
  assert.match((parsePlan('VERDICT: INFEASIBLE\nEFFORT: medium\nSPLIT: no\nCONFLICTS\n1. the spec is vague') as { error: string }).error, /conflict 1 quotes no file:line/);
  assert.match((parsePlan('VERDICT: INFEASIBLE\nEFFORT: medium\nSPLIT: no\nit cannot be done') as { error: string }).error, /numbered CONFLICTS/);
});

test('parsePlan: anything off the contract is an error (fail soft), never a verdict', () => {
  for (const [text, why] of [
    ['Here is my plan: just build it.', /first line/], ['**VERDICT: FEASIBLE**\nEFFORT: medium\nSPLIT: no\nx', /first line/],
    ['VERDICT: FEASIBLE\nSPLIT: no\nEFFORT: medium\nx', /second line/], ['VERDICT: FEASIBLE\nEFFORT: low\nSPLIT: no\nx', /second line/],
    ['VERDICT: FEASIBLE\nEFFORT: medium\nSPLIT: maybe\nx', /third line/], ['VERDICT: FEASIBLE\nEFFORT: medium\nSPLIT: no', /without a plan/],
    ['', /first line/], [null, /first line/],
  ] as const) assert.match((parsePlan(text) as { error: string }).error ?? 'parsed', why, String(text).slice(0, 40));
});

test('parsePlan: a long plan is not an error; its word count is returned for the foreman to judge (config.planner.splitWords)', () => {
  for (const n of [650, 800]) {
    const p = parsePlan('VERDICT: FEASIBLE\nEFFORT: medium\nSPLIT: no\n' + 'word '.repeat(n));
    assert.deepEqual(['error' in p, 'words' in p && p.words], [false, n]);
  }
});

// ---- skip rules, cap, roles ----

test('planSkip: off, a tier below skipBelow, and the daily cap; plannerRunsSince counts plan prompts of the last 24 hours', () => {
  const p = (o: Partial<Config['planner']>) => ({ planner: { ...DEFAULT_CONFIG.planner, ...o } });
  assert.equal(planSkip(p({}), {}, 0), null);
  assert.match(planSkip(p({ enabled: false }), {}, 0)!, /off/);
  assert.match(planSkip(p({ skipBelow: 'hard' }), { tier: 'multi' }, 0)!, /tier multi is below/);
  assert.equal(planSkip(p({ skipBelow: 'hard' }), { tier: 'risky' }, 0), null);
  assert.equal(planSkip(p({ skipBelow: 'hard' }), {}, 0), null, 'untiered features are always planned');
  assert.match(planSkip(p({ maxPerDay: 2 }), {}, 2)!, /daily cap/);
  assert.match(planSkip(p({ maxPerDay: 0 }), {}, 0)!, /daily cap/);
  const now = Date.parse('2026-10-05T12:00:00Z'), ev = (ts: string, phase: string): Pick<LogEvent, 'ts' | 'event' | 'run'> =>
    ({ ts, event: 'prompt', run: { phase, tag: '1', role: 'x', provider: 'claude', model: null, effort: null, tier: null, resumed: false, promptBytes: 1 } as LogEvent['run'] });
  assert.equal(plannerRunsSince([ev('2026-10-05T11:00:00Z', 'plan'), ev('2026-10-04T11:00:00Z', 'plan'), ev('2026-10-05T11:30:00Z', 'build')], now), 1);
});

test('plannerRole: opus medium, high on a sensitive spec or after a failed attempt, always read-only; a profile entry overrides', () => {
  const c = C();
  assert.deepEqual(plannerRole(c, null, F('a')), { model: 'opus', effort: 'medium', permissionMode: 'plan', provider: 'claude', high: false });
  for (const f of [F('a', { description: 'Every route must keep its headers' }), F('a', { acceptance: ['the output must not change'] }), F('a', { title: 'Refund a payment' }),
    F('a', { description: 'Scope rows to the tenant' }), F('a', { acceptance: ['cover all paths'] }), F('a', { attempts: 1 })])
    assert.equal(plannerRole(c, null, f).effort, 'high', JSON.stringify(f));
  assert.equal(plannerRole(c, null, F('a', { description: 'everyone likes it' })).effort, 'medium', 'whole words only');
  const prof = C({ profiles: { cheap: { planner: { model: 'sonnet', effort: 'low', effortHigh: 'medium' } } } });
  assert.deepEqual([plannerRole(prof, 'cheap', F('a')).model, plannerRole(prof, 'cheap', F('a')).effort, plannerRole(prof, 'cheap', F('a', { attempts: 2 })).effort], ['sonnet', 'low', 'medium']);
  assert.deepEqual(profileProblems({ cheap: { planner: { model: 'sonnet', effortHigh: 'high' } } }), []);
});

test("plannedEffort: EFFORT high moves the builder only to its profile's effortHigh, never under opus, for a tier, or down", () => {
  const c = C(), base = { model: 'sonnet', effort: 'medium' };
  assert.deepEqual(plannedEffort(c, 'fable-sonnet', F('a'), base, 'high')?.cfg, { model: 'sonnet', effort: 'high' });
  assert.equal(plannedEffort(c, 'fable-sonnet', F('a'), base, 'medium'), null);
  assert.equal(plannedEffort(c, null, F('a'), { model: 'opus', effort: 'medium' }, 'high'), null, 'opus has no rungs');
  assert.equal(plannedEffort(c, 'fable-sonnet', F('a', { tier: 'hard' }), base, 'high'), null);
  assert.equal(plannedEffort(c, 'fable-sonnet', F('a'), { model: 'sonnet', effort: 'high' }, 'high'), null);
});

test('config.planner: defaults, partial blocks keep defaults, bad values are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-plancfg-')), file = join(root, '.fact-os', 'config.json');
  try {
    mkdirSync(join(root, '.fact-os'));
    writeFileSync(file, JSON.stringify({ planner: { maxPerDay: 3 } }));
    assert.deepEqual(loadConfig(root).planner, { ...DEFAULT_CONFIG.planner, maxPerDay: 3 });
    assert.equal(DEFAULT_CONFIG.planner.splitWords, 750);
    for (const bad of [{ enabled: 'yes' }, { maxPerDay: -1 }, { skipBelow: 'easy' }, { permissionMode: 'auto' }, { effort: '' }, { splitWords: 0 }, { splitWords: 1.5 }, { splitWords: '750' }]) {
      writeFileSync(file, JSON.stringify({ planner: bad }));
      assert.throws(() => loadConfig(root), /config\.planner\./, JSON.stringify(bad));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prompts: the planner prompt carries the contract; the builder gets the plan after acceptance, the evaluator only as context', () => {
  const f = F('a', { acceptance: ['one', 'two'] }), c = C({ briefFiles: ['docs/brief.md'] });
  const pp = plannerPrompt(f, 'ship/a', c);
  assert.match(pp, /^You are the planner for feature a: Feature a/);
  assert.match(pp, /Read-only/); assert.match(pp, /tasks\/a\.md/); assert.match(pp, /docs\/brief\.md/); assert.match(pp, /1\. one\n2\. two/);
  assert.match(pp, /VERDICT: FEASIBLE \| INFEASIBLE/); assert.match(pp, /Grep for existing helpers; never recall them from memory/);
  const root = mkdtempSync(join(tmpdir(), 'fact-os-planp-'));
  try {
    const bp = builderPrompt(root, c, f, 'ship/a', [], [], '', { plan: planSection({ verdict: 'FEASIBLE', text: 'STEP ONE' }) });
    assert.match(bp, /- two\n\nPlan \(from the planner; deviate only if the code proves it wrong, and say so in your final message\):\nSTEP ONE/);
    assert.match(bp, /finish with "blocked": \{"reason": "spec-conflict"/);
    assert.doesNotMatch(builderPrompt(root, c, f, 'ship/a', []), /Plan \(from the planner/);
    const ep = evaluatorPrompt(root, c, f, 'ship/a', 'diff', { code: 0, tail: '' }, [], '', '', [], [], 'STEP ONE');
    assert.match(ep, /Context only: the plan a read-only planner wrote before the build\. Judge the work against the acceptance checks above, never against this plan[^]*STEP ONE/);
    assert.match(planSection({ verdict: 'INFEASIBLE', conflicts: ['a.ts:1 says no'] }), /^Planner concerns:[^]*1\. a\.ts:1 says no$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spec fixes: a spec-conflict hold is a candidate (its conflicts are the evidence), and stays current while held', () => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-planfix-'));
  try {
    const c = C(), f = F('a');
    f.planningHold = { cause: 'spec-conflict', confidence: 'high', evidence: ['lib/a.ts:3 has no such export'], review: 'plan:a/1', passEnd: '', inputs: holdInputs(root, c, f), ts: '2026-10-05T00:00:00Z' };
    const [cand] = candidates(root, c, [f], {}, []);
    assert.deepEqual([cand?.key, cand?.review.cause, cand?.review.evidence], ['plan:a/1', 'spec-error', ['lib/a.ts:3 has no such export']]);
    assert.equal(currentFailure(f, { review: 'plan:a/1', inputs: f.planningHold.inputs }, []), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- end to end ----

interface FakeCall { mode: string; id: string; prompt: string; args: string[]; effort?: string | null }
function setup(t: TestContext, { features, config = {}, scenario = {}, verdicts = {} }:
  { features: Feature[]; config?: Partial<Config> | Record<string, unknown>; scenario?: Record<string, string>; verdicts?: Record<string, Partial<Verdict>[]> }) {
  const base = mkdtempSync(join(tmpdir(), 'fact-os-plan-')), repo = join(base, 'app');
  t.after(() => { reap(repo, join(base, 'pids')); rmSync(base, { recursive: true, force: true }); });
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# app\n'); git('add', '.'); git('commit', '-qm', 'init');
  chmodSync(FAKE, 0o755);
  const env = { ...process.env, FACTOS_CLAUDE: FAKE, FACTOS_POLL_MS: '100', FAKE_DELAY_MS: '30', FAKE_LOG: join(base, 'fake.jsonl'),
    FAKE_VERDICTS: join(base, 'verdicts.json'), FAKE_PIDS: join(base, 'pids'), FAKE_SCENARIO: JSON.stringify(scenario) };
  const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(cli('init', '--test', 'true').status, 0);
  const sy = (f: string) => join(repo, '.fact-os', f), read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  writeFileSync(sy('config.json'), JSON.stringify({ ...JSON.parse(readFileSync(sy('config.json'), 'utf8')), ...config }));
  writeFileSync(sy('features.json'), JSON.stringify({ features }));
  writeFileSync(env.FAKE_VERDICTS, JSON.stringify(verdicts));
  const all = () => (JSON.parse(read(sy('features.json'))) as FeaturesFile).features;
  return { repo, git, cli, sy, env,
    feature: (id: string) => all().find((f) => f.id === id)!,
    setFeature: (id: string, patch: Partial<Feature>) => writeFileSync(sy('features.json'), JSON.stringify({ features: all().map((f) => (f.id === id ? { ...f, ...patch } : f)) })),
    events: (id: string) => read(sy('log.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEvent).filter((e) => e.feature === id),
    calls: (mode: string, id: string) => read(env.FAKE_LOG).split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeCall).filter((c) => c.mode === mode && c.id === id) };
}
const fail = { pass: false, findings: [{ check: 'works', ok: false, evidence: 'not yet' }], cheating: [], lesson: null };

test('INFEASIBLE: the feature is held (spec-conflict) before any build; no builder starts and no attempt is spent', (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'plan:infeasible' } });
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(s.calls('plan', 'a').length, 1);
  assert.equal(s.calls('build', 'a').length, 0, 'no builder was started');
  assert.equal(s.calls('eval', 'a').length, 0);
  const f = s.feature('a');
  assert.deepEqual([f.status, f.attempts, f.stop], ['todo', 0, { attempt: 1, counted: false }]);
  assert.equal(f.planningHold?.cause, 'spec-conflict');
  assert.match(f.planningHold!.evidence[0]!, /README\.md:1/);
  assert.equal(f.plan?.verdict, 'INFEASIBLE');
  assert.match(readFileSync(join(s.sy('runs'), 'a', 'plan.md'), 'utf8'), /^1\. "no runtime change"/);
  const hold = s.events('a').find((e) => e.event === 'planning-hold')!;
  assert.match(hold.detail, /^spec-conflict \(high\), planner before any build: 1\./);
  assert.ok(s.events('a').some((e) => e.event === 'prompt' && e.run?.phase === 'plan' && e.run.role === 'planner'));
  // Held: a second run launches nothing; a person's release builds the spec unchanged, without a plan but with the concerns.
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('plan', 'a').length, 1, 'held features are not relaunched');
  assert.equal(s.cli('release', 'a').status, 0);
  const r2 = s.cli('run'); assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(s.calls('plan', 'a').length, 1, 'the saved answer for this spec is not asked again');
  assert.match(s.calls('build', 'a')[0]!.prompt, /Planner concerns:[^]*README\.md:1/);
  assert.ok(s.events('a').some((e) => e.event === 'plan-overridden'));
  assert.equal(s.feature('a').status, 'merged');
});

test('needs-split: a FEASIBLE plan over splitWords holds the feature before any build, with its word count and split suggestion', (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'plan:long,plan:split' } });
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(s.calls('plan', 'a').length, 1);
  assert.equal(s.calls('build', 'a').length, 0, 'no builder was started');
  const f = s.feature('a');
  assert.deepEqual([f.status, f.attempts, f.stop, f.planningHold?.cause], ['todo', 0, { attempt: 1, counted: false }, 'needs-split']);
  assert.match(f.planningHold!.evidence[0]!, /plan has 79\d words \(over config\.planner\.splitWords 750\): split the spec/);
  assert.equal(f.planningHold!.evidence[1], 'the planner suggests splitting: the API part and the UI part');
  assert.match(f.planningHold!.evidence[2]!, /plan\.md$/);
  assert.deepEqual([f.plan?.verdict, f.plan?.split], ['FEASIBLE', 'the API part and the UI part']);
  assert.match(readFileSync(join(s.sy('runs'), 'a', 'plan.md'), 'utf8'), /^1\. Add a\.txt[^]*detail detail/);
  assert.match(s.events('a').find((e) => e.event === 'planning-hold')!.detail, /^needs-split \(high\), planner before any build: [^]*No builder was started and no attempt spent/);
  // A spec fix may answer it, like a spec-conflict hold.
  assert.equal(currentFailure(f, { review: f.planningHold!.review, inputs: f.planningHold!.inputs }, []), null);
  // Held until a person releases it; then the unchanged spec builds with the saved plan, without asking the planner again.
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('plan', 'a').length, 1, 'held features are not relaunched');
  assert.equal(s.cli('release', 'a').status, 0);
  const r2 = s.cli('run'); assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(s.calls('plan', 'a').length, 1);
  assert.match(s.calls('build', 'a')[0]!.prompt, /Plan \(from the planner[^]*detail detail/);
  assert.match(s.events('a').find((e) => e.event === 'plan-overridden')!.detail, /needs-split hold was released/);
  assert.equal(s.feature('a').status, 'merged');
});

test('needs-split: a plan under config.planner.splitWords is accepted and built', (t) => {
  const s = setup(t, { features: [F('a')], config: { planner: { splitWords: 900 } }, scenario: { a: 'plan:long' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').planningHold, undefined);
  assert.match(s.calls('build', 'a')[0]!.prompt, /Plan \(from the planner[^]*detail detail/);
  assert.equal(s.feature('a').status, 'merged');
});

test('FEASIBLE: the plan is saved in the run directory (not the repo), prepended to the builder prompt and shown to the evaluator', (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'plan:split' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const [build] = s.calls('build', 'a'), [ev] = s.calls('eval', 'a'), [plan] = s.calls('plan', 'a');
  assert.ok(plan!.args.includes('--permission-mode') && plan!.args[plan!.args.indexOf('--permission-mode') + 1] === 'plan', 'the planner runs read-only');
  assert.match(build!.prompt, /Plan \(from the planner; deviate only if the code proves it wrong, and say so in your final message\):\n1\. Add a\.txt/);
  assert.match(ev!.prompt, /Context only: the plan a read-only planner wrote[^]*1\. Add a\.txt/);
  assert.match(readFileSync(join(s.sy('runs'), 'a', 'plan.md'), 'utf8'), /^1\. Add a\.txt/);
  assert.equal(s.git('ls-tree', '-r', '--name-only', 'main').split('\n').some((p) => /plan/.test(p)), false, 'nothing about the plan is committed');
  assert.deepEqual([s.feature('a').plan?.verdict, s.feature('a').plan?.split], ['FEASIBLE', 'the API part and the UI part']);
  assert.match(s.events('a').find((e) => e.event === 'planned')!.detail, /^FEASIBLE, effort medium; split suggested: the API part and the UI part$/);
  const order = s.events('a').map((e) => e.event === 'prompt' ? `prompt:${e.run?.role}` : e.event).filter((e) => /^(launch|planned|prompt:)/.test(e));
  assert.deepEqual(order, ['launch', 'prompt:planner', 'planned', 'prompt:builder', 'prompt:evaluator']);
});

test('fail soft: garbage, a failed run or a planner that edits the worktree never blocks the build', (t) => {
  const s = setup(t, { features: [F('g'), F('e'), F('w')], scenario: { g: 'plan:garbage', e: 'plan:error', w: 'plan:edit' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const [id, why] of [['g', /^invalid: the first line/], ['e', /^failed: /], ['w', /^refused: the planner changed the worktree/]] as const) {
    assert.equal(s.feature(id).status, 'merged', id);
    assert.equal(s.calls('build', id).length, 1, id);
    assert.doesNotMatch(s.calls('build', id)[0]!.prompt, /Plan \(from the planner/, id);
    assert.match(s.events(id).find((e) => e.event === 'plan')!.detail, why, id);
  }
  assert.equal(s.git('log', '--all', '--format=%s').includes('planner.txt'), false, "the planner's commit was undone");
  assert.equal(existsSync(join(s.repo, 'planner.txt')), false);
});

test('reuse: a retry of the same spec reuses the plan; a changed spec plans again, at high effort after a failed attempt', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 2 }, verdicts: { a: [fail, fail] } });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('build', 'a').length, 2, 'two attempts');
  assert.equal(s.calls('plan', 'a').length, 1, 'one plan for the unchanged spec');
  assert.match(s.calls('build', 'a')[1]!.prompt, /Plan \(from the planner/, 'the retry still gets the plan');
  assert.ok(s.events('a').some((e) => e.event === 'plan-reused'));
  s.setFeature('a', { status: 'todo', attempts: 1, acceptance: ['a.txt exists and says hello'] });
  assert.equal(s.cli('run').status, 0);
  const plans = s.calls('plan', 'a');
  assert.equal(plans.length, 2, 'the edited spec was planned again');
  assert.equal(plans[1]!.args[plans[1]!.args.indexOf('--effort') + 1], 'high', 'after a failed attempt the planner thinks harder');
});

test('cap and switch: maxPerDay and enabled:false skip the planner, and the build goes on without a plan', (t) => {
  const s = setup(t, { features: [F('a'), F('b', { priority: 2 })], config: { maxParallel: 1, planner: { maxPerDay: 1 } } });
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.calls('plan', 'a').length + s.calls('plan', 'b').length, 1);
  assert.match(s.events('b').find((e) => e.event === 'plan-skipped')!.detail, /daily cap is reached \(1 of config\.planner\.maxPerDay 1/);
  assert.equal(s.feature('b').status, 'merged');
  const off = setup(t, { features: [F('c')], config: { planner: { enabled: false } } });
  assert.equal(off.cli('run').status, 0);
  assert.equal(off.calls('plan', 'c').length, 0);
  assert.match(off.events('c').find((e) => e.event === 'plan-skipped')!.detail, /off/);
});

test("EFFORT high selects the profile's effortHigh for the builder (fable-sonnet), and is recorded as the run's rule", (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'plan:high' } });
  assert.equal(s.cli('profile', 'fable-sonnet').status, 0);
  assert.equal(s.cli('run').status, 0);
  const [b] = s.calls('build', 'a');
  assert.equal(b!.args[b!.args.indexOf('--effort') + 1], 'high');
  const run = s.events('a').find((e) => e.event === 'prompt' && e.run?.role === 'builder')!.run!;
  assert.match(run.rule ?? '', /^planner: EFFORT high → the profile's effortHigh high/);
});
