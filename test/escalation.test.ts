// I07 escalation: unsure review questions go to a strictly read-only agent (fake Codex / fake Claude; no real providers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, inputHash, classifierState, questionsFor, readRecords, BATTERY, SCHEMA, POLICY_VERSION } from '../lib/classifier.ts';
import { escalate, readEscalations, selectCandidates, derive, claudeReadOnlyArgs, codexReadOnlyArgs, runBounded } from '../lib/escalation.ts';
import { CLASSIFIER_DEFAULTS, ESCALATION_DEFAULTS, DEFAULT_CONFIG, loadConfig, writeJsonAtomic } from '../lib/state.ts';
import type { EscalationConfig, Feature } from '../lib/types.ts';

const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-agent.ts');
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Refund screen ${id}`, description: `Build ${id}`, acceptance: [`${id} works`],
  surface: 'api', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });
const esc = (o: Partial<EscalationConfig> = {}): EscalationConfig => ({ ...ESCALATION_DEFAULTS, enabled: true, timeoutMin: 1, ...o });
const answersFor = (f: Feature, over: Record<string, number>) => Object.fromEntries(Object.keys(questionsFor(f)).map((q) => [q, over[q] ?? 0.05]));

// A git project with one committed source file, a config, features and a Jev assessment record for each feature.
function project(t: { after: (fn: () => void) => void }, features: { f: Feature; over: Record<string, number> }[]) {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-esc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('-c', 'init.defaultBranch=main', 'init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'refunds.ts'), 'export function refund() {\n  return writeLedger();\n}\n');
  g('add', '.'); g('commit', '-q', '-m', 'base');
  writeFileSync(join(root, 'untracked-secret.txt'), 'not in the snapshot');
  mkdirSync(join(root, '.fact-os'));
  writeFileSync(join(root, '.fact-os', 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, test: 'true', classifier: { provider: 'typesafe' } }));
  const fs = features.map((x) => x.f);
  writeJsonAtomic(join(root, '.fact-os', 'features.json'), { features: fs });
  for (const { f, over } of features) {
    const answers = answersFor(f, over), state = classifierState(f, fs, null), q = questionsFor(f);
    writeFileSync(join(root, '.fact-os', 'classifier.jsonl'), JSON.stringify({ schema: SCHEMA, ts: new Date().toISOString(), feature: f.id, purpose: 'test', battery: BATTERY.version,
      inputHash: inputHash(CLASSIFIER_DEFAULTS.model, state, q), policy: POLICY_VERSION, scorer: null, tier: f.tier ?? null, requestedModel: CLASSIFIER_DEFAULTS.model,
      attempts: 1, elapsedMs: 1, status: 'assessed', answers, assessment: assess(f, answers, fs, null) }) + '\n', { flag: 'a' });
  }
  return root;
}
function fakeAgents(t: { after: (fn: () => void) => void }, spec: object) {
  const dir = mkdtempSync(join(tmpdir(), 'fact-os-fake-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'agent'); writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`); chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
  const prev = { codex: process.env.FACTOS_CODEX, claude: process.env.FACTOS_CLAUDE, s: process.env.FAKE_AGENT_SPEC, l: process.env.FAKE_AGENT_LOG };
  Object.assign(process.env, { FACTOS_CODEX: bin, FACTOS_CLAUDE: bin, FAKE_AGENT_SPEC: join(dir, 'spec.json'), FAKE_AGENT_LOG: join(dir, 'log.jsonl') });
  t.after(() => { for (const [k, v] of [['FACTOS_CODEX', prev.codex], ['FACTOS_CLAUDE', prev.claude], ['FAKE_AGENT_SPEC', prev.s], ['FAKE_AGENT_LOG', prev.l]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  return { calls: () => existsSync(join(dir, 'log.jsonl')) ? readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [] };
}
const run = (root: string, ids: string[], e = esc()) => { const config = loadConfig(root); return escalate(root, config, config.classifier!, e, ids, () => {}); };

test('escalation: Codex runs read-only on a snapshot of tracked files at the base commit', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  const fake = fakeAgents(t, { codex: { values: { s02_funds_effect: true } } });
  const [rec] = await run(root, ['a']);
  assert.equal(rec!.status, 'completed'); assert.equal(rec!.provider, 'codex'); assert.equal(rec!.labelStatus, 'model_proposal_unadjudicated');
  const c = fake.calls()[0]!;
  assert.ok(c.args.includes('--sandbox') && c.args[c.args.indexOf('--sandbox') + 1] === 'read-only');
  for (const bad of ['workspace-write', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox']) assert.ok(!c.args.includes(bad), bad);
  assert.ok(!c.args.join(' ').includes('network_access')); assert.ok(c.args.includes('--ephemeral')); assert.ok(c.args.includes('--output-schema')); assert.ok(c.args.includes('--skip-git-repo-check'));
  assert.notEqual(c.cwd, root, 'never the live checkout');
  assert.equal(rec!.baseSha, spawnSync('git', ['rev-parse', 'main'], { cwd: root, encoding: 'utf8' }).stdout.trim());
  assert.deepEqual(rec!.derivation!.reviewProposals, [{ axis: 's02_funds_effect', source: 'agent' }]); assert.equal(rec!.derivation!.candidateTier, 'risky');
});

test('escalation: the snapshot holds tracked files only and is removed afterwards', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  const dir = mkdtempSync(join(tmpdir(), 'probe-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, 'agent'); writeFileSync(probe, `#!/bin/sh\nls -a > "${dir}/listing"; ls .fact-os 2>/dev/null >> "${dir}/listing"; exit 1\n`); chmodSync(probe, 0o755);
  const prev = process.env.FACTOS_CODEX; process.env.FACTOS_CODEX = probe; t.after(() => { if (prev === undefined) delete process.env.FACTOS_CODEX; else process.env.FACTOS_CODEX = prev; });
  await run(root, ['a'], esc({ timeoutMin: 0.2 }));
  const listing = readFileSync(join(dir, 'listing'), 'utf8');
  assert.match(listing, /src/); assert.doesNotMatch(listing, /untracked-secret|\.fact-os|\.git\b/);
});

test('escalation: false clears only an uncertain axis with spec evidence; a Jev floor stays; unknown stays uncertain', () => {
  const f = F('a'), ans = answersFor(f, { s01_authoritative_amount: 0.85, s05_authorization: 0.95, s06_tenant_binding: 0.5 });
  const parent = assess(f, ans, [f], null);
  const d = derive(parent, ans, { answers: {
    s01_authoritative_amount: { value: false, reason: 'r', evidence: [{ kind: 'spec', field: 'feature.title', itemIndex: null, quote: 'Refund' }] },
    s05_authorization: { value: false, reason: 'r', evidence: [{ kind: 'spec', field: 'feature.title', itemIndex: null, quote: 'Refund' }] },
    s06_tenant_binding: { value: 'unknown', reason: 'ownership not stated', evidence: [] } } });
  assert.deepEqual(d.resolvedFalse, ['s01_authoritative_amount']); assert.deepEqual(d.insufficient, ['s05_authorization']);
  assert.deepEqual(d.stillUncertain, ['s06_tenant_binding']); assert.equal(d.candidateTier, 'risky', 'the >= .9 Jev floor is untouched');
});

test('escalation: forged spec quotes, mismatched blobs and missing ids are rejected; a verified repo quote is accepted', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  fakeAgents(t, { codex: { values: { s02_funds_effect: true }, evidence: 'forged' } });
  let [rec] = await run(root, ['a']); assert.equal(rec!.status, 'invalid'); assert.match(rec!.reason!, /spec quote not found/);
  const blob = spawnSync('git', ['rev-parse', 'main:src/refunds.ts'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  fakeAgents(t, { codex: { values: { s02_funds_effect: true }, evidence: { repo: { kind: 'repo', path: 'src/refunds.ts', blobOid: '0'.repeat(40), startLine: 2, endLine: 2, quote: 'writeLedger' } } } });
  [rec] = await run(root, ['a']); assert.match(rec!.reason!, /blob id does not match/);
  fakeAgents(t, { codex: { values: { s02_funds_effect: true }, evidence: { repo: { kind: 'repo', path: 'src/refunds.ts', blobOid: blob, startLine: 1, endLine: 1, quote: 'writeLedger' } } } });
  [rec] = await run(root, ['a']); assert.match(rec!.reason!, /repo quote not found in the cited lines/);
  fakeAgents(t, { codex: { values: { s02_funds_effect: true }, evidence: { repo: { kind: 'repo', path: 'src/refunds.ts', blobOid: blob, startLine: 2, endLine: 2, quote: 'writeLedger' } } } });
  [rec] = await run(root, ['a']); assert.equal(rec!.status, 'completed');
  fakeAgents(t, { codex: { raw: '{"version":"i07-escalation-v1"}' } });
  const root2 = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  [rec] = await run(root2, ['a']); assert.equal(rec!.status, 'invalid');
});

test('escalation: an unavailable Codex cools down and falls back once to a read-only Claude that a bypass config cannot weaken', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  const fake = fakeAgents(t, { codex: { exit: 1, stderr: 'You have hit your usage limit' }, claude: { values: { s02_funds_effect: false } } });
  const config = loadConfig(root); (config.codex.fallback as any).permissionMode = 'bypassPermissions';
  const [rec] = await escalate(root, config, config.classifier!, esc(), ['a'], () => {});
  assert.equal(rec!.status, 'completed'); assert.equal(rec!.provider, 'claude'); assert.equal(rec!.fallback, true); assert.equal(rec!.starts, 2); assert.equal(rec!.costUsd, 0.42);
  assert.ok(existsSync(join(root, '.fact-os', 'codex.json')), 'Codex cools down for later runs');
  const c = fake.calls()[1]!.args as string[];
  for (const need of ['--restricted', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(c.includes(need), need);
  assert.equal(c[c.indexOf('--tools') + 1], 'Read,Grep,Glob'); assert.equal(c[c.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(c[c.indexOf('--max-budget-usd') + 1], '2'); assert.ok(!c.includes('bypassPermissions'));
  assert.deepEqual(claudeReadOnlyArgs(config, esc(), {}).filter((a) => a === 'bypassPermissions'), []);
  // While Codex cools down, the next run goes straight to the fallback.
  const root2 = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  writeFileSync(join(root2, '.fact-os', 'codex.json'), JSON.stringify({ until: new Date(Date.now() + 60e3).toISOString() }));
  const before = fake.calls().length;
  const [r2] = await run(root2, ['a']);
  assert.equal(r2!.provider, 'claude'); assert.equal(fake.calls().slice(before).filter((x) => x.provider === 'codex').length, 0);
});

test('escalation: a valid unknown or a malformed answer never triggers the fallback', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  let fake = fakeAgents(t, { codex: { values: { s02_funds_effect: 'unknown' } } });
  let [rec] = await run(root, ['a']);
  assert.equal(rec!.status, 'completed'); assert.deepEqual(rec!.derivation!.stillUncertain, ['s02_funds_effect']);
  assert.equal(fake.calls().filter((c) => c.provider === 'claude').length, 0);
  const root2 = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  fake = fakeAgents(t, { codex: { raw: 'not json' } });
  [rec] = await run(root2, ['a']);
  assert.equal(rec!.status, 'invalid'); assert.equal(fake.calls().filter((c) => c.provider === 'claude').length, 0);
});

test('escalation: per-run and per-day caps count agent starts; a completed assessment is not repeated', async (t) => {
  const a = F('a'), b = F('b'), root = project(t, [{ f: a, over: { s02_funds_effect: 0.5 } }, { f: b, over: { s05_authorization: 0.6 } }]);
  const fake = fakeAgents(t, { codex: { values: {} } });
  await run(root, ['a', 'b'], esc({ maxPerRun: 1 }));
  assert.equal(fake.calls().length, 1);
  await run(root, ['a', 'b'], esc({ maxPerRun: 5, maxPerDay: 2 }));
  assert.equal(fake.calls().length, 2, 'the completed one is cached; the other uses the last daily slot');
  const recs = await run(root, ['a', 'b'], esc({ maxPerRun: 5, maxPerDay: 2 }));
  assert.equal(fake.calls().length, 2); assert.equal(recs.length, 0);
});

test('escalation: selection skips a person\'s tier and quality-only scope, prioritises conflicts, caps questions and keeps the rest unresolved', () => {
  const mk = (f: Feature, over: Record<string, number>) => { const answers = answersFor(f, over);
    return { schema: 2, feature: f.id, status: 'assessed', tier: f.tier ?? null, inputHash: f.id, answers, assessment: assess(f, answers, [f], null) } as any; };
  const human = F('h', { tier: 'normal' }), scope = F('s'), refund = F('r', { title: 'Refund flow', description: 'Refund a payment' }), plain = F('p', { title: 'Page', description: 'x' });
  const { selected, skipped } = selectCandidates([mk(human, { s01_authoritative_amount: 0.5 }), mk(scope, { s01_authoritative_amount: 0.5, u04_quality_only_acceptance: 0.9 }),
    mk(plain, { s01_authoritative_amount: 0.45, s02_funds_effect: 0.3, s04_stock_authority: 0.6 }), mk(refund, { s07_sensitive_data: 0.4 })], esc({ maxQuestions: 2 }));
  assert.deepEqual(skipped.map((s) => s.feature), ['h', 's']);
  assert.deepEqual(selected.map((c) => c.feature), ['r', 'p'], 'a protected conflict comes first');
  assert.deepEqual(selected[1]!.questions, ['s01_authoritative_amount', 's04_stock_authority']); assert.deepEqual(selected[1]!.deferred, ['s02_funds_effect']);
});

test('escalation: a feature edited during the agent run is recorded stale; features and Jev records are never written', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  const jevBefore = readRecords(root);
  fakeAgents(t, { codex: { values: { s02_funds_effect: true }, touch: [join(root, '.fact-os', 'features.json'), { features: [{ ...f, description: 'edited' }] }] } });
  const [rec] = await run(root, ['a']);
  assert.equal(rec!.status, 'stale');
  assert.equal(JSON.parse(readFileSync(join(root, '.fact-os', 'features.json'), 'utf8')).features[0].description, 'edited');
  assert.deepEqual(readRecords(root), jevBefore); assert.equal(readEscalations(root).length, 1);
});

test('escalation: the deadline kills the agent\'s whole process group and waits for it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fact-os-bounded-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const started = Date.now();
  const r = await runBounded('sh', ['-c', `sleep 30 & echo $! > "${dir}/child"; wait`], dir, '', 300);
  assert.equal(r.timedOut, true); assert.ok(Date.now() - started < 5000);
  const child = Number(readFileSync(join(dir, 'child'), 'utf8'));
  await Bun.sleep(100);
  assert.throws(() => process.kill(child, 0), 'the grandchild is gone too');
  const big = await runBounded('sh', ['-c', 'yes x | head -c 3000000'], dir, '', 5000);
  assert.equal(big.oversized, true);
});

test('escalation: config validation and the Codex read-only arguments', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-esc-cfg-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os')); mkdirSync(join(root, '.git'));
  const set = (e: object) => writeFileSync(join(root, '.fact-os', 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, test: 'true', classifier: { provider: 'typesafe', escalation: e } }));
  set({}); assert.deepEqual(loadConfig(root).classifier!.escalation, ESCALATION_DEFAULTS); assert.equal(ESCALATION_DEFAULTS.enabled, false);
  for (const bad of [{ maxQuestions: 0 }, { maxQuestions: 12 }, { timeoutMin: 61 }, { fallbackMaxBudgetUsd: 0 }, { enabled: 'yes' }, { maxPerRun: -1 }]) {
    set(bad); assert.throws(() => loadConfig(root), /config\.classifier\.escalation/, JSON.stringify(bad));
  }
  const a = codexReadOnlyArgs(ESCALATION_DEFAULTS, 's.json', 'o.txt');
  assert.deepEqual(a.slice(0, 3), ['exec', '-m', 'gpt-6.1-sol']); assert.ok(a.includes('model_reasoning_effort="high"'));
});
