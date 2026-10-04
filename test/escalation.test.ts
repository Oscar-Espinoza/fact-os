// I07 escalation: unsure review questions go to a strictly read-only agent (fake Codex / fake Claude; no real providers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, inputHash, classifierState, questionsFor, readRecords, BATTERY, SCHEMA, POLICY_VERSION } from '../lib/classifier.ts';
import { escalate, readEscalations, selectCandidates, derive, claudeReadOnlyArgs, codexReadOnlyArgs, runBounded, categorize, cleanUsage, escalationSummary } from '../lib/escalation.ts';
import { CLASSIFIER_DEFAULTS, ESCALATION_DEFAULTS, DEFAULT_CONFIG, loadConfig, withLock, writeJsonAtomic } from '../lib/state.ts';
import type { EscalationConfig, Feature, HumanTask } from '../lib/types.ts';

const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-agent.ts');
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Refund screen ${id}`, description: `Build ${id}`, acceptance: [`${id} works`],
  surface: 'api', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });
const esc = (o: Partial<EscalationConfig> = {}): EscalationConfig => ({ ...ESCALATION_DEFAULTS, enabled: true, timeoutMin: 1, ...o });
const answersFor = (f: Feature, over: Record<string, number>) => Object.fromEntries(Object.keys(questionsFor(f)).map((q) => [q, over[q] ?? 0.05]));
const g = (root: string, ...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });

// A git project with committed source (and optional extra committed files), a config, features and a Jev assessment per feature.
function project(t: { after: (fn: () => void) => void }, features: { f: Feature; over: Record<string, number> }[], o: { tracked?: Record<string, string>; tasks?: HumanTask[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-esc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  g(root, '-c', 'init.defaultBranch=main', 'init', '-q'); g(root, 'config', 'user.email', 't@t'); g(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'refunds.ts'), 'export function refund() {\n  return writeLedger();\n}\n');
  for (const [p, body] of Object.entries(o.tracked ?? {})) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), body); }
  g(root, 'add', '-f', '.'); g(root, 'commit', '-q', '-m', 'base');
  writeFileSync(join(root, 'untracked-secret.txt'), 'not in the snapshot');
  mkdirSync(join(root, '.fact-os'), { recursive: true });
  writeFileSync(join(root, '.fact-os', 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, test: 'true', classifier: { provider: 'typesafe' } }));
  const fs = features.map((x) => x.f);
  writeJsonAtomic(join(root, '.fact-os', 'features.json'), { features: fs });
  writeJsonAtomic(join(root, '.fact-os', 'human.json'), { tasks: o.tasks ?? [] });
  for (const { f, over } of features) {
    const answers = answersFor(f, over), state = classifierState(f, fs, null), q = questionsFor(f);
    writeFileSync(join(root, '.fact-os', 'classifier.jsonl'), JSON.stringify({ schema: SCHEMA, ts: new Date().toISOString(), feature: f.id, purpose: 'test', battery: BATTERY.version,
      inputHash: inputHash(CLASSIFIER_DEFAULTS.model, state, q), policy: POLICY_VERSION, scorer: null, tier: f.tier ?? null, authority: { tier: f.tier ?? null, risk: f.risk ?? null },
      requestedModel: CLASSIFIER_DEFAULTS.model, attempts: 1, elapsedMs: 1, status: 'assessed', answers, assessment: assess(f, answers, fs, null) }) + '\n', { flag: 'a' });
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
const run = (root: string, ids: string[], e = esc(), signal?: AbortSignal) => { const config = loadConfig(root); return escalate(root, config, config.classifier!, e, ids, () => {}, signal); };
const terminal = <T extends { status: string }>(recs: T[]) => recs.filter((r) => r.status !== 'started');

test('escalation: Codex runs read-only, without user config, on a snapshot of allowed tracked files at the base commit (V301)', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  const fake = fakeAgents(t, { codex: { values: { s02_funds_effect: true } } });
  const [rec] = terminal(await run(root, ['a']));
  assert.equal(rec!.status, 'completed'); assert.equal(rec!.provider, 'codex'); assert.equal(rec!.labelStatus, 'model_proposal_unadjudicated');
  const c = fake.calls()[0]!;
  assert.equal(c.args[c.args.indexOf('--sandbox') + 1], 'read-only');
  for (const need of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--output-schema']) assert.ok(c.args.includes(need), need);
  for (const bad of ['workspace-write', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox']) assert.ok(!c.args.includes(bad), bad);
  assert.ok(!c.args.join(' ').includes('network_access')); assert.notEqual(c.cwd, root, 'never the live checkout');
  assert.equal(rec!.baseSha, g(root, 'rev-parse', 'main').stdout.trim());
  assert.deepEqual(rec!.derivation!.reviewProposals, [{ axis: 's02_funds_effect', source: 'agent' }]); assert.equal(rec!.derivation!.candidateTier, 'risky');
});

test('escalation: the snapshot excludes untracked files, factory state, credentials and symlinks, even when tracked (V309)', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }], { tracked: { '.shipyard/classifier.jsonl': 'answers', 'deploy/.env': 'SECRET=1', 'keys/server.pem': 'k' } });
  symlinkSync('/etc/passwd', join(root, 'escape')); g(root, 'add', 'escape'); g(root, 'commit', '-q', '-m', 'link');
  const dir = mkdtempSync(join(tmpdir(), 'probe-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, 'agent'); writeFileSync(probe, `#!/bin/sh\nfind . > "${dir}/listing"; exit 1\n`); chmodSync(probe, 0o755);
  const prev = process.env.FACTOS_CODEX; process.env.FACTOS_CODEX = probe; t.after(() => { if (prev === undefined) delete process.env.FACTOS_CODEX; else process.env.FACTOS_CODEX = prev; });
  const prevC = process.env.FACTOS_CLAUDE; process.env.FACTOS_CLAUDE = '/bin/false'; t.after(() => { if (prevC === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prevC; });
  await run(root, ['a'], esc({ timeoutMin: 0.2 }));
  const listing = readFileSync(join(dir, 'listing'), 'utf8');
  assert.match(listing, /src\/refunds\.ts/);
  for (const bad of ['untracked-secret', '.shipyard', '.env', 'server.pem', 'escape', '.git/']) assert.ok(!listing.includes(bad), bad);
});

