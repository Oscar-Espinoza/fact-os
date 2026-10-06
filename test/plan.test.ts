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
import { infeasibleText, parsePlan, planSkip, plannerRunsSince, plannerPrompt, revise, revisionProblem } from '../lib/plan.ts';
import { plannedEffort, plannerRole, profileProblems } from '../lib/profiles.ts';
import { DEFAULT_CONFIG, loadConfig } from '../lib/state.ts';
import { builderPrompt, evaluatorPrompt, holdInputs, planSection } from '../lib/foreman.ts';
import { candidates, currentFailure } from '../lib/specfix.ts';
import type { Config, Feature, FeaturesFile, LogEvent, Verdict } from '../lib/types.ts';
import { reap } from './reap.ts';
import { buildStory } from '../lib/story.ts';

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

test('parsePlan: INFEASIBLE keeps every numbered conflict; what is off the contract is noted, never a reason to build', () => {
  const ok = parsePlan('VERDICT: INFEASIBLE\nEFFORT: medium\nSPLIT: no\nCONFLICTS\n1. "no runtime change" vs "fail safely": lib/pay.ts:40 throws.\n   Resolutions: allow a change.\n2) src/x.tsx:7 has no such export');
  assert.ok(!('error' in ok) && ok.verdict === 'INFEASIBLE');
  assert.deepEqual(ok.items, [{ text: '"no runtime change" vs "fail safely": lib/pay.ts:40 throws.', severity: null, resolution: 'allow a change.' },
    { text: 'src/x.tsx:7 has no such export', severity: null, resolution: null }]);
  assert.deepEqual(ok.conflicts, ['[protected?] "no runtime change" vs "fail safely": lib/pay.ts:40 throws.\nResolution: allow a change.', '[protected?] src/x.tsx:7 has no such export']);
  assert.deepEqual([ok.revised, ok.auto], [null, false]);
  assert.ok(ok.malformed.includes('conflict 1 has no [protected] or [spec-only] tag (treated as protected)'));
  assert.ok(ok.malformed.includes('conflict 2 gives no Resolution'));
  assert.ok(ok.malformed.includes('no COMPLETE REVISED SPEC section'));
  const vague = parsePlan('VERDICT: INFEASIBLE\nEFFORT: medium\nSPLIT: no\nCONFLICTS\n1. the spec is vague');
  assert.ok(!('error' in vague) && vague.verdict === 'INFEASIBLE' && vague.malformed.includes('conflict 1 quotes no file:line evidence'));
  const none = parsePlan('VERDICT: INFEASIBLE\nEFFORT: medium\nSPLIT: no\nit cannot be done');
  assert.ok(!('error' in none) && none.verdict === 'INFEASIBLE');
  assert.deepEqual([none.conflicts, none.malformed[0]], [['[protected?] it cannot be done'], 'INFEASIBLE without a numbered CONFLICTS list']);
});

const MULTI = (sev2: string, auto: string) => [
  'VERDICT: INFEASIBLE', 'EFFORT: high', 'SPLIT: no', 'CONFLICTS',
  '1. [spec-only] Acceptance 2 (cleanup deletes stale rows) vs acceptance 4 (rows are owned by the importer): lib/import.ts:12 "owner = importer".',
  '   Resolution: acceptance 2 -> "cleanup marks stale rows archived"',
  `2. [${sev2}] Acceptance 2 vs the DB grants: packages/platform/src/grants/app.sql:7 "GRANT SELECT, UPDATE ON rows".`,
  '   Resolution: description "The cleanup job deletes stale rows." -> "The cleanup job archives stale rows."',
  '3. [spec-only] Acceptance 3 vs nested AGENTS.md: apps/api/AGENTS.md:4 "never call the clock directly".',
  '   Resolution: acceptance 3 -> "the cleanup takes the time as an argument"',
  '', '## COMPLETE REVISED SPEC', 'Description changes:', '- OLD: The cleanup job deletes stale rows.', '  NEW: The cleanup job archives stale rows.',
  'Acceptance:', '1. stale means older than 30 days', '2. cleanup marks stale rows archived', '   and leaves the rest', '3. the cleanup takes the time as an argument',
  '4. rows are owned by the importer', `AUTO: ${auto}`].join('\n');

