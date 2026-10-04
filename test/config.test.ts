import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, loadConfig, loadState, load, readControlFile, writeControl } from '../lib/state.ts';
import { observerConfig } from '../lib/observe.ts';
import { startDash, type ProjectState } from '../lib/dash.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-config-'));
  mkdirSync(join(root, '.fact-os'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, '.fact-os/config.json');
  const set = (raw: unknown) => writeFileSync(config, JSON.stringify(raw));
  return { root, config, set };
}

test('config: missing/default/partial configs retain existing replacement and nested defaults', (t) => {
  const s = setup(t);
  assert.equal(loadConfig(s.root).maxParallel, 3);
  s.set({});
  assert.equal(loadConfig(s.root).worktreesDir, `../${s.root.split('/').at(-1)}-worktrees`);
  s.set({ maxParallel: 0, maxRefreshes: 0, budgetUsdPerRun: 0, budgetUsdTotal: 0,
    timeoutMin: 0.01, branchPrefix: '', builder: { model: 'future-provider' }, evaluator: {}, resolver: {},
    claims: { minScore: 0.5, days: 0 }, groupBy: 'legacy-ignored', restoreFrom: 'fixed-ref',
    postMerge: '', prepare: '', mergeHook: '', futureMetadata: { ignored: true },
    profiles: { custom: { builder: { model: 'custom', effort: 'future-effort' } } },
    observer: { maxRetries: 0, maxOpenImprovements: 0, improveEveryHours: 0, curateEveryHours: 0,
      agent: {}, promptReview: { maxPerPass: 0, maxPerDay: 0, everyMinutes: 0 } } });
  const c = loadConfig(s.root);
  assert.deepEqual(c.builder, { model: 'future-provider' });
  assert.deepEqual(c.evaluator, {});
  assert.deepEqual(c.resolver, {});
  assert.deepEqual(c.claims, { minScore: 0.5, days: 0 });
  const o = observerConfig(c);
  assert.equal(o.pollSec, 60);
  assert.equal(o.promptReview.enabled, true);
  assert.equal(o.promptReview.notesMaxBytes, 3000);
  assert.equal(o.promptReview.maxPerPass, 0);
  s.set({ maxParallel: 64, budgetUsdPerRun: 0.015, observer: { pollSec: 0.5 } });
  assert.equal(loadConfig(s.root).maxParallel, 64, 'config does not inherit control lanes cap');
});

test('config: present non-object JSON roots cannot become default configuration', (t) => {
  const s = setup(t);
  for (const raw of [null, [], [DEFAULT_CONFIG], true, 3, 'main']) {
    s.set(raw);
    assert.throws(() => loadConfig(s.root), /config.*object/, JSON.stringify(raw));
  }
});

test('config: operational numbers reject strings, nonfinite values and invalid ranges', (t) => {
  const s = setup(t);
  const cases: [string, unknown[]][] = [
    ['maxParallel', ['oops', null, true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]],
    ['maxAttempts', ['oops', null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]],
    ['maxRefreshes', ['oops', null, -1, 0.5]],
    ['budgetUsdPerRun', ['3', -1, false]], ['budgetUsdTotal', ['3', -1, false]],
    ['timeoutMin', ['3', 0, -1, false, (2 ** 31) / 60000]],
  ];
  for (const [key, values] of cases) for (const value of values) {
    s.set({ [key]: value });
    assert.throws(() => loadConfig(s.root), new RegExp(`config\\.${key}`), `${key}=${JSON.stringify(value)}`);
  }
  for (const key of ['maxParallel', 'maxAttempts', 'maxRefreshes', 'budgetUsdPerRun', 'budgetUsdTotal', 'timeoutMin']) {
    writeFileSync(s.config, `{"${key}":1e309}`);
    assert.throws(() => loadConfig(s.root), new RegExp(`config\\.${key}`));
  }
  s.set({ timeoutMin: (2 ** 31 - 2) / 60000 });
  assert.ok(loadConfig(s.root).timeoutMin);
});

test('config: known strings, arrays, flags and nullable commands have runtime shapes', (t) => {
  const s = setup(t);
  for (const [key, value] of [
    ['base', ' '], ['worktreesDir', 42], ['lessonsFile', null], ['branchPrefix', false], ['test', ''],
    ['merge', 'automatic'], ['refreshBeforeTest', 'false'], ['conflictBrief', 1],
    ['briefFiles', 'README.md'], ['briefFiles', ['README.md', 3]], ['evaluatorDiffExclude', [null]],
    ['prepare', 3], ['postMerge', false], ['mergeHook', []], ['groupBy', {}], ['restoreFrom', true],
  ] as const) {
    s.set({ [key]: value });
    assert.throws(() => loadConfig(s.root), new RegExp(`config\\.${key}`));
  }
});