test('escalation: repo evidence must cite an allowed snapshot file with an exact quote; the parent attaches the blob id (V309)', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }], { tracked: { '.shipyard/notes.md': 'refund writes the ledger' } });
  fakeAgents(t, { codex: { values: { s02_funds_effect: true }, evidence: { repo: { kind: 'repo', path: '.shipyard/notes.md', startLine: 1, endLine: 1, quote: 'refund' } } } });
  let [rec] = terminal(await run(root, ['a'])); assert.equal(rec!.status, 'invalid'); assert.match(rec!.reason!, /not an allowed file/);
  fakeAgents(t, { codex: { values: { s02_funds_effect: true }, evidence: { repo: { kind: 'repo', path: 'src/refunds.ts', startLine: 2, endLine: 2, quote: '  writeLedger  ' } } } });
  [rec] = terminal(await run(root, ['a'])); assert.match(rec!.reason!, /not found exactly/);
  fakeAgents(t, { codex: { values: { s02_funds_effect: true }, evidence: 'forged' } });
  [rec] = terminal(await run(root, ['a'])); assert.match(rec!.reason!, /spec quote not found exactly/);
  fakeAgents(t, { codex: { values: { s02_funds_effect: true }, evidence: { repo: { kind: 'repo', path: 'src/refunds.ts', startLine: 2, endLine: 2, quote: 'writeLedger' } } } });
  [rec] = terminal(await run(root, ['a'])); assert.equal(rec!.status, 'completed');
  const repoRef = rec!.response!.answers.s02_funds_effect!.evidence.find((e) => e.kind === 'repo') as any;
  assert.equal(repoRef.blobOid, g(root, 'rev-parse', 'main:src/refunds.ts').stdout.trim());
});

test('escalation: an agent false is a disagreement and never clears uncertainty; true adds a proposal; unknown stays (V302)', () => {
  const f = F('a'), ans = answersFor(f, { s01_authoritative_amount: 0.85, s05_authorization: 0.95, s06_tenant_binding: 0.5 });
  const parent = assess(f, ans, [f], null), spec = [{ kind: 'spec' as const, field: 'feature.title', itemIndex: null, quote: 'Refund' }];
  const d = derive(parent, { answers: { s01_authoritative_amount: { value: false, reason: 'r', evidence: spec }, s05_authorization: { value: false, reason: 'r', evidence: spec },
    s06_tenant_binding: { value: 'unknown', reason: 'ownership not stated', evidence: [] }, u03_unverified_external_contract: { value: true, reason: 'r', evidence: spec } } });
  assert.deepEqual(d.disagreements, ['s01_authoritative_amount', 's05_authorization']); assert.deepEqual(d.stillUncertain, ['s06_tenant_binding']);
  assert.deepEqual(d.contextAnswers, { u03_unverified_external_contract: true }); assert.equal(d.candidateTier, 'risky', 'the >= .9 Jev floor is untouched');
});