test('parsePlan: every conflict with its severity, resolution and evidence, and the complete revised spec (AUTO yes only when all are spec-only)', () => {
  const p = parsePlan(MULTI('spec-only', 'yes'));
  assert.ok(!('error' in p) && p.verdict === 'INFEASIBLE');
  assert.equal(p.items.length, 3);
  assert.deepEqual(p.items.map((c) => c.severity), ['spec-only', 'spec-only', 'spec-only']);
  assert.equal(p.items[1]!.resolution, 'description "The cleanup job deletes stale rows." -> "The cleanup job archives stale rows."');
  assert.match(p.conflicts[0]!, /^\[spec-only\] Acceptance 2 [^]*lib\/import\.ts:12[^]*\nResolution: acceptance 2 -> "cleanup marks stale rows archived"$/);
  assert.deepEqual(p.revised, { description: [{ old: 'The cleanup job deletes stale rows.', new: 'The cleanup job archives stale rows.' }],
    acceptance: ['stale means older than 30 days', 'cleanup marks stale rows archived and leaves the rest', 'the cleanup takes the time as an argument', 'rows are owned by the importer'], auto: true });
  assert.deepEqual([p.auto, p.malformed], [true, []]);
  const text = infeasibleText({ conflicts: p.conflicts, revised: p.revised, auto: p.auto });
  assert.ok(text.indexOf('3. [spec-only]') < text.indexOf('Proposed revised spec'), 'the conflicts first, then the revised spec');
  assert.match(text, /Proposed revised spec\nDescription changes:\n- OLD: The cleanup job deletes stale rows\.\n  NEW: The cleanup job archives[^]*\nAcceptance:\n1\. stale[^]*4\. rows are owned by the importer\n\nAUTO: yes$/);
  // revise: the description sentence replaced in place, the acceptance list replaced whole; an OLD sentence not in the description is refused
  const f = { description: 'Nightly. The cleanup job deletes stale rows. Keep logs.' };
  assert.deepEqual(revise(f, p.revised!), { description: 'Nightly. The cleanup job archives stale rows. Keep logs.', acceptance: p.revised!.acceptance });
  assert.equal(revisionProblem(f, p.revised!), null);
  assert.match(revisionProblem({ description: 'Something else.' }, p.revised!)!, /no sentence "The cleanup job deletes/);
});

test('parsePlan: a protected conflict means AUTO no, even when the planner says yes; untagged counts as protected', () => {
  const prot = parsePlan(MULTI('protected', 'no'));
  assert.ok(!('error' in prot) && prot.verdict === 'INFEASIBLE');
  assert.deepEqual([prot.items[1]!.severity, prot.auto, prot.revised?.auto, prot.malformed], ['protected', false, false, []]);
  const lie = parsePlan(MULTI('protected', 'yes'));
  assert.ok(!('error' in lie) && lie.verdict === 'INFEASIBLE');
  assert.equal(lie.auto, false);
  assert.match(lie.malformed.join(), /AUTO: yes, but 1 conflict is not tagged spec-only/);
  const untagged = parsePlan(MULTI('spec-only', 'yes').replace('[spec-only] Acceptance 3', 'Acceptance 3'));
  assert.ok(!('error' in untagged) && untagged.verdict === 'INFEASIBLE' && untagged.auto === false && untagged.items[2]!.severity === null);
  const noAuto = parsePlan(MULTI('spec-only', 'yes').replace(/\nAUTO: yes$/, ''));
  assert.ok(!('error' in noAuto) && noAuto.verdict === 'INFEASIBLE' && noAuto.auto === false && noAuto.malformed.includes('no "AUTO: yes|no" line (treated as no)'));
});

test('parsePlan: a malformed INFEASIBLE answer is still a hold, with its raw text', () => {
  const p = parsePlan('**VERDICT: INFEASIBLE**\nEFFORT: medium\nthe rules collide');
  assert.ok(!('error' in p) && p.verdict === 'INFEASIBLE');
  assert.deepEqual([p.conflicts, p.revised, p.auto], [['[protected?] **VERDICT: INFEASIBLE**\nEFFORT: medium\nthe rules collide'], null, false]);
  assert.match(p.malformed[0]!, /first line/);
  const noRevised = parsePlan(MULTI('spec-only', 'yes').replace(/\nAcceptance:[^]*$/, '\nAUTO: yes'));
  assert.ok(!('error' in noRevised) && noRevised.verdict === 'INFEASIBLE' && noRevised.revised === null && noRevised.auto === false && noRevised.items.length === 3);
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
    assert.equal(DEFAULT_CONFIG.planner.autoApply, false);
    for (const bad of [{ autoApply: 'yes' }, { enabled: 'yes' }, { maxPerDay: -1 }, { skipBelow: 'easy' }, { permissionMode: 'auto' }, { effort: '' }, { splitWords: 0 }, { splitWords: 1.5 }, { splitWords: '750' }]) {
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
  assert.match(pp, /find EVERY conflict in this one pass before you answer; never stop at the first/);
  assert.match(pp, /\(a\) the code[^]*\(b\)[^]*packages\/platform\/src\/grants[^]*nested AGENTS\.md[^]*'must not change'[^]*\(c\) every OTHER acceptance line[^]*pairwise/);
  assert.match(pp, /listing ALL of them/);
  assert.match(pp, /1\. \[protected \| spec-only\][^]*file:line[^]*Resolution: <ONE recommended resolution/);
  assert.match(pp, /money, auth or sessions, tenant isolation, grants or RLS, migrations, production behaviour, or would weaken an existing test/);
  assert.match(pp, /COMPLETE REVISED SPEC[^]*Description changes:[^]*- OLD:[^]*NEW:[^]*Acceptance:[^]*AUTO: yes \| no/);
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
  assert.match(readFileSync(join(s.sy('runs'), 'a', 'plan.md'), 'utf8'), /^1\. \[protected\?\] "no runtime change"[^]*No usable revised spec/);
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
  const planned = s.events('a').find((e) => e.event === 'planned')!, plannerRun = s.events('a').find((e) => e.event === 'prompt' && e.run?.role === 'planner')!.run;
  assert.deepEqual(planned.run, plannerRun, 'the planned event names the planner\'s own model and effort');
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

// ---- every conflict at once, the revised spec, plan-apply and config.planner.autoApply ----

test('multi-conflict: every conflict is held with its severity, the revised spec is saved and shown, and plan-apply applies it', (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'plan:multi,plan:once' } });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('build', 'a').length, 0);
  const f = s.feature('a'), h = f.planningHold!;
  assert.equal(h.cause, 'spec-conflict');
  assert.equal(h.evidence.length, 2);
  assert.match(h.evidence[0]!, /^\[spec-only\] Acceptance 1 [^]*README\.md:1[^]*\nResolution: description "Build a" -> "Build a as a plain file"$/);
  assert.match(h.evidence[1]!, /^\[spec-only\] /);
  assert.equal(h.auto, true);
  assert.match(h.revised!, /^Description changes:\n- OLD: Build a\n  NEW: Build a as a plain file\n\nAcceptance:\n1\. a\.txt exists and is kept\n2\. a\.txt says hello\n\nAUTO: yes$/);
  const dir = join(s.sy('runs'), 'a'), saved = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  assert.deepEqual(saved.revised.acceptance, ['a.txt exists and is kept', 'a.txt says hello']);
  assert.equal(saved.auto, true);
  assert.match(readFileSync(join(dir, 'plan-revised-spec.md'), 'utf8'), /^Description changes:[^]*AUTO: yes\n$/);
  const md = readFileSync(join(dir, 'plan.md'), 'utf8');
  assert.ok(md.indexOf('2. [spec-only]') < md.indexOf('Proposed revised spec'), 'plan.md: the conflicts first, then the revised spec');
  const hold = s.events('a').find((e) => e.event === 'planning-hold')!.detail;
  assert.match(hold, /^spec-conflict \(high\), planner before any build: 1\. \[spec-only\][^]* 2\. \[spec-only\][^]*2 conflicts \(0 protected, 2 spec-only\)\. Proposed revised spec: [^ ]*plan-revised-spec\.md \(AUTO: yes; `fact-os plan-apply a` applies it\)/);
  // The dashboard's Needs you card: the conflicts, then the revised spec and the command.
  const story = buildStory({ feature: f, events: [], runs: [], maxAttempts: 3, base: 'main' });
  assert.deepEqual([story.needsYou?.what, story.needsYou?.conflicts, story.needsYou?.revised, story.needsYou?.apply],
    ['Review and apply the revised spec', h.evidence, h.revised, 'fact-os plan-apply a']);
  assert.match(story.state.why!, /planner found 2 conflicts/);
  // A person applies it: description sentence and acceptance replaced, attempts reset, hold released, audited like a spec fix.
  const r = s.cli('plan-apply', 'a'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const g = s.feature('a');
  assert.deepEqual([g.description, g.acceptance, g.attempts, g.planningHold, g.stop], ['Build a as a plain file', ['a.txt exists and is kept', 'a.txt says hello'], 0, undefined, undefined]);
  assert.equal(g.planRevisions?.[0]?.by, 'person');
  assert.deepEqual(g.planRevisions?.[0]?.old, { description: 'Build a', acceptance: ['a.txt exists'] });
  const changed = s.events('a').find((e) => e.event === 'acceptance-changed')!;
  assert.equal(changed.attemptsReset, true);
  assert.match(changed.detail, /planner revised spec \(plan \S+\) applied by a person: 1 description sentence and the acceptance list \(1 → 2 lines\), resolving 2 spec-only conflicts/);
  assert.ok(s.events('a').some((e) => e.event === 'plan-applied' && /^person: /.test(e.detail)));
  assert.match(s.cli('plan-apply', 'a').stderr, /not on the planner's spec-conflict hold/, 'applied once');
  // The revised spec is planned again (FEASIBLE now) and built.
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.calls('plan', 'a').length, 2);
  assert.equal(s.feature('a').status, 'merged');
});

test('plan-apply refuses AUTO: no (a protected conflict) and a spec edited since the plan', (t) => {
  const s = setup(t, { features: [F('p'), F('q')], scenario: { p: 'plan:protected', q: 'plan:multi' } });
  assert.equal(s.cli('run').status, 2);
  const p = s.feature('p');
  assert.deepEqual([p.planningHold?.auto, /^\[protected\] /.test(p.planningHold!.evidence[1]!)], [false, true]);
  assert.match(s.events('p').find((e) => e.event === 'planning-hold')!.detail, /1 protected, 1 spec-only[^]*AUTO: no; a person must edit the spec/);
  const story = buildStory({ feature: p, events: [], runs: [], maxAttempts: 3, base: 'main' });
  assert.deepEqual([story.needsYou?.what, story.needsYou?.apply], ['Resolve the protected conflicts', undefined]);
  const r = s.cli('plan-apply', 'p');
  assert.equal(r.status, 1); assert.match(r.stderr, /AUTO is no: a conflict is protected/);
  assert.deepEqual(s.feature('p').acceptance, ['p.txt exists'], 'nothing changed');
  s.setFeature('q', { acceptance: ['q.txt exists', 'edited by a person'] });
  const r2 = s.cli('plan-apply', 'q');
  assert.equal(r2.status, 1); assert.match(r2.stderr, /the spec or its inputs changed since the plan/);
  assert.equal(s.events('q').some((e) => e.event === 'plan-applied'), false);
});

test('autoApply: an AUTO yes revision is applied by the foreman and planned again (FEASIBLE: built); one automatic round per feature; off by default', (t) => {
  const s = setup(t, { features: [F('a'), F('b'), F('c')], config: { planner: { autoApply: true } }, scenario: { a: 'plan:multi,plan:once', b: 'plan:multi', c: 'plan:protected' } });
  assert.equal(s.cli('run').status, 2);
  // a: applied, relaunched, confirmed FEASIBLE, merged
  assert.equal(s.calls('plan', 'a').length, 2);
  assert.ok(s.events('a').some((e) => e.event === 'plan-applied' && /^auto: /.test(e.detail)));
  assert.match(s.events('a').find((e) => e.event === 'plan-auto-applied')!.detail, /planner runs again on the revised spec/);
  assert.match(s.events('a').find((e) => e.event === 'acceptance-changed')!.detail, /applied automatically \(config\.planner\.autoApply\)/);
  assert.deepEqual([s.feature('a').status, s.feature('a').acceptance, s.feature('a').planRevisions?.[0]?.by], ['merged', ['a.txt exists and is kept', 'a.txt says hello'], 'auto']);
  // b: still INFEASIBLE after its one automatic round: held for a person
  assert.equal(s.calls('plan', 'b').length, 2);
  assert.equal(s.feature('b').planningHold?.cause, 'spec-conflict');
  assert.match(s.events('b').find((e) => e.event === 'plan-auto-refused')!.detail, /already had its one automatic revision/);
  assert.equal(s.calls('build', 'b').length, 0);
  // c: a protected conflict is never applied automatically
  assert.equal(s.calls('plan', 'c').length, 1);
  assert.equal(s.events('c').some((e) => /^plan-(auto|applied)/.test(e.event)), false);
  // default: off; the AUTO yes revision waits for a person
  const off = setup(t, { features: [F('d')], scenario: { d: 'plan:multi,plan:once' } });
  assert.equal(off.cli('run').status, 2);
  assert.equal(off.calls('plan', 'd').length, 1);
  assert.equal(off.feature('d').planningHold?.auto, true);
  assert.equal(off.events('d').some((e) => /^plan-(auto|applied)/.test(e.event)), false);
});

test('malformed INFEASIBLE: the feature is held with the raw answer; plan-apply has nothing to apply', (t) => {
  const s = setup(t, { features: [F('m')], scenario: { m: 'plan:malformed' }, config: { planner: { autoApply: true } } });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('build', 'm').length, 0);
  const h = s.feature('m').planningHold!;
  assert.deepEqual([h.cause, h.auto, h.revised], ['spec-conflict', false, undefined]);
  assert.match(h.evidence[0]!, /^\[protected\?\] The cleanup rule and the ownership rule cannot both hold/);
  assert.match(s.events('m').find((e) => e.event === 'planning-hold')!.detail, /No usable revised spec was proposed\. Off the answer format: INFEASIBLE without a numbered CONFLICTS list/);
  const r = s.cli('plan-apply', 'm');
  assert.equal(r.status, 1); assert.match(r.stderr, /no usable revised spec/);
});