test('config: nested partial objects validate provided fields without silent fallbacks', (t) => {
  const s = setup(t);
  const bad: [unknown, string][] = [
    [{ builder: null }, 'builder'], [{ evaluator: [] }, 'evaluator'], [{ resolver: [] }, 'resolver'],
    [{ builder: { model: 1 } }, 'builder.model'], [{ resolver: { effort: ' ' } }, 'resolver.effort'],
    [{ evaluator: { permissionMode: false } }, 'evaluator.permissionMode'], [{ claims: [] }, 'claims'],
    [{ claims: { hot: 'src/' } }, 'claims.hot'], [{ claims: { days: -1 } }, 'claims.days'],
    [{ claims: { minScore: '3' } }, 'claims.minScore'], [{ observer: null }, 'observer'],
    [{ observer: [] }, 'observer'], [{ observer: { agent: [] } }, 'observer.agent'],
    [{ observer: { retry: 'false' } }, 'observer.retry'], [{ observer: { improve: 1 } }, 'observer.improve'],
    [{ observer: { maxRetries: 0.5 } }, 'observer.maxRetries'], [{ observer: { recurring: 0 } }, 'observer.recurring'],
    [{ observer: { pollSec: 0 } }, 'observer.pollSec'], [{ observer: { pollSec: '60' } }, 'observer.pollSec'],
    [{ observer: { lessonsMaxBytes: 0 } }, 'observer.lessonsMaxBytes'],
    [{ observer: { maxOpenImprovements: -1 } }, 'observer.maxOpenImprovements'],
    [{ observer: { infraPatterns: [''] } }, 'observer.infraPatterns'],
    [{ observer: { curateEveryHours: -1 } }, 'observer.curateEveryHours'],
    [{ observer: { improveEveryHours: '6' } }, 'observer.improveEveryHours'],
    [{ observer: { promptReview: null } }, 'observer.promptReview'],
    [{ observer: { promptReview: [] } }, 'observer.promptReview'],
    [{ observer: { promptReview: { enabled: 'false' } } }, 'observer.promptReview.enabled'],
    [{ observer: { promptReview: { maxPerPass: 0.5 } } }, 'observer.promptReview.maxPerPass'],
    [{ observer: { promptReview: { maxPerDay: -1 } } }, 'observer.promptReview.maxPerDay'],
    [{ observer: { promptReview: { notesMaxBytes: 0 } } }, 'observer.promptReview.notesMaxBytes'],
    [{ observer: { promptReview: { everyMinutes: -1 } } }, 'observer.promptReview.everyMinutes'],
    [{ profiles: { opus: {}, x: { builder: { model: 1 } } } }, 'profiles.opus'],
  ];
  for (const [raw, field] of bad) {
    s.set(raw);
    assert.throws(() => loadConfig(s.root), new RegExp(`config\\.${field.replaceAll('.', '\\.')}`), JSON.stringify(raw));
  }
  writeFileSync(s.config, '{"observer":{"pollSec":1e309}}');
  assert.throws(() => loadConfig(s.root), /config\.observer\.pollSec/);
});

function project(t: TestContext) {
  const s = setup(t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: s.root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: s.root });
  const feature = { id: 'a', title: 'A', description: 'A', acceptance: ['works'], surface: 'any', deps: [], priority: 1,
    status: 'todo', attempts: 0, updatedAt: '' };
  const features = join(s.root, '.fact-os/features.json');
  writeFileSync(features, JSON.stringify({ features: [feature] }));
  writeFileSync(join(s.root, '.fact-os/human.json'), '{"tasks":[]}');
  const marker = join(s.root, '.fact-os/provider-started');
  const provider = join(s.root, 'fake-provider');
  writeFileSync(provider, `#!/bin/sh\nprintf started > '${marker}'\nprintf '{}'
`, { mode: 0o755 });
  const cli = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: s.root,
    env: { ...process.env, FACTOS_CLAUDE: provider, SHIPYARD_CLAUDE: provider }, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  return { ...s, set: (raw: Record<string, unknown>) => s.set({ worktreesDir: '.fact-os/worktrees', ...raw }), features, marker, cli };
}

test('config: doctor reports both malformed limits from the shared runtime boundary', (t) => {
  const s = project(t); s.set({ test: 'true', maxParallel: 'oops', maxAttempts: 'oops' });
  const r = s.cli('doctor');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /config\.maxParallel/);
  assert.match(r.stdout, /config\.maxAttempts/);
  assert.equal(existsSync(s.marker), false, 'doctor only resolves provider executable');
});