test('escalation: an unavailable Codex cools down (fixed reason) and falls back once to a read-only Claude; usage is per start and sanitized (V311)', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  const fake = fakeAgents(t, { codex: { exit: 1, stderr: 'You have hit your usage limit (secret-sentinel)', usage: { input_tokens: 12345, debug_auth: 'secret-sentinel' } },
    claude: { values: { s02_funds_effect: 'unknown' }, usage: { input_tokens: 1, output_tokens: -3, note: 'secret-sentinel' }, cost: 0.42 } });
  const config = loadConfig(root); (config.codex.fallback as any).permissionMode = 'bypassPermissions';
  const [rec] = terminal(await escalate(root, config, config.classifier!, esc(), ['a'], () => {}));
  assert.equal(rec!.status, 'completed'); assert.equal(rec!.provider, 'claude'); assert.equal(rec!.fallback, true);
  assert.deepEqual(rec!.startsLog.map((s) => [s.provider, s.category]), [['codex', 'unavailable'], ['claude', 'answered']]);
  assert.deepEqual(rec!.startsLog[0]!.usage, { input_tokens: 12345 }); assert.deepEqual(rec!.startsLog[1]!.usage, { input_tokens: 1 }); assert.equal(rec!.startsLog[1]!.costUsd, 0.42);
  const cool = JSON.parse(readFileSync(join(root, '.fact-os', 'codex.json'), 'utf8'));
  assert.equal(cool.reason, 'codex account unavailable (escalation)');
  assert.doesNotMatch(readFileSync(join(root, '.fact-os', 'classifier.jsonl'), 'utf8'), /secret-sentinel/);
  const c = fake.calls()[1]!.args as string[];
  for (const need of ['--restricted', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(c.includes(need), need);
  assert.equal(c[c.indexOf('--tools') + 1], 'Read,Grep,Glob'); assert.equal(c[c.indexOf('--permission-mode') + 1], 'plan'); assert.ok(!c.includes('bypassPermissions'));
  assert.deepEqual(claudeReadOnlyArgs(config, esc(), {}).filter((a) => a === 'bypassPermissions'), []);
  assert.deepEqual(cleanUsage({ input_tokens: 5, output_tokens: 1.5, x: 1 }), { input_tokens: 5 });
});

test('escalation: a read-only violation, oversized output or invalid answer never falls back (V308, V310)', async (t) => {
  const f = F('a');
  for (const [codex, want] of [[{ exit: 1, stderr: 'read-only violation: denied attempted write' }, 'policy'], [{ lastBytes: 600 * 1024 }, 'oversized'],
    [{ stdoutBytes: 600 * 1024 }, 'oversized'], [{ raw: 'not json' }, 'invalid'], [{ values: { s02_funds_effect: 'unknown' } }, 'completed']] as const) {
    const root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
    const fake = fakeAgents(t, { codex, claude: { values: { s02_funds_effect: true } } });
    const [rec] = terminal(await run(root, ['a']));
    assert.equal(fake.calls().filter((c) => c.provider === 'claude').length, 0, JSON.stringify(codex).slice(0, 60));
    assert.ok(rec!.status === want || rec!.reason === want, `${JSON.stringify(codex).slice(0, 40)} → ${rec!.status} ${rec!.reason}`);
  }
  assert.equal(categorize({ cancelled: false, oversized: false, timedOut: false, err: 'connection reset' }, null), 'transport');
});

test('escalation: the per-run cap counts the fallback; deferred and started states are journaled (V303, V316)', async (t) => {
  const a = F('a'), b = F('b'), root = project(t, [{ f: a, over: { s02_funds_effect: 0.5 } }, { f: b, over: { s05_authorization: 0.6 } }]);
  const fake = fakeAgents(t, { codex: { exit: 1, stderr: 'connection reset' }, claude: { values: {} } });
  const recs = await run(root, ['a', 'b'], esc({ maxPerRun: 1 }));
  assert.equal(fake.calls().length, 1, 'no fallback when the per-run cap is spent');
  assert.deepEqual(recs.map((r) => [r.feature, r.status]), [['a', 'started'], ['a', 'unavailable'], ['b', 'deferred']]);
  assert.match(escalationSummary(root)!, /1 unavailable, 1 deferred/);
});

test('escalation: per-day caps count starts; a completed assessment is reused, re-derived locally when only the derivation changed (V312)', async (t) => {
  const a = F('a'), b = F('b'), root = project(t, [{ f: a, over: { s02_funds_effect: 0.5 } }, { f: b, over: { s05_authorization: 0.6 } }]);
  const fake = fakeAgents(t, { codex: { values: {} } });
  await run(root, ['a', 'b'], esc({ maxPerRun: 1 }));
  await run(root, ['a', 'b'], esc({ maxPerRun: 5, maxPerDay: 2 }));
  assert.equal(fake.calls().length, 2);
  assert.equal(terminal(await run(root, ['a', 'b'], esc({ maxPerRun: 5, maxPerDay: 2 }))).length, 0);
  // A different fallback model is a different requested identity: asked again.
  const config = loadConfig(root); (config.codex.fallback as any).model = 'sonnet';
  await escalate(root, config, config.classifier!, esc({ maxPerDay: 10 }), ['a'], () => {});
  assert.equal(fake.calls().length, 3);
});

test('escalation: selection skips a person\'s tier and quality-only scope, prioritises conflicts, then repository-resolvable context, caps questions (V313)', () => {
  const mk = (f: Feature, over: Record<string, number>) => { const answers = answersFor(f, over);
    return { schema: 2, feature: f.id, status: 'assessed', tier: f.tier ?? null, authority: { tier: f.tier ?? null, risk: f.risk ?? null }, inputHash: f.id, answers, assessment: assess(f, answers, [f], null) } as any; };
  const human = F('h', { tier: 'normal' }), scope = F('s'), refund = F('r', { title: 'Refund flow', description: 'Refund a payment' }), plain = F('p', { title: 'Page', description: 'x' });
  const ctxOnly = F('x', { title: 'Provider adapter', description: 'Use the adapter contract' });
  const { selected, skipped } = selectCandidates([mk(human, { s01_authoritative_amount: 0.5 }), mk(scope, { s01_authoritative_amount: 0.5, u04_quality_only_acceptance: 0.9 }),
    mk(plain, { s01_authoritative_amount: 0.45, s02_funds_effect: 0.3, s04_stock_authority: 0.6 }), mk(refund, { s07_sensitive_data: 0.4 }),
    mk(ctxOnly, { u03_unverified_external_contract: 0.9 })], esc({ maxQuestions: 2 }));
  assert.deepEqual(skipped.map((s) => s.feature), ['h', 's']);
  assert.deepEqual(selected.map((c) => c.feature), ['r', 'x', 'p']);
  assert.deepEqual(selected[1]!.questions, ['u03_unverified_external_contract']);
  assert.deepEqual(selected[2]!.questions, ['s01_authoritative_amount', 's04_stock_authority']); assert.deepEqual(selected[2]!.deferred, ['s02_funds_effect']);
});

test('escalation: planning review receives the frozen conjunctions and their question criteria (V313)', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { c01_new_lifecycle: 0.95, c06_shared_contract: 0.95 } }]);
  const dir = mkdtempSync(join(tmpdir(), 'prompt-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, 'agent'); writeFileSync(probe, `#!/bin/sh\ncat > "${dir}/prompt"; exit 1\n`); chmodSync(probe, 0o755);
  for (const k of ['FACTOS_CODEX', 'FACTOS_CLAUDE']) { const p = process.env[k]; process.env[k] = k === 'FACTOS_CODEX' ? probe : '/bin/false'; t.after(() => { if (p === undefined) delete process.env[k]; else process.env[k] = p; }); }
  await run(root, ['a'], esc({ reviewPlanning: true, timeoutMin: 0.2 }));
  const prompt = readFileSync(join(dir, 'prompt'), 'utf8');
  assert.match(prompt, /newLifecycleCoordination/); assert.match(prompt, /c01_new_lifecycle/); assert.doesNotMatch(prompt, /0\.95/, 'no Jev probabilities');
});

test('escalation: a feature, its authority, glossary or human tasks changed during the run are recorded stale; an out-of-date parent is not escalated (V304)', async (t) => {
  const f = F('a');
  for (const touch of [(r: string) => [join(r, '.fact-os', 'features.json'), { features: [{ ...f, risk: 'high' }] }],
    (r: string) => [join(r, '.fact-os', 'human.json'), { tasks: [{ id: 'h1', title: 'Provider ownership', steps: [], unblocks: ['a'], mockable: false, status: 'open' }] }]]) {
    const root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
    fakeAgents(t, { codex: { values: { s02_funds_effect: true }, touch: touch(root) } });
    const [rec] = terminal(await run(root, ['a']));
    assert.equal(rec!.status, 'stale');
  }
  const root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  writeJsonAtomic(join(root, '.fact-os', 'features.json'), { features: [{ ...f, tier: 'hard' }] });
  const fake = fakeAgents(t, { codex: { values: {} } });
  const lines: string[] = [];
  const config = loadConfig(root);
  await escalate(root, config, config.classifier!, esc(), ['a'], (s) => lines.push(s));
  assert.equal(fake.calls().length, 0); assert.ok(lines.some((l) => /assessment is out of date/.test(l)));
  assert.equal(readRecords(root).length, 1, 'the Jev record is never rewritten');
});