for (const key of ['maxParallel', 'maxAttempts']) test(`config: invalid ${key} refuses a run before state changes or providers`, (t) => {
  const s = project(t); s.set({ test: 'true', [key]: 'oops' });
  const before = readFileSync(s.features, 'utf8');
  const r = s.cli('run', '--once');
  assert.equal(existsSync(s.marker), false, r.stdout + r.stderr);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`config\\.${key}`));
  assert.equal(readFileSync(s.features, 'utf8'), before);
  assert.equal(existsSync(join(s.root, '.fact-os/runs')), false);
  assert.equal(existsSync(join(s.root, '.fact-os/log.jsonl')), false);
  assert.equal(existsSync(join(s.root, '.fact-os/.foreman')), false);
});

test('config: dashboard exposes invalid config and refuses a control write without changing it', async (t) => {
  const s = project(t); s.set({ maxParallel: 'oops' });
  const dash = await startDash({ root: s.root, port: 0 });
  t.after(() => dash.server.close());
  const state = await (await fetch(dash.url + '/api/state')).json() as { projects: ProjectState[] };
  assert.match(state.projects[0].error!, /config\.maxParallel/);
  const control = join(s.root, '.fact-os/control.json');
  writeFileSync(control, '{"paused":true}');
  const r = await fetch(dash.url + '/api/control/resume', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: s.root }) });
  assert.equal(r.status, 500);
  assert.equal(readFileSync(control, 'utf8'), '{"paused":true}');
});

test('config: emergency pause/lanes primitive still works with invalid config; profile changes refuse', async (t) => {
  const s = setup(t); s.set({ maxAttempts: 'oops' });
  await writeControl(s.root, { paused: true, maxParallel: 0 }, 'cli');
  const before = readControlFile(s.root);
  assert.ok(before.ok && before.control.paused && before.control.maxParallel === 0);
  await assert.rejects(writeControl(s.root, { profile: 'fable-sonnet' }, 'cli'), /config\.maxAttempts/);
  assert.deepEqual(readControlFile(s.root), before);
});


test('config: state-only reads leave the validated supervisor config snapshot independent', (t) => {
  const s = project(t); s.set({ maxAttempts: 'oops' });
  assert.equal(loadState(s.root).features[0].id, 'a');
  assert.deepEqual(loadState(s.root).tasks, []);
  assert.throws(() => load(s.root), /config\.maxAttempts/, 'normal consumers still validate config');
});

test('I01: gateFixes is a safe integer >= 0 and diagnoser is null or role settings; both default off', (t) => {
  const s = setup(t);
  s.set({});
  assert.deepEqual([loadConfig(s.root).gateFixes, loadConfig(s.root).diagnoser], [0, null]);
  assert.equal(loadConfig(s.root).commitFixes, 0);
  for (const value of ['1', -1, 0.5]) { s.set({ commitFixes: value }); assert.throws(() => loadConfig(s.root), /config\.commitFixes/); }
  s.set({});
  for (const value of ['1', -1, 1.5, null, true]) {
    s.set({ gateFixes: value });
    assert.throws(() => loadConfig(s.root), /config\.gateFixes/, `gateFixes=${JSON.stringify(value)}`);
  }
  for (const value of ['opus', [], { model: '' }, { effort: 3 }]) {
    s.set({ diagnoser: value });
    assert.throws(() => loadConfig(s.root), /config\.diagnoser/, `diagnoser=${JSON.stringify(value)}`);
  }
  s.set({ gateFixes: 2, diagnoser: { model: 'opus', effort: 'high' } });
  assert.deepEqual([loadConfig(s.root).gateFixes, loadConfig(s.root).diagnoser], [2, { model: 'opus', effort: 'high' }]);
  s.set({ diagnoser: null });
  assert.equal(loadConfig(s.root).diagnoser, null);
});

test('I02: only the evaluator and the diagnoser can use Codex; codex settings keep their defaults when partial', (t) => {
  const s = setup(t);
  s.set({ evaluator: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, diagnoser: { provider: 'codex', model: 'gpt-6.1-sol' } });
  assert.equal(loadConfig(s.root).evaluator.provider, 'codex');
  for (const key of ['builder', 'resolver']) {
    s.set({ [key]: { provider: 'codex', model: 'gpt-6.1-sol' } });
    assert.throws(() => loadConfig(s.root), new RegExp(`config\\.${key}\\.provider`), key);
  }
  s.set({ evaluator: { provider: 'openai' } });
  assert.throws(() => loadConfig(s.root), /config\.evaluator\.provider/);
  s.set({ codex: { cooldownMin: 5 } });
  assert.deepEqual(loadConfig(s.root).codex, { fallback: { model: 'opus', effort: 'high' }, cooldownMin: 5 });
  for (const codex of [{ cooldownMin: -1 }, { fallback: { provider: 'codex' } }, 'x']) {
    s.set({ codex });
    assert.throws(() => loadConfig(s.root), /config\.codex/, JSON.stringify(codex));
  }
});