test('escalation: overlapping runs never pay twice for a completed assessment (V305)', async (t) => {
  const a = F('a'), b = F('b'), root = project(t, [{ f: a, over: { s02_funds_effect: 0.5 } }, { f: b, over: { s05_authorization: 0.6 } }]);
  const fake = fakeAgents(t, { codex: { values: {}, sleepMs: 300 } });
  const first = run(root, ['a']);
  await Bun.sleep(100);
  await Promise.all([first, run(root, ['b', 'a'])]);
  assert.deepEqual(fake.calls().length, 2, `a once, b once: ${JSON.stringify(fake.calls().map((c) => [c.provider, c.pid]))}`);
  assert.equal(readEscalations(root).filter((e) => e.feature === 'a' && e.status === 'completed').length, 1);
});

test('escalation: waiting for the lock counts against the deadline; an expired assessment starts nothing (V306)', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  const fake = fakeAgents(t, { codex: { values: {} } });
  const holder = withLock(root, () => Bun.sleep(1500));
  await Bun.sleep(30);
  const recs = await run(root, ['a'], esc({ timeoutMin: 0.01 }));
  await holder;
  assert.equal(fake.calls().length, 0); assert.match(recs[0]!.reason!, /deadline/);
});

test('escalation: cancellation kills the agent, records cancelled and never falls back (V307)', async (t) => {
  const f = F('a'), root = project(t, [{ f, over: { s02_funds_effect: 0.5 } }]);
  const fake = fakeAgents(t, { codex: { values: {}, sleepMs: 20_000 }, claude: { values: {} } });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const started = Date.now();
  const [rec] = terminal(await run(root, ['a'], esc(), ac.signal));
  assert.equal(rec!.status, 'cancelled'); assert.ok(Date.now() - started < 5000);
  assert.equal(fake.calls().filter((c) => c.provider === 'claude').length, 0);
  const pid = fake.calls()[0]!.pid; assert.throws(() => process.kill(pid, 0), 'the agent process is gone');
});

test('escalation: the deadline includes termination: a SIGTERM-resistant group is killed by the deadline; output is byte-bounded (V306, V310)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fact-os-bounded-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const started = Date.now();
  const r = await runBounded('sh', ['-c', `trap '' TERM; sleep 30 & echo $! > "${dir}/child"; wait`], dir, '', Date.now() + 500);
  assert.equal(r.timedOut, true); assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  await Bun.sleep(100);
  assert.throws(() => process.kill(Number(readFileSync(join(dir, 'child'), 'utf8')), 0), 'the grandchild is gone too');
  const big = await runBounded('sh', ['-c', 'yes x | head -c 3000000'], dir, '', Date.now() + 5000);
  assert.equal(big.oversized, true); assert.ok(Buffer.byteLength(big.out) <= 512 * 1024);
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

test('escalation: the report summary tolerates records from older escalation versions', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-esc-sum-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os')); mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.fact-os', 'classifier.jsonl'), JSON.stringify({ schema: 2, kind: 'escalation', assessmentId: 'old', status: 'completed', deferred: [],
    derivation: { reviewProposals: [], resolvedFalse: ['s01'] } }) + '\n');
  assert.match(escalationSummary(root)!, /1 completed/);
});
