// End-to-end scenarios where the builder, the evaluator or the checkout misbehave. Uses fixtures/fake-claude.ts.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { procStart, holdInputs, failureId } from '../lib/foreman.ts';
import { startDash, conflictTimeline, type ProjectState } from '../lib/dash.ts';
import { agentStats, observeOnce } from '../lib/observe.ts';
import { passesOf } from '../lib/promptreview.ts';
import type { Config, Feature, FeaturesFile, LogEvent, Verdict } from '../lib/types.ts';
import { reap } from './reap.ts';
import { mutate, writeControl, loadConfig } from '../lib/state.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id}.txt exists`],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });

interface FakeCall { mode: string; id: string; t0: number; t1: number; prompt: string; args: string[]; model?: string; effort?: string; provider?: string }
function setup(t: TestContext, { features, config = {}, scenario = {}, verdicts = {} }:
  { features: Feature[]; config?: Partial<Config>; scenario?: Record<string, string>; verdicts?: Record<string, Partial<Verdict>[]> }) {
  const base = mkdtempSync(join(tmpdir(), 'fact-os-guard-'));
  const repo = join(base, 'app');
  t.after(() => { reap(repo, join(base, 'pids')); rmSync(base, { recursive: true, force: true }); });
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.'); git('commit', '-qm', 'init');
  chmodSync(FAKE, 0o755);
  const env = { ...process.env, FACTOS_CLAUDE: FAKE, FACTOS_POLL_MS: '100', FAKE_DELAY_MS: '50',
    FAKE_LOG: join(base, 'fake.jsonl'), FAKE_VERDICTS: join(base, 'verdicts.json'), FAKE_PIDS: join(base, 'pids'),
    FAKE_SCENARIO: JSON.stringify(scenario) };
  // SIGKILL on timeout: a stuck run may ignore SIGTERM (spawnSync's default) and outlive the test.
  const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(cli('init', '--test', 'true').status, 0);
  const sy = (f: string) => join(repo, '.fact-os', f);
  writeFileSync(sy('config.json'), JSON.stringify({ ...JSON.parse(readFileSync(sy('config.json'), 'utf8')), ...config }));
  writeFileSync(sy('features.json'), JSON.stringify({ features }));
  writeFileSync(env.FAKE_VERDICTS, JSON.stringify(verdicts));
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return {
    repo, env, git, cli,
    feature: (id: string) => (JSON.parse(read(sy('features.json'))) as FeaturesFile).features.find((f) => f.id === id)!,
    log: () => read(sy('log.jsonl')),
    calls: (mode: string, id: string) => read(env.FAKE_LOG).split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeCall).filter((c) => c.mode === mode && c.id === id),
    pids: () => read(env.FAKE_PIDS).split('\n').filter(Boolean).map(Number),
    start: (...a: string[]) => {
      const cp = spawn(process.execPath, [BIN, 'run', ...a], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; cp.stdout.on('data', (d) => { out += d; }); cp.stderr.on('data', (d) => { out += d; });
      t.after(() => cp.exitCode === null && cp.kill('SIGKILL'));
      return { cp, exit: new Promise<number | null>((r) => cp.on('exit', (code) => r(code))), out: () => out };
    },
  };
}
const until = async (cond: () => unknown, ms = 10000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await sleep(50); return cond(); };

test('R16: fresh launch clears old stop metadata before the fake builder starts', (t) => {
  const s = setup(t, { features: [{ ...F('a'), stop: { attempt: 1, counted: true } }], config: { maxAttempts: 1 } });
  const wrapper = join(s.repo, '.fact-os', 'stop-provider.sh'), features = join(s.repo, '.fact-os', 'features.json');
  writeFileSync(wrapper, `#!/bin/sh\nif grep -q '"stop"' '${features}'; then exit 9; fi\nexec '${FAKE}' "$@"\n`, { mode: 0o755 });
  s.env.FACTOS_CLAUDE = wrapper;
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').stop], ['merged', 0, undefined]);
});

test('R16: refresh exhaustion after one counted failure logs an uncounted second try', (t) => {
  const s = setup(t, { features: [F('a', { branch: 'ship/a', refreshes: 5, attempts: 1 })] });
  conflict(s, 'a', { branch: 'from a\n', main: 'from main\n' });
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').attempts, s.feature('a').stop], [1, { attempt: 2, counted: false }]);
  const stop = s.log().trim().split('\n').map((line) => JSON.parse(line) as LogEvent).find((e) => e.event === 'stuck')!;
  assert.deepEqual(stop.stop, { attempt: 2, counted: false });
  assert.equal(s.calls('build', 'a').length, 1);
});

test('R16: counted builder failure persists matching feature and event metadata', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 }, scenario: { a: 'noop' } });
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').attempts, s.feature('a').stop], [1, { attempt: 1, counted: true }]);
  const stop = s.log().trim().split('\n').map((line) => JSON.parse(line) as LogEvent).find((e) => e.event === 'stuck')!;
  assert.deepEqual(stop.stop, { attempt: 1, counted: true });
});

// Both initial gates finish before either evaluator returns; each branch tests the same base.
function parallelGate(s: ReturnType<typeof setup>, check: string): void {
  const markers = join(s.repo, '.fact-os', 'gate-markers'), file = join(s.repo, '.fact-os/config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.test = `mkdir -p "${markers}"; touch "${markers}/$FACTOS_FEATURE"; ` +
    `while [ ! -f "${markers}/a" ] || [ ! -f "${markers}/b" ]; do sleep 0.01; done; ${check}`;
  writeFileSync(file, JSON.stringify(config));
  s.env.FAKE_DELAY_MS = '200';
}

test('refreshBeforeTest: incompatible parallel features are retested against the latest base before merge', (t) => {
  const s = setup(t, { features: [F('a'), F('b')], config: { maxParallel: 2, maxAttempts: 1, refreshBeforeTest: true, timeoutMin: 0.1 } });
  parallelGate(s, '[ ! -f a.txt ] || [ ! -f b.txt ]');
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const merged = ['a', 'b'].find((id) => s.feature(id).status === 'merged')!;
  const rejected = merged === 'a' ? 'b' : 'a';
  assert.ok(merged, 'one compatible branch landed');
  assert.deepEqual([s.feature(rejected).status, s.feature(rejected).attempts], ['stuck', 1]);
  assert.equal(s.calls('build', rejected).length, 1, 'clean refresh reuses the build');
  assert.equal(s.calls('eval', rejected).length, 1, 'the failing aggregate gate prevents another evaluation');
  assert.equal(existsSync(join(s.repo, rejected + '.txt')), false, 'the incompatible combination never reaches main');
  const config = JSON.parse(readFileSync(join(s.repo, '.fact-os/config.json'), 'utf8'));
  assert.equal(spawnSync('sh', ['-c', config.test], { cwd: s.repo, env: s.env }).status, 0, 'main still passes the same gate');
});

test('refreshBeforeTest: compatible parallel features get fresh evaluation without overwriting the first run', (t) => {
  const s = setup(t, { features: [F('a'), F('b')], config: { maxParallel: 2, maxAttempts: 1, refreshBeforeTest: true, timeoutMin: 0.1 },
    scenario: { a: 'acceptance,slow' } });
  parallelGate(s, 'true');
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const revalidated = ['a', 'b'].find((id) => s.calls('eval', id).length === 2)!;
  assert.equal(revalidated, 'a', 'the slower evaluation needs aggregate revalidation');
  for (const call of s.calls('eval', 'a')) {
    assert.match(call.prompt, /- a\.txt exists/);
    assert.doesNotMatch(call.prompt, /nothing to check/);
  }
  for (const id of ['a', 'b']) {
    assert.equal(s.feature(id).status, 'merged');
    assert.equal(s.feature(id).attempts, 0);
    assert.equal(s.calls('build', id).length, 1);
  }
  assert.ok(existsSync(join(s.repo, '.fact-os/runs', revalidated, '1-eval.json')));
  assert.ok(existsSync(join(s.repo, '.fact-os/runs', revalidated, '1.2-eval.json')));
  const other = revalidated === 'a' ? 'b' : 'a';
  assert.equal(s.git('merge-base', '--is-ancestor', s.feature(other).sha!, s.feature(revalidated).sha!), '');
});

test('refreshBeforeTest: stale parked features are revalidated without another builder before merging', (t) => {
  const s = setup(t, { features: [F('a'), F('b')], config: { maxParallel: 2, maxAttempts: 1, refreshBeforeTest: true, timeoutMin: 0.1 } });
  parallelGate(s, '[ ! -f a.txt ] || [ ! -f b.txt ]');
  writeFileSync(join(s.repo, 'README.md'), 'local edit\n');
  assert.equal(s.cli('run').status, 0);
  for (const id of ['a', 'b']) assert.equal(s.feature(id).status, 'ready');
  s.git('checkout', '-q', 'README.md');
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual(['a', 'b'].map((id) => s.feature(id).status).sort(), ['merged', 'stuck']);
  for (const id of ['a', 'b']) assert.equal(s.calls('build', id).length, 1, 'parked builds are reused');
});

test('refreshBeforeTest: passing evaluator lessons are committed after merge without causing another evaluation', (t) => {
  const s = setup(t, { features: [F('a')], config: { refreshBeforeTest: true }, verdicts: { a: [
    { pass: true, findings: [{ check: 'a.txt exists', ok: true, evidence: 'checked' }], cheating: [], lesson: 'Keep aggregate validation current.' },
    { pass: true, findings: [{ check: 'a.txt exists', ok: true, evidence: 'checked again' }], cheating: [], lesson: 'Another distinct lesson.' },
  ] } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls('eval', 'a').length, 1);
  assert.match(readFileSync(join(s.repo, 'CLAUDE.md'), 'utf8'), /Keep aggregate validation current/);
  assert.match(s.git('log', '-1', '--format=%s'), /lesson from a/);
});

const passingLesson = (lesson: string | null): Partial<Verdict> => ({ pass: true,
  findings: [{ check: 'a.txt exists', ok: true, evidence: 'checked' }], lesson });
const seedLessons = (s: ReturnType<typeof setup>) => {
  const file = join(s.repo, 'CLAUDE.md'); writeFileSync(file, '# Instructions\n');
  s.git('add', 'CLAUDE.md'); s.git('commit', '-qm', 'instructions'); return file;
};
const pendingOf = (s: ReturnType<typeof setup>) => s.feature('a').pendingLesson;
const parkWithLesson = (t: TestContext, config: Partial<Config> = {}, later: Partial<Verdict>[] = []) => {
  const s = setup(t, { features: [F('a')], config: { refreshBeforeTest: true, maxAttempts: 1, ...config },
    verdicts: { a: [passingLesson('Original accepted lesson.'), ...later] } });
  const file = seedLessons(s); writeFileSync(join(s.repo, 'README.md'), 'local edit\n');
  const initial = s.git('rev-parse', 'main'), r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(s.feature('a').status, 'ready');
  return { s, file, initial };
};

test('R14: a parked passing lesson cannot move base; restart delivers it once without another evaluation', (t) => {
  const { s, file, initial } = parkWithLesson(t);
  assert.equal(s.git('rev-parse', 'main'), initial, 'parking must not commit its passing lesson');
  assert.equal(readFileSync(file, 'utf8'), '# Instructions\n');
  assert.deepEqual(pendingOf(s), { sha: s.feature('a').sha, text: 'Original accepted lesson.' });
  assert.equal(s.cli('run').status, 0, 'another dirty-checkout pass must keep parking');
  s.git('checkout', '-q', 'README.md');
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged'); assert.equal(pendingOf(s), undefined);
  assert.equal(s.calls('build', 'a').length, 1); assert.equal(s.calls('eval', 'a').length, 1);
  assert.equal(readFileSync(file, 'utf8').split('Original accepted lesson.').length - 1, 1);
  assert.match(s.log(), /"event":"merged"[^\n]*\n[^\n]*"event":"lesson"/);
  assert.equal(s.git('log', '-2', '--format=%s'), 'fact-os: lesson from a\nfact-os: merge a: Feature a');
  assert.equal(s.cli('run').status, 0); assert.equal(s.calls('eval', 'a').length, 1);
  assert.equal(readFileSync(file, 'utf8').split('Original accepted lesson.').length - 1, 1);
});

for (const lesson of ['Fresh aggregate lesson.', null]) test(`R14: stale parked revalidation replaces the pending lesson with ${lesson ?? 'no lesson'}`, (t) => {
  const { s, file } = parkWithLesson(t, {}, [passingLesson(lesson)]);
  s.git('checkout', '-q', 'README.md'); writeFileSync(join(s.repo, 'user.txt'), 'new base\n');
  s.git('add', 'user.txt'); s.git('commit', '-qm', 'user advanced base');
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged'); assert.equal(pendingOf(s), undefined);
  assert.equal(s.calls('build', 'a').length, 1); assert.equal(s.calls('eval', 'a').length, 2);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Original accepted lesson/);
  if (lesson) assert.ok(readFileSync(file, 'utf8').includes(lesson));
  else assert.equal(readFileSync(file, 'utf8'), '# Instructions\n');
});

for (const failure of ['gate', 'evaluator']) test(`R14: failed aggregate ${failure} never promotes the superseded passing lesson`, (t) => {
  const { s, file } = parkWithLesson(t, { test: '[ ! -f reject ]' }, [
    { pass: false, findings: [{ check: 'a.txt exists', ok: false, evidence: 'aggregate regression' }], lesson: null },
  ]);
  s.git('checkout', '-q', 'README.md'); writeFileSync(join(s.repo, failure === 'gate' ? 'reject' : 'user.txt'), 'new base\n');
  s.git('add', '.'); s.git('commit', '-qm', 'user advanced base');
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'stuck'); assert.equal(pendingOf(s), undefined);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Original accepted lesson/);
  assert.equal(existsSync(join(s.repo, 'a.txt')), false);
});

test('R14: a moved parked branch discards the old lesson before rebuilding', (t) => {
  const { s, file } = parkWithLesson(t, {}, [passingLesson('Rebuilt lesson.')]);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'branch moved'], { cwd: wtOf(s, 'a') });
  s.git('checkout', '-q', 'README.md');
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls('build', 'a').length, 2); assert.equal(pendingOf(s), undefined);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Original accepted lesson/); assert.match(readFileSync(file, 'utf8'), /Rebuilt lesson/);
});

test('R14: a failed parked merge hook discards its pending lesson without spending an attempt', (t) => {
  const { s, file } = parkWithLesson(t, { mergeHook: 'exit 1' });
  s.git('checkout', '-q', 'README.md');
  const r = s.cli('run', '--max-features', '0'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'todo'); assert.equal(s.feature('a').attempts, 0); assert.equal(pendingOf(s), undefined);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Original accepted lesson/);
  assert.equal(s.calls('eval', 'a').length, 1);
});

test('R14: merge refusal retains its lesson through observer reparking until an actual merge', (t) => {
  const s = setup(t, { features: [F('a')], config: { refreshBeforeTest: true }, verdicts: { a: [passingLesson('Refused then merged lesson.')] } });
  const file = seedLessons(s); writeFileSync(join(s.repo, 'a.txt'), 'user untracked file\n');
  assert.equal(s.cli('run').status, 0); assert.equal(s.feature('a').parked, undefined);
  assert.equal(readFileSync(file, 'utf8'), '# Instructions\n'); assert.ok(pendingOf(s));
  assert.equal(s.cli('observe').status, 0); assert.equal(s.feature('a').parked, true);
  rmSync(join(s.repo, 'a.txt')); assert.equal(s.cli('run').status, 0);
  assert.equal(s.calls('eval', 'a').length, 1); assert.equal(pendingOf(s), undefined);
  assert.match(readFileSync(file, 'utf8'), /Refused then merged lesson/);
});

for (const status of ['ready', 'evaluating', 'merged'] as const) test(`R14: already-landed ${status} pending lessons recover without another provider`, (t) => {
  const { s, file } = parkWithLesson(t);
  s.git('checkout', '-q', 'README.md'); s.git('merge', '--no-ff', '-qm', 'merge before state recording', 'ship/a');
  const stateFile = join(s.repo, '.fact-os/features.json'), data = JSON.parse(readFileSync(stateFile, 'utf8'));
  Object.assign(data.features[0], { status, pendingLesson: { sha: s.feature('a').sha, text: 'Original accepted lesson.' } });
  writeFileSync(stateFile, JSON.stringify(data));
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged'); assert.equal(pendingOf(s), undefined);
  assert.equal(s.calls('eval', 'a').length, 1); assert.equal(s.calls('build', 'a').length, 1);
  assert.equal(readFileSync(file, 'utf8').split('Original accepted lesson.').length - 1, 1);
});

test('R14: counted refresh failure clears saved acceptance so the next attempt rebuilds', async (t) => {
  const s = setup(t, { features: [F('a')], config: { refreshBeforeTest: true, maxAttempts: 2 },
    verdicts: { a: [passingLesson('Superseded accepted lesson.'), passingLesson('Retry accepted lesson.')] } });
  const file = seedLessons(s); s.env.FAKE_DELAY_MS = '0'; s.git('config', 'merge.ff', 'only');
  const entered = join(s.repo, '.fact-os/eval-entered'), release = join(s.repo, '.fact-os/eval-release');
  const wrapper = join(s.repo, '.fact-os/blocked-evaluator.sh');
  writeFileSync(wrapper, `#!/bin/sh\nin=$(cat)\ncase "$in" in "You are the evaluator"*) touch '${entered}'; while [ ! -f '${release}' ]; do sleep 0.01; done;; esac\nprintf '%s' "$in" | '${FAKE}' "$@"\n`, { mode: 0o755 });
  s.env.FACTOS_CLAUDE = wrapper;
  const running = s.start('--once');
  try {
    assert.ok(await until(() => existsSync(entered)), running.out());
    writeFileSync(join(s.repo, 'user.txt'), 'advanced base\n'); s.git('add', 'user.txt'); s.git('commit', '-qm', 'advance during evaluation');
    writeFileSync(release, ''); assert.equal(await running.exit, 2, running.out());
  } finally { writeFileSync(release, ''); s.git('config', '--unset', 'merge.ff'); }
  assert.equal(s.feature('a').attempts, 1, running.out() + s.log() + JSON.stringify(s.feature('a'))); assert.equal(s.feature('a').status, 'todo');
  assert.match(s.feature('a').lastFeedback!, /merging main into your branch did not start/);
  assert.equal(s.feature('a').sha, undefined); assert.equal(pendingOf(s), undefined);
  const next = s.cli('run'); assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.equal(s.calls('build', 'a').length, 2, 'a counted failure cannot retain the parked-build shortcut');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Superseded accepted lesson/); assert.match(readFileSync(file, 'utf8'), /Retry accepted lesson/);
});

test('R14: a failed fresh verdict keeps only its negative lesson, never the old passing advice', (t) => {
  const { s, file } = parkWithLesson(t, {}, [{ pass: false, findings: [{ check: 'works', ok: false, evidence: 'aggregate rejection' }], lesson: 'Fresh negative lesson.' }]);
  s.git('checkout', '-q', 'README.md'); writeFileSync(join(s.repo, 'user.txt'), 'new base\n');
  s.git('add', 'user.txt'); s.git('commit', '-qm', 'advance base');
  assert.equal(s.cli('run').status, 2); assert.equal(pendingOf(s), undefined);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Original accepted lesson/); assert.match(readFileSync(file, 'utf8'), /Fresh negative lesson/);
});

for (const mismatch of ['receipt', 'ancestry'] as const) test(`R14: recovered merged lesson refuses invalid ${mismatch}`, (t) => {
  const { s, file } = parkWithLesson(t); s.git('checkout', '-q', 'README.md');
  if (mismatch === 'receipt') s.git('merge', '--no-ff', '-qm', 'merge a', 'ship/a');
  const stateFile = join(s.repo, '.fact-os/features.json'), data = JSON.parse(readFileSync(stateFile, 'utf8'));
  data.features[0].status = 'merged';
  if (mismatch === 'receipt') data.features[0].pendingLesson.sha = s.git('rev-parse', 'main');
  writeFileSync(stateFile, JSON.stringify(data));
  assert.equal(s.cli('run').status, 0);
  assert.equal(readFileSync(file, 'utf8'), '# Instructions\n'); assert.equal(s.calls('eval', 'a').length, 1); assert.ok(pendingOf(s), 'refused receipts remain available for inspection');
});

test('R14: a pending receipt retried after its append deduplicates and clears without a provider', (t) => {
  const { s, file } = parkWithLesson(t); s.git('checkout', '-q', 'README.md');
  s.git('merge', '--no-ff', '-qm', 'merge before receipt clear', 'ship/a');
  writeFileSync(file, '## fact-os lessons\n\n- 2026-10-02: Original accepted lesson.\n');
  s.git('add', 'CLAUDE.md'); s.git('commit', '-qm', 'lesson before receipt clear');
  const stateFile = join(s.repo, '.fact-os/features.json'), data = JSON.parse(readFileSync(stateFile, 'utf8'));
  data.features[0].status = 'merged'; writeFileSync(stateFile, JSON.stringify(data));
  assert.equal(s.cli('run').status, 0); assert.equal(pendingOf(s), undefined);
  assert.equal(readFileSync(file, 'utf8').split('Original accepted lesson.').length - 1, 1);
  assert.equal(s.calls('eval', 'a').length, 1);
});

test('R14: lesson write errors keep code merged and retain delivery for the next healthy pass', (t) => {
  const s = setup(t, { features: [F('a')], config: { refreshBeforeTest: true }, verdicts: { a: [passingLesson('Retry delivery lesson.')] } });
  const file = join(s.repo, 'CLAUDE.md'); mkdirSync(file);
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged'); assert.ok(pendingOf(s)); assert.match(s.log(), /"event":"lesson-error"/);
  const stats = agentStats(s.log().trim().split('\n').map((line) => JSON.parse(line) as LogEvent), [], 0)[0]!;
  assert.equal(stats.launches, 1); assert.equal(stats.evaluated, 1); assert.equal(stats.passed, 1); assert.equal(stats.merged, 1);
  rmSync(file, { recursive: true }); assert.equal(s.cli('run').status, 0);
  assert.equal(pendingOf(s), undefined); assert.equal(s.calls('build', 'a').length, 1); assert.equal(s.calls('eval', 'a').length, 1);
  assert.match(readFileSync(file, 'utf8'), /Retry delivery lesson/);
  assert.equal(readFileSync(file, 'utf8').split('Retry delivery lesson.').length - 1, 1);
});

test('R14: crash in postMerge retains the accepted SHA and pending lesson for startup recovery', (t) => {
  const s = setup(t, { features: [F('a')], config: { refreshBeforeTest: true, postMerge: 'kill -KILL "$PPID"' }, verdicts: { a: [passingLesson('Recovered active lesson.')] } });
  const r = s.cli('run'); assert.equal(r.signal, 'SIGKILL', r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'evaluating'); assert.ok(s.feature('a').sha);
  assert.deepEqual(pendingOf(s), { sha: s.feature('a').sha, text: 'Recovered active lesson.' });
  assert.equal(s.git('merge-base', '--is-ancestor', s.feature('a').sha!, 'main'), '');
  const next = s.cli('run'); assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.equal(s.feature('a').status, 'merged'); assert.equal(pendingOf(s), undefined);
  assert.equal(s.calls('build', 'a').length, 1); assert.equal(s.calls('eval', 'a').length, 1);
  assert.match(readFileSync(join(s.repo, 'CLAUDE.md'), 'utf8'), /Recovered active lesson/);
  const events = s.log().trim().split('\n').map((line) => JSON.parse(line) as LogEvent);
  assert.equal(events.filter((e) => e.event === 'recovered' && e.detail.startsWith('already merged')).length, 1);
});

for (const kind of ['manual', 'negative'] as const) test(`R14: ${kind} verdict lessons retain their existing immediate behavior`, (t) => {
  const s = setup(t, { features: [F('a')], config: { merge: kind === 'manual' ? 'manual' : 'auto', maxAttempts: 1 }, verdicts: { a: [
    kind === 'manual' ? passingLesson('Immediate manual lesson.') : { pass: false, findings: [{ check: 'works', ok: false, evidence: 'fixture rejection' }], lesson: 'Immediate negative lesson.' },
  ] } });
  const r = s.cli('run'); assert.equal(r.status, kind === 'manual' ? 0 : 2, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, kind === 'manual' ? 'ready' : 'stuck'); assert.equal(pendingOf(s), undefined);
  assert.match(readFileSync(join(s.repo, 'CLAUDE.md'), 'utf8'), /Immediate (manual|negative) lesson/);
});

for (const kind of ['negative', 'positive'] as const) test(`R15: ${kind} malformed verdict context reaches the next builder without emitting a lesson`, (t) => {
  const s = setup(t, { features: [F('a')] });
  const malformed = kind === 'negative'
    ? { pass: false, findings: [], blocking: 'cancel.ts:182 bypasses tenant isolation', lesson: 'Invalid advice must not compound' }
    : { pass: true, findings: [{ check: 'works', ok: true, evidence: 'checked' }], notes: 'cancel.ts:182 bypasses tenant isolation', lesson: 'Invalid advice must not compound' };
  writeFileSync(s.env.FAKE_VERDICTS, JSON.stringify({ a: [malformed, { pass: true, findings: [{ check: 'works', ok: true, evidence: 'checked' }] }] }));
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['merged', 1]);
  assert.equal(s.calls('build', 'a').length, 2);
  const prompt = s.calls('build', 'a')[1]!.prompt;
  assert.match(prompt, /Evaluator: verdict\.(findings|notes)/);
  assert.match(prompt, /Unvalidated evaluator output \(diagnostic only\):/);
  assert.match(prompt, /cancel.ts:182 bypasses tenant isolation/);
  assert.equal(existsSync(join(s.repo, 'CLAUDE.md')), false);
  assert.doesNotMatch(s.log(), /"event":"lesson"/);
});

test('R15: observer does not send a schema-stuck feature back for quoted infrastructure or test failures', async (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 } });
  writeFileSync(s.env.FAKE_VERDICTS, JSON.stringify({ a: [{ pass: false, findings: [], blocking: 'ECONNREFUSED\nFAIL src/quoted.test.ts', lesson: 'Invalid advice' }] }));
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(s.feature('a').lastFeedback!, /ECONNREFUSED/);
  const state = await observeOnce(s.repo, { out: () => {} });
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  const diagnosis = state.diagnoses.find((d) => d.feature === 'a')!;
  assert.deepEqual([diagnosis.cause, diagnosis.tests, diagnosis.action], ['own', [], 'left for a person']);
  assert.doesNotMatch(s.log(), /"event":"observer-retry"|"event":"lesson"/);
});

test('malformed evaluator blocking rejects the merge and cannot write a lesson', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 } });
  writeFileSync(s.env.FAKE_VERDICTS, JSON.stringify({ a: [{ pass: true,
    findings: [{ check: 'a.txt exists', ok: true, evidence: 'checked' }], cheating: [],
    blocking: 'tenant isolation broken', lesson: 'Advice from a malformed verdict' }] }));
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.match(s.feature('a').lastFeedback!, /Evaluator:.*blocking.*array/);
  assert.equal(s.git('log', '--merges', '--oneline'), '');
  assert.equal(existsSync(join(s.repo, 'a.txt')), false);
  assert.equal(existsSync(join(s.repo, 'CLAUDE.md')), false, 'malformed output cannot compound a lesson');
});

test('malformed evaluator findings feed the retry; a valid legacy verdict can then merge', (t) => {
  const s = setup(t, { features: [F('a')] });
  writeFileSync(s.env.FAKE_VERDICTS, JSON.stringify({ a: [
    { pass: true, findings: [{ ok: true }] },
    { pass: true, findings: [{ check: 'a.txt exists', ok: true, evidence: 'checked' }] },
  ] }));
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['merged', 1]);
  assert.equal(s.calls('build', 'a').length, 2);
  assert.equal(s.calls('eval', 'a').length, 2);
  assert.match(s.calls('build', 'a')[1].prompt, /findings\[0\]\.check.*nonempty string/);
});

test('a builder that leaves no commit, or uncommitted changes, is failed with "commit your work" (exit 2)', (t) => {
  const s = setup(t, { features: [F('noop'), F('dirty')], config: { maxAttempts: 1 }, scenario: { noop: 'noop', dirty: 'dirty' } });
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  for (const id of ['noop', 'dirty']) {
    assert.equal(s.feature(id).status, 'stuck', id);
    assert.match(s.feature(id).lastFeedback!, /commit your work/, id);
    assert.equal(s.calls('eval', id).length, 0, `${id} was not evaluated`);
  }
  assert.match(s.feature('dirty').lastFeedback!, /\n\?\? leftover\.txt/, 'names the uncommitted files (git status --porcelain)');
  assert.equal(s.git('log', '--merges', '--oneline'), '');
});

test('the evaluated commit is merged; a branch that moves during evaluation is refused', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 }, scenario: { a: 'eval:move-branch' } });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.feature('a').attempts, 1);
  assert.match(s.feature('a').lastFeedback!, /moved/);
  assert.equal(existsSync(join(s.repo, 'evil.txt')), false);
  assert.equal(s.git('log', '--merges', '--oneline'), '');
});

test('the evaluator sees the diff even when .gitattributes, textconv and diff.external try to hide it', (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'hide' } });
  assert.equal(s.cli('run').status, 0);
  assert.match(s.calls('eval', 'a')[0].prompt, /\+built a at/);
});

test('a merge git refuses to start (no MERGE_HEAD) leaves the feature ready without costing an attempt', (t) => {
  const s = setup(t, { features: [F('a')] });
  writeFileSync(join(s.repo, 'a.txt'), 'untracked, would be overwritten\n');
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['ready', 0]);
  assert.match(s.log(), /would be overwritten/);
  assert.doesNotMatch(s.log(), /conflict/);
});

test('merge is skipped (feature ready) when the main checkout is dirty or on another branch', (t) => {
  const s = setup(t, { features: [F('a'), F('b', { priority: 2 })], config: { maxParallel: 1 } });
  writeFileSync(join(s.repo, 'README.md'), 'local edit\n');
  assert.equal(s.cli('run', '--max-features', '1').status, 2);
  assert.equal(s.feature('a').status, 'ready');
  assert.match(s.log(), /merge-skipped.*uncommitted changes/);
  s.git('checkout', '-q', 'README.md');
  s.git('checkout', '-qb', 'other');
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.feature('b').status, 'ready');
  assert.match(s.log(), /merge-skipped.*on other, not main/);
  assert.equal(s.git('log', '--merges', '--oneline', 'main'), '');
});

// main gets shared.txt = "base"; branch ship/<id> gets its own commit with `branch` content (+ extra files); main then
// commits `main` content, so merging the branch into main conflicts.
type Setup = ReturnType<typeof setup>;
function conflict(s: Setup, id: string, { branch, main, extra = {} }: { branch: string; main?: string; extra?: Record<string, string> }) {
  const w = (f: string, c: string) => writeFileSync(join(s.repo, f), c);
  if (!existsSync(join(s.repo, 'shared.txt'))) { w('shared.txt', 'base\n'); s.git('add', 'shared.txt'); s.git('commit', '-qm', 'shared'); }
  s.git('checkout', '-qb', `ship/${id}`);
  for (const [f, c] of Object.entries({ ...extra, 'shared.txt': branch })) { w(f, c); s.git('add', f); }
  s.git('commit', '-qm', `${id} edits shared.txt`);
  s.git('checkout', '-q', 'main');
  if (main != null) { w('shared.txt', main); s.git('commit', '-qam', 'main edits shared.txt'); }
}
const wtOf = (s: Setup, id: string) => join(s.repo, '..', 'app-worktrees', id);

test('restoreFrom: a branch with no work of its own starts from its archive tag, whether its worktree is new or was recreated from main', (t) => {
  const s = setup(t, { features: [F('a'), F('b'), F('c')], config: { maxAttempts: 1, restoreFrom: 'archive/task/{id}' } });
  for (const id of ['a', 'b']) { // earlier work, saved only as a tag
    s.git('checkout', '-qb', `old-${id}`);
    writeFileSync(join(s.repo, `${id}-old.txt`), 'old\n');
    s.git('add', `${id}-old.txt`); s.git('commit', '-qm', `old ${id}`); s.git('tag', `archive/task/${id}`);
    s.git('checkout', '-q', 'main'); s.git('branch', '-qD', `old-${id}`);
  }
  s.git('worktree', 'add', '-q', '-b', 'ship/b', wtOf(s, 'b'), 'main'); // b's branch was recreated from main
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of ['a', 'b']) assert.equal(s.git('show', `main:${id}-old.txt`), 'old', `${id}'s archived work reached main`);
  assert.match(s.log(), /"feature":"a","event":"restored","detail":"archive\/task\/a/);
  assert.match(s.log(), /"feature":"b","event":"restored"/);
  assert.doesNotMatch(s.log(), /"feature":"c","event":"restored"/, 'no tag, nothing to restore');
  assert.equal(s.feature('c').status, 'merged');
});

test('a conflicting merge is aborted; the foreman merges main into the worktree conflict-free, and the next attempt merges (attempts unchanged)', (t) => {
  const s = setup(t, { features: [F('a', { branch: 'ship/a' })], config: { maxAttempts: 1 } });
  // union merge driver on the branch only: merging main into the branch is clean, merging the branch into main is not
  conflict(s, 'a', { branch: 'base\nbranch\n', main: 'base\nmain\n', extra: { '.gitattributes': 'shared.txt merge=union\n' } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').refreshes], ['merged', 0, 1]);
  const builds = s.calls('build', 'a');
  assert.equal(builds.length, 2);
  assert.match(builds[1].prompt, /the foreman merged main into your branch \(conflict-free\); re-run the tests/);
  assert.doesNotMatch(r.stdout + s.log(), /rebase|"alert"/);
  assert.match(readFileSync(join(s.repo, 'shared.txt'), 'utf8'), /branch[\s\S]*main|main[\s\S]*branch/);
  assert.equal(s.git('status', '--porcelain', '--untracked-files=no'), '');
});

test('a conflicted base refresh is left for the builder, who resolves and commits the merge; feature-branch commits that came through base are no alert', (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0 }), F('a', { branch: 'ship/a' })],
    config: { maxAttempts: 1, maxParallel: 1 }, scenario: { a: 'resolve' } });
  conflict(s, 'b', { branch: 'from b\n' });
  conflict(s, 'a', { branch: 'from a\n' }); // conflicts with b once b is merged
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('b').status, s.feature('a').status, s.feature('a').attempts, s.feature('a').refreshes], ['merged', 'merged', 0, 1]);
  const builds = s.calls('build', 'a');
  assert.equal(builds.length, 2);
  assert.match(builds[1].prompt, /the foreman started merging main into your branch and it conflicts in: shared\.txt\. Resolve/);
  assert.match(builds[1].prompt, /Do not abort it/);
  assert.match(builds[0].prompt, /except to complete a merge the foreman started/);
  assert.equal(s.git('rev-list', '--count', '--merges', `${s.feature('a').sha}^!`), '1', 'the evaluated sha is the builder\'s merge commit');
  assert.doesNotMatch(s.log(), /"alert"|commit your work/);
  assert.equal(readFileSync(join(s.repo, 'shared.txt'), 'utf8'), 'from a\nfrom b\n');
});

test('after 5 base refreshes a conflicting feature is stuck with "too many base refreshes", worktree untouched', (t) => {
  const s = setup(t, { features: [F('a', { branch: 'ship/a', refreshes: 5 })] });
  conflict(s, 'a', { branch: 'from a\n', main: 'from main\n' });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').refreshes], ['stuck', 0, 5]);
  assert.deepEqual(s.feature('a').stop, { attempt: 1, counted: false });
  assert.deepEqual((JSON.parse(s.log().trim().split('\n').at(-1)!) as LogEvent).stop, { attempt: 1, counted: false });
  assert.match(s.feature('a').lastFeedback!, /too many base refreshes/);
  const wt = wtOf(s, 'a');
  assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt }).status, 1, 'no merge started in the worktree');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }), '');
  assert.equal(existsSync(join(s.repo, '.git/MERGE_HEAD')), false, 'merge --abort ran');
});

test('maxRefreshes from config replaces the fixed 5: at maxRefreshes 1, one prior refresh makes a conflict stuck', (t) => {
  const s = setup(t, { features: [F('a', { branch: 'ship/a', refreshes: 1 })], config: { maxRefreshes: 1 } });
  conflict(s, 'a', { branch: 'from a\n', main: 'from main\n' });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').refreshes], ['stuck', 1]);
  assert.match(s.feature('a').lastFeedback!, /too many base refreshes/);
});

test('conflict groups (groupBy idPrefix): two ready features of one group never run together; another group fills the slot', (t) => {
  const s = setup(t, { features: [F('x-1'), F('x-2'), F('y-1')], config: { maxParallel: 3, groupBy: 'idPrefix:1' } });
  s.env.FAKE_DELAY_MS = '400';
  assert.equal(s.cli('run').status, 0);
  const [x1b, x1e, x2b, y1b] = [s.calls('build', 'x-1')[0], s.calls('eval', 'x-1')[0], s.calls('build', 'x-2')[0], s.calls('build', 'y-1')[0]];
  assert.ok(x1b.t0 < y1b.t1 && y1b.t0 < x1b.t1, 'x-1 and y-1 (different groups) built concurrently');
  assert.ok(x2b.t0 > x1e.t1, 'x-2 started only after x-1 finished');
  assert.match(s.log(), /"feature":"x-1","event":"merged"[\s\S]*"feature":"x-2","event":"launch"/);
  for (const id of ['x-1', 'x-2', 'y-1']) assert.equal(s.feature(id).status, 'merged');
});

test('run --watch fills a free slot as soon as a feature is resumed, without waiting for an in-flight feature to finish', async (t) => {
  const s = setup(t, { features: [F('a'), F('b', { status: 'paused' })], config: { maxParallel: 2 } });
  s.env.FAKE_DELAY_MS = '1500';
  const run = s.start('--watch');
  assert.ok(await until(() => s.feature('a').status === 'building'), run.out());
  assert.equal(s.cli('resume', 'b').status, 0);
  assert.equal(await run.exit, 0, run.out());
  assert.ok(s.calls('build', 'b')[0].t0 < s.calls('build', 'a')[0].t1, 'b launched while a was still building');
});

test('merge "auto": a feature parked as ready by a dirty checkout is merged once the checkout is clean, then its dependents launch', async (t) => {
  const s = setup(t, { features: [F('a'), F('b', { deps: ['a'] })], config: { maxParallel: 1 } });
  writeFileSync(join(s.repo, 'README.md'), 'local edit\n');
  const run = s.start('--watch');
  assert.ok(await until(() => s.feature('a').status === 'ready' && /merge-skipped/.test(s.log())), run.out());
  await sleep(300);
  assert.equal(s.calls('build', 'b').length, 0);
  s.git('checkout', '-q', 'README.md');
  assert.equal(await run.exit, 0, run.out());
  assert.deepEqual([s.feature('a').status, s.feature('b').status], ['merged', 'merged']);
  assert.equal(s.calls('build', 'a').length, 1, 'merged as evaluated, not rebuilt');
  assert.equal(s.git('merge-base', '--is-ancestor', s.feature('a').sha!, 'main'), '');
});

test('merge "auto": a parked ready feature whose branch moved goes back to todo and is rebuilt', (t) => {
  const s = setup(t, { features: [F('a')] });
  writeFileSync(join(s.repo, 'README.md'), 'local edit\n');
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.feature('a').status, 'ready');
  const wt = wtOf(s, 'a');
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'moved after evaluation'], { cwd: wt });
  s.git('checkout', '-q', 'README.md');
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.feature('a').status, 'merged');
  assert.equal(s.calls('build', 'a').length, 2);
  assert.match(s.log(), /moved after evaluation|moved since it was evaluated/);
});

test('base moved by someone other than Shipyard: alert, nothing more is launched or merged, exit 2', (t) => {
  const lesson = { pass: true, findings: [{ check: 'ok', ok: true, evidence: 'e' }], cheating: [], lesson: 'Keep it small' };
  const s = setup(t, { features: [F('z', { priority: 0 }), F('a'), F('b', { priority: 2 })], config: { maxParallel: 1 },
    scenario: { a: 'move-base' }, verdicts: { z: [lesson] } });
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout);
  assert.equal(s.feature('z').status, 'merged', 'its own merge and lesson commit do not trip the alert');
  assert.equal(s.feature('a').status, 'todo');
  assert.equal(s.feature('a').attempts, 0);
  assert.match(s.log(), /"alert".*main moved/);
  assert.equal(s.calls('build', 'b').length, 0, 'nothing launched after the alert');
});

test('the user\'s own commit on base mid-run is a notice, not an alert: base is re-recorded and the run goes on', (t) => {
  const s = setup(t, { features: [F('a'), F('b', { priority: 2 })], config: { maxParallel: 1 }, scenario: { a: 'user-commit' } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('b').status], ['merged', 'merged']);
  assert.match(s.log(), /"base-moved".*no feature-branch commits/);
  assert.doesNotMatch(s.log(), /"alert"/);
  assert.match(s.git('log', '--format=%s', 'main'), /the user's own work on main/);
});

test('config.json changed during the run: alert and exit 2 before merging', (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'config' } });
  assert.equal(s.cli('run').status, 2);
  assert.notEqual(s.feature('a').status, 'merged');
  assert.match(s.log(), /"alert".*config\.json/);
});

test('acceptance: mid-pass edits keep the launched checks; automatic retry reads current checks', (t) => {
  const fail1 = { pass: false, findings: [{ check: 'a.txt exists', ok: false, evidence: 'no' }], cheating: [], lesson: null };
  const s = setup(t, { features: [F('a')], scenario: { a: 'acceptance' }, verdicts: { a: [fail1] } });
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.feature('a').attempts, 1);
  for (const mode of ['build', 'eval']) {
    const calls = s.calls(mode, 'a');
    assert.equal(calls.length, 2);
    assert.match(calls[0].prompt, /- a\.txt exists/);
    assert.doesNotMatch(calls[0].prompt, /nothing to check/);
    assert.match(calls[1].prompt, /- nothing to check/);
  }
});

test('acceptance: editing a waiting feature before launch reaches builder and evaluator', async (t) => {
  const s = setup(t, { features: [F('a')] });
  writeFileSync(join(s.repo, '.fact-os/human.json'), JSON.stringify({ tasks: [
    { id: 'h', title: 'Get keys', steps: ['ask'], unblocks: ['a'], mockable: false, status: 'open' }] }));
  const run = s.start('--watch');
  assert.ok(await until(() => /"waiting"/.test(s.log())), run.out());
  await mutate(s.repo, 'features', (d) => { d.features[0].acceptance = ['updated before launch']; });
  assert.equal(s.cli('done', 'h').status, 0);
  assert.equal(await run.exit, 0, run.out());
  for (const mode of ['build', 'eval']) {
    assert.equal(s.calls(mode, 'a').length, 1);
    assert.match(s.calls(mode, 'a')[0].prompt, /- updated before launch/);
    assert.doesNotMatch(s.calls(mode, 'a')[0].prompt, /- a\.txt exists/);
  }
});

test('acceptance: a human retry in the same watching foreman captures edited checks', async (t) => {
  const failure = { pass: false, findings: [{ check: 'a.txt exists', ok: false, evidence: 'first attempt fails' }], cheating: [] };
  const s = setup(t, { features: [F('a'), F('b')], config: { maxAttempts: 1 }, verdicts: { a: [failure] } });
  writeFileSync(join(s.repo, '.fact-os/human.json'), JSON.stringify({ tasks: [
    { id: 'h', title: 'Get keys', steps: ['ask'], unblocks: ['b'], mockable: false, status: 'open' }] }));
  const run = s.start('--watch');
  assert.ok(await until(() => s.feature('a').status === 'stuck' && /"waiting"/.test(s.log())), run.out());
  await mutate(s.repo, 'features', (d) => { d.features.find((f) => f.id === 'a')!.acceptance = ['human retry checks']; });
  assert.equal(s.cli('retry', 'a').status, 0);
  assert.ok(await until(() => s.feature('a').status === 'merged'), run.out());
  assert.equal(s.cli('done', 'h').status, 0);
  assert.equal(await run.exit, 0, run.out());
  for (const mode of ['build', 'eval']) {
    const calls = s.calls(mode, 'a');
    assert.equal(calls.length, 2);
    assert.match(calls[0].prompt, /- a\.txt exists/);
    assert.match(calls[1].prompt, /- human retry checks/);
  }
});

for (const pause of [false, true]) test(`acceptance: locked launch reads a post-scheduling ${pause ? 'pause' : 'edit'}`, async (t) => {
  const s = setup(t, { features: [F('a')] });
  const fixture = fileURLToPath(new URL('./fixtures/acceptance-launch.ts', import.meta.url));
  const cp = spawn(process.execPath, [fixture, s.repo], { cwd: s.repo, env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; cp.stdout.on('data', (d) => { out += d; }); cp.stderr.on('data', (d) => { out += d; });
  const exit = new Promise<number | null>((r) => cp.once('exit', (code) => r(code)));
  t.after(() => cp.exitCode === null && cp.kill('SIGKILL'));
  assert.ok(await until(() => existsSync(join(s.repo, '.fact-os/launch-wait'))), out);
  await mutate(s.repo, 'features', (d) => {
    d.features[0].acceptance = ['edited after scheduling'];
    if (pause) d.features[0].status = 'paused';
  });
  writeFileSync(join(s.repo, '.fact-os/launch-release'), 'edited');
  assert.equal(await exit, pause ? 2 : 0, out);
  if (pause) {
    assert.equal(s.feature('a').status, 'paused');
    assert.equal(s.calls('build', 'a').length, 0);
    assert.doesNotMatch(s.log(), /"event":"launch"/);
  } else for (const mode of ['build', 'eval']) {
    assert.equal(s.calls(mode, 'a').length, 1);
    assert.match(s.calls(mode, 'a')[0].prompt, /- edited after scheduling/);
    assert.doesNotMatch(s.calls(mode, 'a')[0].prompt, /- a\.txt exists/);
  }
});

test('acceptance: inline conflict resolution retains launch checks in its own-feature brief', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, refreshBeforeTest: true,
    resolver: { model: 'fake', effort: 'medium', permissionMode: 'acceptEdits' } }, scenario: { a: 'acceptance,base-conflict' } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls('resolve', 'a').length, 1);
  for (const mode of ['build', 'resolve', 'eval']) {
    assert.match(s.calls(mode, 'a')[0].prompt, /- a\.txt exists/);
    assert.doesNotMatch(s.calls(mode, 'a')[0].prompt, /nothing to check/);
  }
  assert.equal(s.calls('build', 'a').length, 1);
});

for (const invalid of ['shape', 'json']) test(`invalid config during a live run (${invalid}) retains supervisor ownership until owned children finish`, async (t) => {
  const s = setup(t, { features: [F('a'), F('b', { priority: 2 })],
    config: { maxParallel: 1, timeoutMin: 0.02 }, scenario: { a: 'hang' } });
  const run = s.start('--watch');
  assert.ok(await until(() => s.pids().length === 2 && s.feature('a').pid), run.out());
  const cfg = join(s.repo, '.fact-os/config.json');
  writeFileSync(cfg, invalid === 'json' ? '{invalid JSON' : JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), maxAttempts: 'oops' }));
  await writeControl(s.repo, { maxParallel: 2 }, 'cli'); // wake the loop while its builder is still alive
  assert.ok(await until(() => /config\.json changed/.test(run.out()) || !existsSync(join(s.repo, '.fact-os/.foreman'))), run.out());
  assert.ok(existsSync(join(s.repo, '.fact-os/.foreman')), 'keep ownership while the in-flight child drains');
  assert.ok(alive(s.pids()[0]), 'the existing builder is still draining');
  const second = s.cli('run', '--once');
  assert.equal(second.status, 1);
  assert.match(second.stderr, /another foreman is running/);
  assert.equal(await run.exit, 2, run.out());
  assert.match(run.out(), /config\.json changed/);
  for (const pid of s.pids()) assert.equal(alive(pid), false, `owned pid ${pid} outlived supervisor ownership`);
  assert.equal(existsSync(join(s.repo, '.fact-os/.foreman')), false);
  assert.equal(s.calls('eval', 'a').length, 0);
  assert.equal(s.calls('build', 'b').length, 0);
});

test('budgetUsdTotal counts only this run\'s spend and stops launching; null means unlimited', (t) => {
  const s = setup(t, { features: [F('a', { costUsd: 100 }), F('b', { priority: 2, costUsd: 100 })],
    config: { maxParallel: 1, budgetUsdTotal: 0.015 } });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.feature('a').status, 'merged', 'earlier runs\' costs do not count');
  assert.equal(s.feature('b').status, 'todo');
  assert.equal(s.calls('build', 'b').length, 0);
  assert.match(s.log(), /"budget"/);
  const cfg = join(s.repo, '.fact-os/config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), budgetUsdTotal: null }));
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.feature('b').status, 'merged');
});

test('a run that hits --max-budget-usd is reported as "budget exhausted"', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 }, scenario: { a: 'budget' } });
  assert.equal(s.cli('run').status, 2);
  assert.match(s.feature('a').lastFeedback!, /budget exhausted/);
});

test('timeoutMin kills the whole process group of a hung child', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, timeoutMin: 0.01 }, scenario: { a: 'hang' } });
  assert.equal(s.cli('run').status, 2);
  assert.match(s.feature('a').lastFeedback!, /timed out after 0\.01 min/);
  assert.equal(s.pids().length, 2);
  for (const pid of s.pids()) assert.equal(alive(pid), false, `pid ${pid} still running`);
});

test('SIGINT stops children (whole group) and returns in-flight features to todo; a second SIGINT force-exits', async (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'hang' } });
  let run = s.start();
  assert.ok(await until(() => s.pids().length === 2), run.out());
  run.cp.kill('SIGINT');
  assert.equal(await run.exit, 2, run.out());
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['todo', 0]);
  for (const pid of s.pids()) assert.equal(alive(pid), false, `pid ${pid} still running`);

  writeFileSync(s.env.FAKE_PIDS, '');
  s.env.FAKE_SCENARIO = JSON.stringify({ a: 'hang,ignore-term' });
  run = s.start();
  assert.ok(await until(() => s.pids().length === 2), run.out());
  run.cp.kill('SIGINT');
  await sleep(500);
  assert.equal(run.cp.exitCode, null, 'waits for a child that ignores SIGTERM');
  run.cp.kill('SIGINT');
  assert.notEqual(await run.exit, 0);
  assert.ok(await until(() => s.pids().every((p) => !alive(p)), 2000), 'force exit kills the group');
});

test('crash recovery through run(): merged branch → merged, dead child → relaunched, live child → waited for', async (t) => {
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => sleeper.kill());
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout);
  const s = setup(t, { features: [F('m', { status: 'evaluating' }), F('d', { status: 'building', pid: dead }),
    F('l', { status: 'testing', pid: sleeper.pid, pidStart: procStart(sleeper.pid!)!, foremanPid: dead })] });
  s.git('checkout', '-qb', 'ship/m'); // m was merged, then the foreman died before recording it
  writeFileSync(join(s.repo, 'm.txt'), 'm\n');
  s.git('add', 'm.txt'); s.git('commit', '-qm', 'build m');
  s.git('checkout', '-q', 'main'); s.git('merge', '-q', '--no-ff', '-m', 'merge m', 'ship/m');
  const run = s.start();
  assert.ok(await until(() => s.feature('d').status === 'merged'), run.out());
  await sleep(300);
  assert.equal(s.feature('m').status, 'merged');
  assert.equal(s.calls('build', 'm').length, 0, 'an already merged feature is not rebuilt');
  assert.equal(s.feature('l').status, 'testing');
  assert.equal(s.calls('build', 'l').length, 0, 'not relaunched while its child is alive');
  sleeper.kill();
  assert.equal(await run.exit, 0, run.out());
  assert.equal(s.feature('l').status, 'merged');
});

test('recovery does not wait on a pid that is not ours (pid 1 left in features.json across a reboot)', (t) => {
  const s = setup(t, { features: [F('a', { status: 'building', pid: 1 })] });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
});

test('waiting for a previous foreman\'s live child is capped by timeoutMin; the feature is then stuck, not relaunched', (t) => {
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => sleeper.kill());
  const s = setup(t, { features: [F('a', { status: 'testing', pid: sleeper.pid, pidStart: procStart(sleeper.pid!)!, foremanPid: 1 })],
    config: { timeoutMin: 0.01 } });
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(s.log(), /"a","event":"recovered".*timeoutMin/);
  assert.deepEqual([s.feature('a').status, s.feature('a').lastFeedback], ['stuck', `previous child still running (pid ${sleeper.pid})`]);
  assert.deepEqual(s.feature('a').stop, { attempt: 1, counted: false });
  assert.deepEqual((JSON.parse(s.log().trim().split('\n').at(-1)!) as LogEvent).stop, { attempt: 1, counted: false });
  assert.equal(s.calls('build', 'a').length, 0, 'no second process in the same worktree');
  assert.equal(alive(sleeper.pid!), true, 'a process Shipyard did not start is not killed');
});

test('crash recovery: an in-flight branch with no commits yet (tip on base\'s first-parent line) goes back to todo, not merged', (t) => {
  const s = setup(t, { features: [F('e', { status: 'building', branch: 'ship/e' })] });
  s.git('branch', 'ship/e'); // the builder died before its first commit
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(s.log(), /"e","event":"recovered","detail":"left in flight/);
  assert.equal(s.calls('build', 'e').length, 1, 'rebuilt, not taken as already merged');
  assert.equal(s.feature('e').status, 'merged');
});

test('merge "manual": merging a ready branch by hand while run --watch waits on a human task is not an alert', async (t) => {
  const s = setup(t, { features: [F('a'), F('k', { priority: 2 })], config: { merge: 'manual' } });
  writeFileSync(join(s.repo, '.fact-os/human.json'), JSON.stringify({ tasks: [
    { id: 'h', title: 'Get keys', steps: ['ask'], unblocks: ['k'], mockable: false, status: 'open' }] }));
  const run = s.start('--watch');
  assert.ok(await until(() => s.feature('a').status === 'ready' && /"waiting"/.test(s.log())), run.out());
  assert.equal(s.feature('a').sha, s.git('rev-parse', 'ship/a'), 'the evaluated sha is recorded');
  s.git('merge', '-q', '--no-ff', '-m', 'merge a by hand', 'ship/a');
  assert.equal(s.cli('done', 'h').status, 0);
  assert.equal(await run.exit, 0, run.out());
  assert.doesNotMatch(s.log(), /"alert"/);
  assert.equal(s.feature('k').status, 'ready');
});

test('manual dependencies: CLI and dashboard block unmerged work, then the dependent starts with dependency code', async (t) => {
  const s = setup(t, { features: [F('a'), F('b', { deps: ['a'] }), F('c')], config: { merge: 'manual', maxParallel: 1,
    prepare: 'if [ "$FACTOS_FEATURE" = b ]; then test -f a.txt; fi' } });
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('b').status, s.feature('c').status], ['ready', 'todo', 'ready']);
  assert.equal(s.calls('build', 'b').length, 0);
  assert.doesNotMatch(s.cli('status').stdout.split('\n').find((l) => /^b\s/.test(l))!, /\bnext\b/);
  const dash = await startDash({ root: s.repo, port: 0 }); t.after(() => dash.server.close());
  const state = async () => ((await (await fetch(dash.url + '/api/state')).json()) as { projects: ProjectState[] }).projects.find((p) => p.path === s.repo)!;
  const ack = () => fetch(dash.url + '/api/feature/merged', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: s.repo, id: 'a' }) });
  assert.deepEqual((await state()).ready, []);
  const features = readFileSync(join(s.repo, '.fact-os/features.json'), 'utf8'), log = s.log();
  assert.equal((await ack()).status, 409); assert.equal(readFileSync(join(s.repo, '.fact-os/features.json'), 'utf8'), features); assert.equal(s.log(), log);
  s.git('merge', '--ff-only', 'ship/a'); assert.equal((await ack()).status, 200);
  assert.deepEqual((await state()).ready, ['b']); assert.match(s.cli('status').stdout.split('\n').find((l) => /^b\s/.test(l))!, /\bnext\b/);
  const next = s.cli('run'); assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.equal(s.feature('b').status, 'ready'); assert.equal(s.calls('build', 'b').length, 1);
  assert.equal(readFileSync(join(wtOf(s, 'b'), 'a.txt'), 'utf8'), readFileSync(join(s.repo, 'a.txt'), 'utf8'));
});

test('manual dependencies: watch stays alive until a hand merge is acknowledged', async (t) => {
  const s = setup(t, { features: [F('a'), F('b', { deps: ['a'] })], config: { merge: 'manual', maxParallel: 1 } });
  const running = s.start('--watch');
  assert.ok(await until(() => s.feature('a').status === 'ready'), running.out()); await sleep(250);
  assert.equal(running.cp.exitCode, null, running.out()); assert.equal(s.calls('build', 'b').length, 0);
  assert.match(running.out(), /waiting for manual merges/);
  s.git('merge', '-q', '--no-ff', '-m', 'manual merge a', 'ship/a');
  const dash = await startDash({ root: s.repo, port: 0 }); t.after(() => dash.server.close());
  const ack = await fetch(dash.url + '/api/feature/merged', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: s.repo, id: 'a' }) });
  assert.equal(ack.status, 200); assert.equal(await running.exit, 0, running.out());
  assert.equal(s.feature('b').status, 'ready'); assert.equal(s.calls('build', 'b').length, 1); assert.doesNotMatch(s.log(), /"alert"/);
});

test('merged dependencies reach a reused dependent branch with existing work before prepare and builder', (t) => {
  const s = setup(t, { features: [F('a', { status: 'merged' }), F('b', { deps: ['a'] })], config: { merge: 'manual',
    prepare: 'test -f a.txt && test -f earlier.txt', refreshBeforeTest: false } });
  s.git('checkout', '-qb', 'ship/b'); writeFileSync(join(s.repo, 'earlier.txt'), 'existing work\n'); s.git('add', 'earlier.txt'); s.git('commit', '-qm', 'earlier b');
  s.git('checkout', '-q', 'main'); s.git('checkout', '-qb', 'ship/a'); writeFileSync(join(s.repo, 'a.txt'), 'dependency\n'); s.git('add', 'a.txt'); s.git('commit', '-qm', 'a');
  const sha = s.git('rev-parse', 'HEAD'); s.git('checkout', '-q', 'main'); s.git('merge', '-q', '--no-ff', '-m', 'merge a', sha);
  writeFileSync(join(s.repo, '.fact-os/features.json'), JSON.stringify({ features: [F('a', { status: 'merged', sha }), F('b', { deps: ['a'] })] }));
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('b').status, 'ready'); assert.equal(s.calls('build', 'b').length, 1); assert.equal(s.feature('b').attempts, 0);
  assert.equal(s.git('merge-base', '--is-ancestor', sha, 'ship/b'), '');
  const events = s.log().trim().split('\n').map((l) => JSON.parse(l) as LogEvent);
  assert.deepEqual(passesOf(events, () => 'own').filter((p) => p.feature === 'b').map((p) => p.outcome), ['ok']);
  assert.equal(agentStats(events, [], 0).reduce((n, e) => n + e.passed, 0), 1);
});

function staleDependency(s: Setup, { conflict = false, legacy = false }: { conflict?: boolean; legacy?: boolean } = {}) {
  if (conflict) { writeFileSync(join(s.repo, 'shared.txt'), 'base\n'); s.git('add', 'shared.txt'); s.git('commit', '-qm', 'shared base'); }
  s.git('checkout', '-qb', 'ship/b'); writeFileSync(join(s.repo, 'earlier.txt'), 'existing b work\n'); s.git('add', 'earlier.txt');
  if (conflict) { writeFileSync(join(s.repo, 'shared.txt'), 'b behavior\n'); s.git('add', 'shared.txt'); }
  s.git('commit', '-qm', 'earlier b'); s.git('checkout', '-q', 'main'); s.git('checkout', '-qb', 'ship/a');
  writeFileSync(join(s.repo, 'a.txt'), 'dependency\n'); s.git('add', 'a.txt');
  if (conflict) { writeFileSync(join(s.repo, 'shared.txt'), 'a behavior\n'); s.git('add', 'shared.txt'); }
  s.git('commit', '-qm', 'a'); const sha = s.git('rev-parse', 'HEAD'); s.git('checkout', '-q', 'main');
  s.git('merge', '-q', '--no-ff', '-m', 'manual merge a', sha);
  writeFileSync(join(s.repo, '.fact-os/features.json'), JSON.stringify({ features: [F('a', { status: 'merged', ...(legacy ? {} : { sha }) }),
    F('b', { deps: ['a'], lastFeedback: 'Preserve this earlier failure feedback.' })] })); return sha;
}

test('a dependency import conflict stays with its builder and preserves pass statistics and earlier feedback', (t) => {
  const s = setup(t, { features: [], config: { merge: 'manual', conflictBrief: true, refreshBeforeTest: false, resolver: { model: 'fake' },
    prepare: '! git rev-parse --quiet --verify MERGE_HEAD && test -f a.txt' }, scenario: { b: 'resolve' } });
  const sha = staleDependency(s, { conflict: true }); const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('b').status, 'ready'); assert.equal(s.feature('b').attempts, 0); assert.equal(s.feature('b').refreshes, 1);
  assert.equal(s.calls('build', 'b').length, 1); assert.equal(s.calls('resolve', 'b').length, 0, 'this builder owns its dependency import');
  assert.match(s.calls('build', 'b')[0].prompt, /Preserve this earlier failure feedback/); assert.match(s.calls('build', 'b')[0].prompt, /foreman started merging.*conflicts in/);
  assert.equal(s.git('merge-base', '--is-ancestor', sha, 'ship/b'), '');
  assert.match(readFileSync(join(wtOf(s, 'b'), 'shared.txt'), 'utf8'), /b behavior[\s\S]*a behavior/);
  const events = s.log().trim().split('\n').map((l) => JSON.parse(l) as LogEvent);
  assert.deepEqual(passesOf(events, () => 'own').filter((p) => p.feature === 'b').map((p) => p.outcome), ['ok']);
  const stats = agentStats(events, [], 0); assert.equal(stats.reduce((n, e) => n + e.passed, 0), 1); assert.equal(stats.reduce((n, e) => n + e.built, 0), 1);
  assert.deepEqual(conflictTimeline(events, Date.now()).map((r) => [r.files, r.resolvedBy, r.outcome]), [[['shared.txt'], 'builder', 'resolved']]);
});

test('legacy merged dependencies without a recorded SHA import current base into a reused branch', (t) => {
  const s = setup(t, { features: [], config: { merge: 'manual', refreshBeforeTest: false, prepare: 'test -f a.txt' } });
  const sha = staleDependency(s, { legacy: true }); const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('b').status, 'ready'); assert.equal(s.git('merge-base', '--is-ancestor', sha, 'ship/b'), '');
});

for (const mode of ['union', 'missing'] as const) test(`pending dependency merge validates both parents (${mode})`, (t) => {
  const s = setup(t, { features: [], config: { merge: 'manual', maxAttempts: 1, refreshBeforeTest: false }, scenario: { b: 'resolve' } });
  const a = staleDependency(s, { conflict: true }), original = s.git('rev-parse', 'main^1');
  s.git('checkout', '-qb', 'ship/d', original); writeFileSync(join(s.repo, 'd.txt'), 'other dependency\n'); s.git('add', 'd.txt'); s.git('commit', '-qm', 'd'); const d = s.git('rev-parse', 'HEAD');
  if (mode === 'union') { s.git('checkout', '-q', 'ship/b'); s.git('merge', '-q', '--no-ff', '-m', 'include d in b', d); }
  s.git('checkout', '-q', 'main'); s.git('merge', '-q', '--no-ff', '-m', 'merge d', d);
  s.git('worktree', 'add', '-q', wtOf(s, 'b'), 'ship/b');
  assert.equal(spawnSync('git', ['merge', '--no-ff', '--no-edit', a], { cwd: wtOf(s, 'b') }).status, 1, 'fixture starts a real conflict');
  writeFileSync(join(s.repo, '.fact-os/features.json'), JSON.stringify({ features: [F('a', { status: 'merged', sha: a }), F('d', { status: 'merged', sha: d }), F('b', { deps: ['a', 'd'] })] }));
  const r = s.cli('run'); assert.equal(r.status, mode === 'union' ? 0 : 2, r.stdout + r.stderr);
  if (mode === 'union') { assert.equal(s.feature('b').status, 'ready'); assert.equal(s.calls('build', 'b').length, 1); for (const sha of [a, d]) assert.equal(s.git('merge-base', '--is-ancestor', sha, 'ship/b'), ''); }
  else { assert.equal(s.calls('build', 'b').length, 0); assert.match(s.feature('b').lastFeedback!, /pending merge does not contain/); }
});

for (const mode of ['fails', 'dirty', 'drops ancestry']) test(`deferred dependency preparation ${mode} safely before gates`, (t) => {
  const prepare = mode === 'fails' ? 'exit 7' : mode === 'dirty' ? 'echo changed > shared.txt' : 'git reset --hard HEAD^1';
  const s = setup(t, { features: [], config: { merge: 'manual', maxAttempts: 1, prepare, refreshBeforeTest: false, setupRetryDelaysSec: [] }, scenario: { b: 'resolve' } });
  staleDependency(s, { conflict: true }); const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(s.feature('b').status, 'stuck'); assert.equal(s.calls('build', 'b').length, 1);
  assert.equal(s.calls('eval', 'b').length, 0); assert.doesNotMatch(s.log(), /"event":"testing"/);
  assert.match(s.feature('b').lastFeedback!, mode === 'fails' ? /prepare .* exited 7/ : mode === 'dirty' ? /uncommitted changes/ : /declared merged dependencies/);
});

test('dependency import conflicts honor maxRefreshes before spending a builder call', (t) => {
  const s = setup(t, { features: [], config: { merge: 'manual', maxRefreshes: 0 } }); staleDependency(s, { conflict: true });
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(s.feature('b').status, 'stuck');
  assert.match(s.feature('b').lastFeedback!, /too many base refreshes/); assert.equal(s.calls('build', 'b').length, 0); assert.equal(s.feature('b').attempts, 0);
  assert.deepEqual(s.feature('b').stop, { attempt: 1, counted: false });
  const stopped = s.log().trim().split('\n').map((line) => JSON.parse(line) as LogEvent).findLast((event) => event.feature === 'b' && event.event === 'stuck');
  assert.deepEqual(stopped?.stop, { attempt: 1, counted: false });
});

test('a builder cannot abort a dependency import and pass with missing dependency ancestry', (t) => {
  const s = setup(t, { features: [], config: { merge: 'manual', maxAttempts: 1, refreshBeforeTest: false } }); staleDependency(s, { conflict: true });
  const fake = join(s.repo, '.fact-os/abort-dependency.sh');
  writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\ngit merge --abort\necho built > b.txt\ngit add b.txt\ngit commit -qm "abort dependency and build"\nprintf \'%s\' \'{"type":"result","is_error":false,"result":"done","total_cost_usd":0}\'\n', { mode: 0o755 });
  s.env.FACTOS_CLAUDE = fake; const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(s.feature('b').status, 'stuck'); assert.match(s.feature('b').lastFeedback!, /declared merged dependencies/);
  assert.equal(existsSync(join(s.repo, '.fact-os/runs/b/1-eval.json')), false);
});

test('a falsely merged dependency SHA absent from base never launches the dependent builder', (t) => {
  const s = setup(t, { features: [], config: { merge: 'manual', maxAttempts: 1 } }); const sha = staleDependency(s);
  s.git('reset', '--hard', 'HEAD^');
  assert.notEqual(spawnSync('git', ['merge-base', '--is-ancestor', sha, 'main'], { cwd: s.repo }).status, 0);
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(s.calls('build', 'b').length, 0);
  assert.match(s.feature('b').lastFeedback!, /dependency a is not a merged commit on main/);
});

test('a synthetic commit on base carrying an unmerged feature branch\'s blobs is an alert (commit-tree, git -C <root> commit)', (t) => {
  for (const flag of ['synthetic-base', 'root-commit']) {
    const s = setup(t, { features: [F('a'), F('b', { priority: 2 })], config: { maxParallel: 1 }, scenario: { a: flag } });
    const r = s.cli('run');
    assert.equal(r.status, 2, `${flag}: ${r.stdout}`);
    assert.match(s.log(), /"alert".*main moved.*blob/, flag);
    assert.notEqual(s.feature('a').status, 'merged', flag);
    assert.equal(s.calls('build', 'b').length, 0, `${flag}: nothing launched after the alert`);
  }
});

test('--max-budget-usd is passed only when budgetUsdPerRun is a positive number', async () => {
  const { claudeArgs } = await import('../lib/foreman.ts');
  const base = { builder: { model: 'opus' } } as Config; // only the fields claudeArgs reads here
  assert.ok(!claudeArgs({ ...base, budgetUsdPerRun: null }, 'builder', '/r').includes('--max-budget-usd'));
  const a = claudeArgs({ ...base, budgetUsdPerRun: 7 }, 'builder', '/r');
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '7');
});

test('a prepared branch with no commits of its own is fast-forwarded to the current base before building', (t) => {
  const s = setup(t, { features: [F('a', { branch: 'ship/a' })], config: { maxAttempts: 1 } });
  s.git('branch', 'ship/a');
  writeFileSync(join(s.repo, 'a.txt'), 'main version\n');
  s.git('add', 'a.txt'); s.git('commit', '-qm', 'main moved after the branch was prepared');
  const moved = s.git('rev-parse', 'main');
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.feature('a').status, 'merged');
  assert.equal(s.git('merge-base', '--is-ancestor', moved, 'ship/a'), '', 'the build started from the moved base');
});

test('prepare runs in the worktree before each build; postMerge gets the merged feature id and branch', (t) => {
  const s = setup(t, { features: [F('a')], config: {} });
  const log = join(s.repo, '.fact-os', 'hooks.log');
  const cfg = JSON.parse(readFileSync(join(s.repo, '.fact-os/config.json'), 'utf8'));
  cfg.prepare = `echo "prepare $SHIPYARD_FEATURE $(basename "$PWD")" >> ${log}`;
  cfg.postMerge = `echo "post $SHIPYARD_FEATURE $SHIPYARD_BRANCH" >> ${log}`;
  writeFileSync(join(s.repo, '.fact-os/config.json'), JSON.stringify(cfg));
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.feature('a').status, 'merged');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['prepare a a', 'post a ship/a']);
});

test('mergeHook runs on the staged merge with SHIPYARD_FEATURE/BRANCH; its staged rename is part of the merge commit, no alert', (t) => {
  const s = setup(t, { features: [F('a'), F('b', { priority: 2 })], config: { maxParallel: 1,
    mergeHook: 'test "$SHIPYARD_BRANCH" = "ship/$SHIPYARD_FEATURE" && git mv "$SHIPYARD_FEATURE.txt" "0001-$SHIPYARD_FEATURE.txt"' } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('b').status], ['merged', 'merged']);
  const head = s.git('log', '--merges', '-1', '--format=%s%n%P', 'main').split('\n');
  assert.equal(head[0], 'fact-os: merge b: Feature b');
  assert.equal(head[1].split(' ').length, 2, 'a real merge commit');
  assert.equal(s.git('show', '--first-parent', '--name-status', '--format=', 'main').trim(), 'A\t0001-b.txt');
  assert.deepEqual(s.git('ls-tree', '--name-only', 'main').split('\n').filter((f) => /\.txt$/.test(f)), ['0001-a.txt', '0001-b.txt']);
  assert.doesNotMatch(r.stdout + s.log(), /"alert"|ALERT/);
  assert.equal(s.git('status', '--porcelain', '--untracked-files=no'), '');
});

test('a failing mergeHook aborts the merge: main unchanged, feature back to todo with the hook output, attempts unchanged', (t) => {
  const s = setup(t, { features: [F('a')], config: { mergeHook: 'git mv a.txt 0001-a.txt; echo "migration 0001 is taken"; exit 4' } });
  const main0 = s.git('rev-parse', 'main');
  s.cli('run', '--once');
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['todo', 0]);
  assert.match(s.feature('a').lastFeedback!, /exited 4[\s\S]*migration 0001 is taken/);
  assert.match(s.log(), /"event":"merge-hook-failed","detail":"mergeHook .*exited 4:\\nmigration 0001 is taken/);
  assert.equal(s.git('rev-parse', 'main'), main0);
  assert.equal(existsSync(join(s.repo, '.git/MERGE_HEAD')), false, 'merge --abort ran');
  assert.equal(s.git('status', '--porcelain', '--untracked-files=no'), '');
});

test('a failing prepare stops the feature before the builder runs, without spending an attempt (no setup retries)', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, setupRetryDelaysSec: [] } });
  const cfg = JSON.parse(readFileSync(join(s.repo, '.fact-os/config.json'), 'utf8'));
  cfg.prepare = 'echo no database; exit 3';
  writeFileSync(join(s.repo, '.fact-os/config.json'), JSON.stringify(cfg));
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.feature('a').status, 'stuck');
  assert.match(s.feature('a').lastFeedback!, /prepare .* exited 3[\s\S]*no database/);
  assert.equal(s.calls('build', 'a').length, 0);
  assert.deepEqual([s.feature('a').attempts, s.feature('a').stop], [0, { attempt: 1, counted: false }], 'I05: setup is not an attempt');
});

test('refreshBeforeTest: base moves during the build → the verified base is merged in before the test, which sees it; that sha is merged', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, refreshBeforeTest: true, test: 'test -f base-a.txt' }, scenario: { a: 'base-file' } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const a = s.feature('a');
  assert.deepEqual([a.status, a.attempts, a.refreshes], ['merged', 0, undefined]);
  assert.equal(a.sha, s.git('rev-parse', 'ship/a'), 'the recorded sha is the new branch tip');
  assert.equal(s.git('rev-list', '--count', '--merges', `${a.sha}^!`), '1', 'the tip is the foreman\'s merge of base');
  assert.equal(s.git('merge-base', '--is-ancestor', a.sha, 'main'), '');
  const diff = s.calls('eval', 'a')[0].prompt.split('Diff main...ship/a:')[1];
  assert.match(diff, /b\/a\.txt/);
  assert.doesNotMatch(diff, /base-a\.txt/, 'the diff shows only the feature\'s own changes');
  for (const f of ['a.txt', 'base-a.txt']) assert.ok(existsSync(join(s.repo, f)), f);
  assert.doesNotMatch(s.log(), /"alert"/);
});

test('refreshBeforeTest: a conflicting base move sends the feature back to todo before test and eval, attempts unchanged', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, refreshBeforeTest: true }, scenario: { a: 'base-conflict,resolve' } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').refreshes], ['merged', 0, 1]);
  const builds = s.calls('build', 'a');
  assert.equal(builds.length, 2);
  assert.match(builds[1].prompt, /the foreman started merging main into your branch and it conflicts in: a\.txt\. Resolve/);
  assert.equal(s.calls('eval', 'a').length, 1, 'the conflicted state was never evaluated');
  assert.doesNotMatch(s.log(), /"alert"|commit your work/);
});

test('refreshBeforeTest: a conflicting refresh keeps the earlier failure the builder still has to fix, without stacking notes', (t) => {
  const s = setup(t, { features: [F('a', { lastFeedback: 'test command exited 1: loyalty.db.test.ts' })],
    config: { maxAttempts: 1, refreshBeforeTest: true }, scenario: { a: 'base-conflict,resolve' } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const p = s.calls('build', 'a')[1].prompt;
  assert.match(p, /loyalty\.db\.test\.ts[\s\S]*not fixed yet\. Also: the foreman started merging main/);
  assert.equal(p.split('Also:').length, 2, 'one refresh note, not a stack');
});

test('refreshBeforeTest defaults to false: the test runs on the branch as built, without the moved base', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, test: 'test -f base-a.txt' }, scenario: { a: 'base-file' } });
  assert.equal(JSON.parse(readFileSync(join(s.repo, '.fact-os/config.json'), 'utf8')).refreshBeforeTest, false);
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.match(s.feature('a').lastFeedback!, /test command `test -f base-a\.txt` exited 1/);
  assert.equal(s.calls('eval', 'a').length, 0);
});

// ---- I01: inline gate fix, diagnosis and test-edit evidence (docs/improvements.md) ----
const GATE = 'test ! -f broken.txt'; // the fake builder's "break" flag commits broken.txt; a fix removes it
const GATE_OUT = 'test ! -f broken.txt || { echo "FAIL src/receipt.test.ts > settles"; echo "Error: timed out waiting for the receipt to settle"; exit 1; }'; // with failure lines (an environment rerun compares them)
const events = (s: { log: () => string }, id: string) => s.log().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEvent).filter((e) => e.feature === id);
const DIAG = { model: 'opus', effort: 'high', permissionMode: 'auto' };

test('I01: gateFixes 0 keeps a gate failure an ordinary counted failure', (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, diagnoser: null }, scenario: { a: 'break' } });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.equal(s.calls('fix', 'a').length, 0); assert.equal(s.calls('diagnose', 'a').length, 0);
});

test('I01: a first gate failure resumes the same builder session; a passing fix reaches evaluation in the same pass', (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, gateFixes: 1 }, scenario: { a: 'break' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['merged', 0]);
  const [fix] = s.calls('fix', 'a');
  assert.ok(fix, 'one resumed fix'); assert.equal(fix.args[fix.args.indexOf('--resume') + 1], 'fake', 'the builder\'s own session');
  assert.match(fix.prompt, /test command `test ! -f broken\.txt` exited 1/);
  const ev = events(s, 'a').map((e) => e.event);
  assert.equal(ev.filter((e) => e === 'launch').length, 1); assert.equal(ev.filter((e) => e === 'gate-fix').length, 1);
  assert.equal(ev.filter((e) => e === 'failed').length, 0);
  assert.equal(s.calls('eval', 'a').length, 1);
  assert.ok(existsSync(join(s.repo, '.fact-os', 'runs', 'a', '1.2-build.json')), 'the fix is recorded as another builder run of try 1');
});

test('I01: a second failure gets a read-only diagnosis whose brief drives one more fix', (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, gateFixes: 1, diagnoser: DIAG }, scenario: { a: 'break,fix:noop1' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['merged', 0]);
  const [d] = s.calls('diagnose', 'a'), fixes = s.calls('fix', 'a');
  assert.ok(d); assert.equal(d.args[d.args.indexOf('--permission-mode') + 1], 'plan', 'diagnosis is read-only');
  assert.equal(d.model, 'opus'); assert.equal(d.effort, 'high');
  assert.equal(fixes.length, 2); assert.match(fixes[1]!.prompt, /delete broken\.txt and commit/, 'the second fix carries the diagnosis');
  assert.ok(events(s, 'a').some((e) => e.event === 'diagnosis' && /^code: /.test(e.detail)));
});

test('I01: after the diagnosis-driven fix also fails, the failure counts once with the diagnosis in its feedback', (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, gateFixes: 1, diagnoser: DIAG }, scenario: { a: 'break,fix:noop' } });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.equal(s.calls('fix', 'a').length, 2); assert.equal(s.calls('diagnose', 'a').length, 1);
  assert.match(s.feature('a').lastFeedback!, /^test command `test ! -f broken\.txt` exited 1/);
  assert.match(s.feature('a').lastFeedback!, /Diagnosis \(opus\): code/);
});

test('I01: an environment diagnosis gets no builder fix; the same failure on a same-build rerun stops without spending an attempt', (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE_OUT, maxAttempts: 1, gateFixes: 1, diagnoser: DIAG, setupRetryDelaysSec: [] }, scenario: { a: 'break,fix:noop' } });
  const file = join(s.repo, '..', 'diagnoses.json'); (s.env as Record<string, string>).FAKE_DIAGNOSES = file;
  writeFileSync(file, JSON.stringify({ a: [{ fault: 'environment', evidence: 'the database refused connections', fix: 'restart postgres' }] }));
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('fix', 'a').length, 1);
  const a = s.feature('a');
  assert.deepEqual([a.status, a.attempts, a.stop, a.envFailures], ['stuck', 0, { attempt: 1, counted: false }, 1]);
  assert.match(a.lastFeedback!, /Diagnosis \(opus\): environment/);
  const ev = events(s, 'a');
  assert.equal(ev.filter((e) => e.event === 'testing').length, 3, 'the build, the fix, and one rerun of the same build');
  assert.ok(ev.some((e) => e.event === 'env-rerun'));
  const stop = ev.find((e) => e.event === 'stuck')!;
  assert.equal(stop.cause, 'environment'); assert.equal(stop.sha, a.envBuild);
  assert.equal(a.envBuild, s.git('rev-parse', 'ship/a'), 'the tested build is held for revalidation');
});

const ENV_DIAG = (n: number) => Array.from({ length: n }, () => ({ fault: 'environment', evidence: 'a worker backlog delayed the receipt past 30s', fix: 'isolate the fixture queue' }));
const scriptDiagnoses = (s: Setup, d: Record<string, unknown[]>) => { const file = join(s.repo, '..', 'diagnoses.json'); (s.env as Record<string, string>).FAKE_DIAGNOSES = file; writeFileSync(file, JSON.stringify(d)); };

test('environment: when the same-build rerun passes, the pass goes on to evaluation and merges with no attempt spent', (t) => {
  const gate = 'test -f ../gate-$FACTOS_FEATURE || { touch ../gate-$FACTOS_FEATURE; echo "FAIL apps/worker/src/process-webhook.db.test.ts"; exit 1; }';
  const s = setup(t, { features: [F('a')], config: { test: gate, maxAttempts: 1, diagnoser: DIAG } });
  scriptDiagnoses(s, { a: ENV_DIAG(1) });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').envFailures], ['merged', 0, undefined]);
  assert.equal(s.calls('fix', 'a').length, 0); assert.equal(s.calls('build', 'a').length, 1);
});

test('environment: a rerun that fails differently is an ordinary counted failure, not another environment stop', (t) => {
  const gate = 'if [ -f ../g-$FACTOS_FEATURE ]; then echo "FAIL packages/b.test.ts"; else touch ../g-$FACTOS_FEATURE; echo "FAIL packages/a.test.ts"; fi; exit 1';
  const s = setup(t, { features: [F('a')], config: { test: gate, maxAttempts: 1, diagnoser: DIAG, setupRetryDelaysSec: [] } });
  scriptDiagnoses(s, { a: ENV_DIAG(1) });
  assert.equal(s.cli('run').status, 2);
  const a = s.feature('a');
  assert.deepEqual([a.status, a.attempts, a.stop, a.envFailures], ['stuck', 1, { attempt: 1, counted: true }, undefined]);
});

test('environment: the held build is revalidated after the delay without a rebuild; the next episode past the delays is an uncounted stuck the observer leaves alone', async (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE_OUT, maxAttempts: 1, diagnoser: DIAG, setupRetryDelaysSec: [1] }, scenario: { a: 'break' } });
  scriptDiagnoses(s, { a: ENV_DIAG(2) });
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  const a = s.feature('a');
  assert.deepEqual([a.status, a.attempts, a.envFailures], ['stuck', 0, 2]);
  assert.equal(s.calls('build', 'a').length, 1, 'one build; the second pass revalidated it');
  assert.ok(events(s, 'a').some((e) => e.event === 'build-skipped' && /held after an environmental gate failure/.test(e.detail)));
  assert.equal(s.calls('diagnose', 'a').length, 2, 'the held pass has no builder session, and is still diagnosed');
  const obs = await observeOnce(s.repo, { out: () => {} });
  assert.equal(obs.diagnoses.at(-1)!.cause, 'environment');
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 0], 'not reset as an infrastructure retry');
  assert.doesNotMatch(s.log(), /"event":"observer-retry"/);
  assert.equal(s.cli('retry', 'a').status, 0);
  assert.equal(s.feature('a').envFailures, undefined, 'a person\'s retry clears the environment count');
});

test('I01: a diagnosis that edits the worktree is refused and its edits are undone', (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, gateFixes: 1, diagnoser: DIAG }, scenario: { a: 'break,fix:noop,diagnose:edit' } });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('fix', 'a').length, 1, 'no fix from a refused diagnosis');
  assert.ok(events(s, 'a').some((e) => e.event === 'diagnosis' && /refused/.test(e.detail)));
  const wt = join(s.repo, '..', 'app-worktrees', 'a');
  assert.equal(existsSync(join(wt, 'diagnoser.txt')), false);
  assert.doesNotMatch(execFileSync('git', ['log', '--format=%s', 'ship/a'], { cwd: s.repo, encoding: 'utf8' }), /diagnoser\.txt/);
});

test('I01: edits to tests that exist on base reach the evaluator; new test files do not', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 }, scenario: { a: 'skip-test,new-test' } });
  writeFileSync(join(s.repo, 'a.test.ts'), "it('works', () => {\n  expect(1).toBe(1);\n});\n");
  s.git('add', 'a.test.ts'); s.git('commit', '-qm', 'an existing test');
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const [ev] = s.calls('eval', 'a');
  assert.match(ev!.prompt, /Existing tests this branch changes/);
  assert.match(ev!.prompt, /a\.test\.ts: adds `\.skip`/);
  assert.match(ev!.prompt, /a\.test\.ts: removes 3 lines/);
  assert.doesNotMatch(ev!.prompt, /a-new\.test\.ts: /, 'a new test file is not listed as an edit');
  assert.ok(events(s, 'a').some((e) => e.event === 'test-edits' && /a\.test\.ts/.test(e.detail)));
});

test('I01: stopping during a resumed fix leaves the feature todo with no attempt spent and no evaluation', async (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, gateFixes: 1 }, scenario: { a: 'break' } });
  s.env.FAKE_DELAY_MS = '1500';
  const running = s.start();
  assert.ok(await until(() => events(s, 'a').some((e) => e.event === 'gate-fix'), 20000), running.out());
  running.cp.kill('SIGINT');
  await running.exit;
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['todo', 0]);
  assert.equal(s.calls('eval', 'a').length, 0);
  assert.ok(events(s, 'a').some((e) => e.event === 'interrupted'));
});

// ---- I02: Codex for the read-only roles, with a Claude fallback (docs/improvements.md) ----
const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex.ts', import.meta.url));
const SOL = { provider: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'auto' };
const codexSetup = (t: TestContext, o: Parameters<typeof setup>[1]) => {
  chmodSync(FAKE_CODEX, 0o755);
  const s = setup(t, o); (s.env as Record<string, string>).FACTOS_CODEX = FAKE_CODEX; return s;
};

test('I02: a Codex evaluator reviews with its model and effort; its verdict decides the merge', (t) => {
  const s = codexSetup(t, { features: [F('a')], config: { evaluator: SOL } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
  const [codex] = s.calls('codex', 'a'), [ev] = s.calls('eval', 'a');
  assert.ok(codex); assert.equal(codex.model, 'gpt-6.1-sol'); assert.equal(codex.effort, 'high');
  assert.ok(codex.args.includes('workspace-write') && codex.args.includes('--json'), 'sandboxed, JSON events');
  assert.equal(ev!.provider, 'codex', 'the verdict came through Codex');
  const run = JSON.parse(readFileSync(join(s.repo, '.fact-os', 'runs', 'a', '1-eval.json'), 'utf8'));
  assert.deepEqual([run.provider, run.model, run.session_id], ['codex', 'gpt-6.1-sol', 'fake-codex-thread']);
  assert.ok(events(s, 'a').some((e) => e.event === 'prompt' && /^evaluator model=gpt-6\.1-sol effort=high/.test(e.detail)));
});

test('I02: a Codex usage limit falls back to Claude Opus high and cools Codex down for later reviews', (t) => {
  const s = codexSetup(t, { features: [F('a'), F('b', { priority: 2 })], config: { evaluator: SOL, maxParallel: 1 },
    scenario: { a: 'codex:limit', b: 'codex:limit' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of ['a', 'b']) assert.equal(s.feature(id).status, 'merged');
  const [ev] = s.calls('eval', 'a');
  assert.deepEqual([ev!.provider, ev!.model, ev!.effort], ['claude', 'opus', 'high']);
  assert.ok(events(s, 'a').some((e) => e.event === 'codex-fallback' && /usage limit/.test(e.detail)));
  assert.equal(s.calls('codex', 'b').length, 0, 'during the cooldown Codex is not called');
  assert.ok(events(s, 'b').some((e) => e.event === 'codex-fallback' && /cooling down/.test(e.detail)));
  assert.ok(existsSync(join(s.repo, '.fact-os', 'codex.json')));
});

test('I02: another Codex failure falls back for that call only, without a cooldown', (t) => {
  const s = codexSetup(t, { features: [F('a')], config: { evaluator: SOL }, scenario: { a: 'codex:fail' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls('eval', 'a')[0]!.provider, 'claude');
  assert.equal(existsSync(join(s.repo, '.fact-os', 'codex.json')), false);
});

test('I02: whatever a Codex review leaves in the worktree is undone before the merge', (t) => {
  const s = codexSetup(t, { features: [F('a')], config: { evaluator: SOL }, scenario: { a: 'codex:edit' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
  assert.equal(existsSync(join(s.repo, '..', 'app-worktrees', 'a', 'codex-was-here.txt')), false);
  assert.ok(events(s, 'a').some((e) => e.event === 'codex-cleaned'));
});

test('I02: a Codex diagnoser diagnoses a repeated gate failure', (t) => {
  const s = codexSetup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, gateFixes: 1, diagnoser: SOL },
    scenario: { a: 'break,fix:noop1' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
  assert.equal(s.calls('diagnose', 'a')[0]!.provider, 'codex');
  assert.match(s.feature('a').lastFeedback ?? '', /^$/);
});

test('I03: a tiered feature launches its builder and reviewer with the tier models of the active profile', async (t) => {
  const s = codexSetup(t, { features: [F('a', { tier: 'risky' }), F('b', { priority: 2 })], config: { maxParallel: 1, profiles: { tiered: {
    builder: { model: 'sonnet', effort: 'medium' }, evaluator: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    tiers: { risky: { builder: { model: 'opus', effort: 'high' }, evaluator: { effort: 'xhigh' } } } } } } });
  await writeControl(s.repo, { profile: 'tiered' }, 'cli');
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const build = (id: string) => s.calls('build', id)[0]!, review = (id: string) => s.calls('codex', id)[0]!;
  assert.deepEqual([build('a').model, build('a').effort, review('a').effort], ['opus', 'high', 'xhigh']);
  assert.deepEqual([build('b').model, build('b').effort, review('b').effort], ['sonnet', 'medium', 'high'], 'untiered: the profile itself');
  assert.ok(events(s, 'a').some((e) => e.event === 'prompt' && /^builder model=opus effort=high .* tier=risky$/.test(e.detail)));
});

// ---- I04: resume the builder once when it leaves work uncommitted (docs/improvements.md) ----
test('I04: commitFixes 0 keeps uncommitted work an ordinary counted failure', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 }, scenario: { a: 'dirty' } });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.match(s.feature('a').lastFeedback!, /^commit your work: the worktree has uncommitted changes/);
  assert.equal(s.calls('fix', 'a').length, 0);
});

test('I04: uncommitted work after a build resumes the same session once to commit it; the pass goes on', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, commitFixes: 1 }, scenario: { a: 'dirty' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['merged', 0]);
  const [fix] = s.calls('fix', 'a');
  assert.ok(fix); assert.equal(fix.args[fix.args.indexOf('--resume') + 1], 'fake');
  assert.match(fix.prompt, /not committed/); assert.match(fix.prompt, /leftover\.txt/);
  const ev = events(s, 'a').map((e) => e.event);
  assert.equal(ev.filter((e) => e === 'launch').length, 1); assert.equal(ev.filter((e) => e === 'commit-fix').length, 1);
  assert.equal(ev.filter((e) => e === 'failed').length, 0);
});

test('I04: a build with no commits at all is not resumed', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, commitFixes: 1 }, scenario: { a: 'noop' } });
  assert.equal(s.cli('run').status, 2);
  assert.match(s.feature('a').lastFeedback!, /has no commits beyond main/);
  assert.equal(s.calls('fix', 'a').length, 0);
});

test('I04: work still uncommitted after the resume counts exactly one failure', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 2, commitFixes: 1 }, scenario: { a: 'dirty,fix:noop' } });
  s.cli('run', '--once');
  assert.deepEqual([s.feature('a').attempts, s.calls('fix', 'a').length], [1, 1]);
  assert.equal(events(s, 'a').filter((e) => e.event === 'failed').length, 1);
});

test('I04: a gate fix that leaves work uncommitted is resumed once to commit it', (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, gateFixes: 1, commitFixes: 1 }, scenario: { a: 'break,fix:dirty1' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
  assert.equal(s.calls('fix', 'a').length, 2);
  assert.deepEqual(events(s, 'a').map((e) => e.event).filter((e) => e === 'gate-fix' || e === 'commit-fix'), ['gate-fix', 'commit-fix']);
});

test('I04: the commit allowance is spent once per pass', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, commitFixes: 1 }, scenario: { a: 'dirty,fix:dirty1' } });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('fix', 'a').length, 1, 'the resume left new dirt; no second resume');
  assert.match(s.feature('a').lastFeedback!, /leftover-fix\.txt/);
});

test('I04 review: lost dependency ancestry is not resumed even when the worktree is also dirty', (t) => {
  const s = setup(t, { features: [], config: { merge: 'manual', maxAttempts: 1, commitFixes: 1 } });
  staleDependency(s, { conflict: true });
  const provider = join(s.repo, '.fact-os/provider.sh'), calls = join(s.repo, '.fact-os/calls');
  writeFileSync(provider, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in\n  *--resume*) git add -A; git commit -qm leftover ;;\n` +
    `  *) git merge --abort; echo built > b.txt; git add b.txt; git commit -qm built; echo leftover > leftover.txt ;;\nesac\n` +
    `printf '%s' '{"type":"result","is_error":false,"result":"done","session_id":"original","total_cost_usd":0}'\n`, { mode: 0o755 });
  s.env.FACTOS_CLAUDE = provider;
  assert.equal(s.cli('run').status, 2);
  assert.match(s.feature('b').lastFeedback!, /declared merged dependencies/);
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'no paid resume for a failure a commit cannot repair');
});

test('I04 review: an unfinished foreman merge is committed by the resume before deferred setup runs', (t) => {
  const s = setup(t, { features: [], config: { merge: 'manual', maxAttempts: 1, commitFixes: 1, conflictBrief: true,
    prepare: '! git rev-parse --quiet --verify MERGE_HEAD && test -f a.txt' }, scenario: { b: 'noop' } });
  staleDependency(s, { conflict: true });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('b').status, s.feature('b').attempts], ['ready', 0]);
  assert.equal(s.calls('fix', 'b').length, 1);
  assert.ok(events(s, 'b').some((e) => e.event === 'commit-fix'));
  assert.ok(events(s, 'b').some((e) => e.event === 'keep-check' && /^ok/.test(e.detail)), 'the keep-lines check still runs on the resolution');
});

test('I04 review: a commit-only resume does not repair the gate; the gate fix still runs with its own allowance', (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, gateFixes: 1, commitFixes: 1 }, scenario: { a: 'dirty,break' } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
  assert.deepEqual(events(s, 'a').map((e) => e.event).filter((e) => e === 'gate-fix' || e === 'commit-fix'), ['commit-fix', 'gate-fix']);
});

test('I04 review: the commit allowance spent after the build is not available to a later gate fix', (t) => {
  const s = setup(t, { features: [F('a')], config: { test: GATE, maxAttempts: 1, gateFixes: 1, commitFixes: 1 }, scenario: { a: 'dirty,break,fix:gatedirty' } });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('fix', 'a').length, 2, 'one commit resume, one gate fix, no second commit resume');
  assert.match(s.feature('a').lastFeedback!, /leftover-gate\.txt/);
});

// ---- I06: the evaluator knows what the build was allowed to mock ----
test('I06: on-mock tasks captured at launch reach the evaluator even when the task closes during the build', (t) => {
  const s = setup(t, { features: [F('a'), F('b', { onMock: true, priority: 2 })], config: { maxParallel: 1 }, scenario: { a: 'close-tasks' } });
  writeFileSync(join(s.repo, '.fact-os/human.json'), JSON.stringify({ tasks: [
    { id: 'H-API', title: 'Partner API access', steps: ['confirm the partner API'], unblocks: ['a'], mockable: true, status: 'open' }] }));
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const [ev] = s.calls('eval', 'a');
  assert.match(ev!.prompt, /ON MOCK/); assert.match(ev!.prompt, /H-API: Partner API access/);
  assert.equal(events(s, 'a').find((e) => e.event === 'launch')!.detail, 'onMock');
  assert.doesNotMatch(s.calls('eval', 'b')[0]!.prompt, /ON MOCK/, 'a stale onMock flag without open tasks stays strict');
  assert.equal(s.feature('b').onMock, false);
});

// I06 review regressions (ported from the independent Codex review's scratch probes)
const mockTask = (id = 'H-API', patch: Record<string, unknown> = {}) => ({ id, title: `API ${id}`, steps: [`scope ${id}`], unblocks: ['a'], mockable: true, status: 'open', ...patch });
const humanTasks = (s: Setup, tasks: unknown[]) => writeFileSync(join(s.repo, '.fact-os/human.json'), JSON.stringify({ tasks }));

test('I06 review: a blocker that turns unmockable before the claim makes --watch wait, not exit', async (t) => {
  const s = setup(t, { features: [F('a')] }); humanTasks(s, [mockTask()]);
  const fixture = fileURLToPath(new URL('./fixtures/onmock-watch.ts', import.meta.url));
  const cp = spawn(process.execPath, [fixture, s.repo], { cwd: s.repo, env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; cp.stdout.on('data', (d) => { out += d; }); cp.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((r) => cp.once('exit', r)); t.after(() => { if (cp.exitCode === null) cp.kill('SIGKILL'); });
  assert.ok(await until(() => existsSync(join(s.repo, '.fact-os/launch-wait'))), out);
  await mutate(s.repo, 'human', (d) => { d.tasks[0]!.mockable = false; });
  writeFileSync(join(s.repo, '.fact-os/launch-release'), 'edited');
  await sleep(400);
  assert.equal(s.calls('build', 'a').length, 0);
  assert.equal(cp.exitCode, null, 'watch exited instead of waiting: ' + out);
  await mutate(s.repo, 'human', (d) => { d.tasks[0]!.mockable = true; });
  assert.equal(await exit, 0, out);
});

test('I06 review: the inline resolver and the gate diagnoser get the same frozen mock scope', (t) => {
  const r1 = setup(t, { features: [F('a')], config: { refreshBeforeTest: true, resolver: { model: 'fake' } }, scenario: { a: 'close-tasks,base-conflict' } });
  humanTasks(r1, [mockTask()]); let r = r1.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r1.calls('resolve', 'a')[0]!.prompt, /ON MOCK[\s\S]*H-API: API H-API/);
  const d1 = setup(t, { features: [F('a')], config: { test: GATE, gateFixes: 1, diagnoser: { model: 'fake' }, maxAttempts: 1 }, scenario: { a: 'break,close-tasks,fix:noop1' } });
  humanTasks(d1, [mockTask()]); r = d1.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(d1.calls('diagnose', 'a')[0]!.prompt, /ON MOCK[\s\S]*H-API: API H-API/);
});

test('I06 review: several tasks and their scopes are shared; unrelated and done tasks never authorize a mock', (t) => {
  const s = setup(t, { features: [F('a')] });
  humanTasks(s, [mockTask('H-ONE'), mockTask('H-TWO'), mockTask('H-DONE', { status: 'done' }), mockTask('H-OTHER', { unblocks: [] })]);
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const mode of ['build', 'eval']) {
    const p = s.calls(mode, 'a')[0]!.prompt;
    for (const id of ['H-ONE', 'H-TWO']) { assert.match(p, new RegExp(`${id}: API ${id}`)); assert.match(p, new RegExp(`scope ${id}`)); }
    assert.doesNotMatch(p, /H-DONE|H-OTHER/);
  }
});

test('I06 review: a repeated evaluation in the same pass keeps the launch scope after tasks close, reopen and broaden', async (t) => {
  const s = setup(t, { features: [F('a'), F('b')], config: { maxParallel: 2, refreshBeforeTest: true, maxAttempts: 1 }, scenario: { a: 'close-tasks,slow' } });
  humanTasks(s, [mockTask('H-ONE')]); parallelGate(s, 'true');
  const run = s.start(); assert.ok(await until(() => s.feature('a').status === 'evaluating'), run.out());
  await mutate(s.repo, 'human', (d) => { Object.assign(d.tasks[0]!, { status: 'open', title: 'expanded title', steps: ['broadened capability'] }); });
  assert.equal(await run.exit, 0, run.out());
  const ev = s.calls('eval', 'a'); assert.equal(ev.length, 2);
  for (const call of ev) { assert.match(call.prompt, /H-ONE: API H-ONE/); assert.doesNotMatch(call.prompt, /expanded title|broadened capability/); }
});

test('I06 review: a real state defect still rejects an on-mock feature and counts a failure', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 }, verdicts: { a: [{ pass: true, findings: [{ check: 'a.txt exists', ok: true, evidence: 'checked' }],
    cheating: [], blocking: ['cancellation ignores in_production'], notes: [], lesson: null }] } });
  humanTasks(s, [mockTask('H-ONE')]); const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  const p = s.calls('eval', 'a')[0]!.prompt;
  assert.match(p, /any defect in money, auth, tenant isolation or state handling/);
  assert.match(p, /development-only setting \(outside the on-mock tasks below\)/);
  assert.match(p, /a fake or a development setting outside the on-mock tasks below/, 'both unconditional rules carry the exception');
  assert.match(p, /a fake enabled in production still blocks/);
});

for (const change of ['unmockable', 'edited']) test(`I06 review: the locked claim sees a task ${change} after scheduling`, async (t) => {
  const s = setup(t, { features: [F('a')] }); humanTasks(s, [mockTask('H-API', { steps: ['original scope'] })]);
  const fixture = fileURLToPath(new URL('./fixtures/acceptance-launch.ts', import.meta.url));
  const cp = spawn(process.execPath, [fixture, s.repo], { cwd: s.repo, env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; cp.stdout.on('data', (d) => { out += d; }); cp.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((r) => cp.once('exit', r)); t.after(() => { if (cp.exitCode === null) cp.kill('SIGKILL'); });
  assert.ok(await until(() => existsSync(join(s.repo, '.fact-os/launch-wait'))), out);
  await mutate(s.repo, 'human', (d) => { if (change === 'unmockable') d.tasks[0]!.mockable = false; else d.tasks[0]!.steps = ['updated at claim']; });
  writeFileSync(join(s.repo, '.fact-os/launch-release'), 'edited');
  assert.equal(await exit, change === 'unmockable' ? 2 : 0, out);
  if (change === 'unmockable') { assert.equal(s.calls('build', 'a').length, 0); assert.equal(s.feature('a').status, 'todo'); }
  else for (const mode of ['build', 'eval']) { assert.match(s.calls(mode, 'a')[0]!.prompt, /updated at claim/); assert.doesNotMatch(s.calls(mode, 'a')[0]!.prompt, /original scope/); }
});

test('I06 review: the next launch takes a fresh scope, even when it reuses the build', (t) => {
  const s = setup(t, { features: [F('a')], config: { refreshBeforeTest: true }, scenario: { a: 'close-tasks' } });
  humanTasks(s, [mockTask()]); writeFileSync(join(s.repo, 'README.md'), 'local edit\n');
  let r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(s.feature('a').status, 'ready');
  s.git('checkout', '-q', 'README.md'); s.git('commit', '--allow-empty', '-qm', 'user advance');
  r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls('build', 'a').length, 1); const ev = s.calls('eval', 'a'); assert.equal(ev.length, 2);
  assert.match(ev[0]!.prompt, /H-API: API H-API/); assert.doesNotMatch(ev[1]!.prompt, /ON MOCK/);
  assert.equal(s.feature('a').onMock, false);
});

for (const fallback of [false, true]) test(`I06 review: the Codex${fallback ? ' fallback' : ''} evaluator gets the same on-mock prompt`, (t) => {
  const s = codexSetup(t, { features: [F('a')], config: { evaluator: SOL }, scenario: { a: 'close-tasks' + (fallback ? ',codex:fail' : '') } });
  humanTasks(s, [mockTask(), mockTask('H-OTHER', { unblocks: ['different'] }), mockTask('H-DONE', { status: 'done' })]);
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const cp = s.calls('codex', 'a')[0]!.prompt, ep = s.calls('eval', 'a')[0]!.prompt;
  assert.equal(cp, ep); assert.match(ep, /H-API: API H-API/); assert.doesNotMatch(ep, /H-OTHER|H-DONE/);
});

// ---- I05: setup failures spend no attempts; bounded retries, then a launch hold (docs/improvements.md) ----
const setupGate = (s: Setup) => {
  const base = join(s.repo, '..'), down = join(base, 'db-down'), runs = join(base, 'prepare-runs');
  return { down, runs, prepare: `echo "$FACTOS_FEATURE" >> '${runs}'; if [ -f '${down}' ]; then echo "prepare: dev Postgres is not accepting connections"; exit 3; fi`,
    count: (id?: string) => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter((l) => l && (!id || l === id)).length : 0) };
};

test('I05: a feature whose setup keeps failing retries with delays, then goes stuck without spending an attempt', (t) => {
  const s = setup(t, { features: [F('a')], config: { setupRetryDelaysSec: [0.05, 0.05] } });
  const g = setupGate(s); writeFileSync(g.down, ''); s.cli('init');
  writeFileSync(join(s.repo, '.fact-os/config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(s.repo, '.fact-os/config.json'), 'utf8')), prepare: g.prepare }));
  const r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').stop], ['stuck', 0, { attempt: 1, counted: false }]);
  assert.equal(g.count('a'), 3, 'the first try and two delayed retries');
  assert.equal(s.calls('build', 'a').length, 0);
  assert.match(s.feature('a').lastFeedback!, /not accepting connections/);
  assert.equal(events(s, 'a').filter((e) => e.event === 'failed' && /setup failure \d of 3; retry after/.test(e.detail)).length, 2);
});

test('I05: a transient setup failure is retried and the feature then builds normally', (t) => {
  const s = setup(t, { features: [F('a')], config: { setupRetryDelaysSec: [0.05, 0.05] } });
  const base = join(s.repo, '..'), flag = join(base, 'fail-once');
  writeFileSync(flag, '');
  writeFileSync(join(s.repo, '.fact-os/config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(s.repo, '.fact-os/config.json'), 'utf8')),
    prepare: `if [ -f '${flag}' ]; then rm '${flag}'; echo "dev:setup failed"; exit 1; fi` }));
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').setupFailures], ['merged', 0, undefined]);
});

test('I05: repeated setup failures across features open a sticky launch hold that survives a restart until setup-resume', (t) => {
  const s = setup(t, { features: [F('a'), F('b'), F('c'), F('d', { priority: 5 })], config: { maxParallel: 3, setupRetryDelaysSec: [30, 120] } });
  const g = setupGate(s); writeFileSync(g.down, '');
  writeFileSync(join(s.repo, '.fact-os/config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(s.repo, '.fact-os/config.json'), 'utf8')), prepare: g.prepare }));
  let r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  const before = g.count();
  assert.ok(before >= 3 && before <= 4, `three failures open the hold; at most one launch already under way overshoots (${before})`);
  const hold = JSON.parse(readFileSync(join(s.repo, '.fact-os/setup-hold.json'), 'utf8')).hold;
  assert.ok(hold && hold.features.length >= 2, JSON.stringify(hold));
  assert.equal(s.log().split('\n').filter((l) => l.includes('"event":"setup-hold"')).length, 1);
  for (const id of ['a', 'b', 'c', 'd']) assert.deepEqual([s.feature(id).status, s.feature(id).attempts], ['todo', 0]);
  r = s.cli('run'); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(g.count(), before, 'the hold survives a restart: nothing launches');
  rmSync(g.down); assert.equal(s.cli('setup-resume').status, 0);
  assert.equal(JSON.parse(readFileSync(join(s.repo, '.fact-os/setup-hold.json'), 'utf8')).hold, null);
  writeFileSync(join(s.repo, '.fact-os/config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(s.repo, '.fact-os/config.json'), 'utf8')), setupRetryDelaysSec: [0.05, 0.05] }));
  r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(s.feature(id).status, 'merged');
});

test('I05: a person retrying a setup-stuck feature clears its setup count', (t) => {
  const s = setup(t, { features: [F('a', { status: 'stuck', attempts: 0, setupFailures: 3, stop: { attempt: 1, counted: false } })] });
  assert.equal(s.cli('retry', 'a').status, 0);
  assert.deepEqual([s.feature('a').status, s.feature('a').setupFailures], ['todo', undefined]);
});

// I05 review regressions (ported from the independent Codex review's scratch probes)
test('I05 review: the observer never replenishes a setup-stuck feature, even when its output names infrastructure', async (t) => {
  const s = setup(t, { features: [F('a', { attempts: 1, refreshes: 2 })], config: { setupRetryDelaysSec: [], prepare: 'echo ECONNREFUSED; exit 3' } });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').refreshes], ['stuck', 1, 2]);
  const obs = await observeOnce(s.repo, { out: () => {} });
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').refreshes], ['stuck', 1, 2]);
  assert.equal(obs.diagnoses.at(-1)!.cause, 'setup');
});

test('I05 review: a run without --watch, paused, drains and exits without waiting out a setup deadline', async (t) => {
  const s = setup(t, { features: [F('a', { setupFailures: 1, setupRetryAt: new Date(Date.now() + 3000).toISOString() })], config: { prepare: 'exit 3' } });
  await writeControl(s.repo, { paused: true }, 'cli');
  const at = Date.now(), r = s.cli('run'), elapsed = Date.now() - at;
  assert.equal(r.status, 2); assert.ok(elapsed < 1500, `waited ${elapsed}ms`);
});

test('I05 review: a hold opening mid-run leaves no retry timer keeping the CLI alive', (t) => {
  const s = setup(t, { features: [F('a', { setupFailures: 1, setupRetryAt: new Date(Date.now() + 2500).toISOString() }), F('b')],
    config: { maxParallel: 2, prepare: 'sleep 0.3; echo database down; exit 3' } });
  writeFileSync(join(s.repo, '.fact-os/setup-hold.json'), JSON.stringify({ failures: [{ feature: 'a', ts: new Date().toISOString() }, { feature: 'c', ts: new Date().toISOString() }], hold: null }));
  const at = Date.now(), r = s.cli('run'), elapsed = Date.now() - at;
  assert.equal(r.status, 2);
  assert.ok(JSON.parse(readFileSync(join(s.repo, '.fact-os/setup-hold.json'), 'utf8')).hold);
  assert.ok(elapsed < 1500, `waited ${elapsed}ms`);
});

test('I05 review: a deferred setup failure after a paid build is not counted as setup before any model ran', (t) => {
  const s = setup(t, { features: [], config: { merge: 'manual', prepare: 'exit 7', setupRetryDelaysSec: [] }, scenario: { b: 'resolve' } });
  staleDependency(s, { conflict: true });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.calls('build', 'b').length, 1);
  const stats = agentStats(events(s, 'b') as LogEvent[], [], 0);
  assert.equal(stats.reduce((n, e) => n + e.setup, 0), 0, 'the builder already ran');
  assert.equal(stats.reduce((n, e) => n + e.built, 0), 1);
});

test('I05 review: setup retries really wait their delays', (t) => {
  const s = setup(t, { features: [F('a')], config: { setupRetryDelaysSec: [0.4, 0.4], prepare: 'exit 3' } });
  const at = Date.now(); assert.equal(s.cli('run').status, 2);
  assert.ok(Date.now() - at >= 800, `the two delays were not waited (${Date.now() - at}ms)`);
  assert.equal(s.feature('a').status, 'stuck');
});

test('I05 review: a good setup between failures resets the streak, so no hold opens', (t) => {
  const s = setup(t, { features: [F('a'), F('b', { priority: 2 }), F('c', { priority: 3 }), F('d', { priority: 4 })],
    config: { maxParallel: 1, setupRetryDelaysSec: [], prepare: 'case "$FACTOS_FEATURE" in a|b|d) echo down; exit 3;; esac' } });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => s.feature(id).status), ['stuck', 'stuck', 'merged', 'stuck']);
  const st = existsSync(join(s.repo, '.fact-os/setup-hold.json')) ? JSON.parse(readFileSync(join(s.repo, '.fact-os/setup-hold.json'), 'utf8')) : { hold: null };
  assert.equal(st.hold, null, 'two failures, a success, one failure: no three in a row');
});

// ---- keep-lines repair (keepFixes) and the declaration forms builders actually write ----
test('keepFixes: a builder resolution that lost lines resumes the same session once, declares them, and is accepted without spending an attempt', (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0 }), F('a', { branch: 'ship/a' })],
    config: { maxAttempts: 1, maxParallel: 1, conflictBrief: true, keepFixes: 1 }, scenario: { a: 'resolve-drop' } });
  conflict(s, 'b', { branch: 'from b\n' });
  conflict(s, 'a', { branch: 'from a\n' });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['merged', 0]);
  const [fix] = s.calls('fix', 'a');
  assert.ok(fix); assert.match(fix.prompt, /^The foreman checked the merge you resolved/);
  assert.match(fix.prompt, /\n {2}dropped: shared\.txt: from b$/m);
  const ev = events(s, 'a').map((e) => e.event);
  assert.equal(ev.filter((e) => e === 'keep-fix').length, 1);
  assert.equal(ev.filter((e) => e === 'failed' || e === 'stuck').length, 0);
  const [evl] = s.calls('eval', 'a').slice(-1);
  assert.match(evl!.prompt, /dropped on purpose[\s\S]*shared\.txt: `from b`/, 'the evaluator sees the declared drop');
});

test('keepFixes 0: a lost-lines resolution is a counted failure, as before', (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0 }), F('a', { branch: 'ship/a' })],
    config: { maxAttempts: 1, maxParallel: 1, conflictBrief: true, keepFixes: 0 }, scenario: { a: 'resolve-drop' } });
  conflict(s, 'b', { branch: 'from b\n' });
  conflict(s, 'a', { branch: 'from a\n' });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.equal(s.calls('fix', 'a').length, 0);
  assert.match(s.feature('a').lastFeedback!, /^The merge resolution lost lines[\s\S]*dropped: shared\.txt: from b/);
});

test('keepFixes: a resume that declares nothing counts once', (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0 }), F('a', { branch: 'ship/a' })],
    config: { maxAttempts: 1, maxParallel: 1, conflictBrief: true, keepFixes: 1 }, scenario: { a: 'resolve-drop,fix:noop' } });
  conflict(s, 'b', { branch: 'from b\n' });
  conflict(s, 'a', { branch: 'from a\n' });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.equal(s.calls('fix', 'a').length, 1);
});

test('the declaration form builders wrote in the field (line in backticks, reason after it) passes the keep-lines check', (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0 }), F('a', { branch: 'ship/a' })],
    config: { maxAttempts: 1, maxParallel: 1, conflictBrief: true, keepFixes: 0 }, scenario: { a: 'resolve-drop-bt' } });
  conflict(s, 'b', { branch: 'from b\n' });
  conflict(s, 'a', { branch: 'from a\n' });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['merged', 0]);
  assert.ok(events(s, 'a').some((e) => e.event === 'keep-check' && /^ok/.test(e.detail)));
});

test('inherited mock allowance: a feature whose dependency is built on a named mock gets that task, with provenance, in every role', (t) => {
  const s = setup(t, { features: [F('a', { status: 'merged', onMock: true }), F('b', { deps: ['a'] })], config: { maxAttempts: 1 } });
  humanTasks(s, [{ ...mockTask('C02', { unblocks: ['a'], title: 'Shipping partner account' }) }]);
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(events(s, 'b').find((e) => e.event === 'launch')!.detail, 'onMock');
  for (const mode of ['build', 'eval'] as const) {
    const [c] = s.calls(mode, 'b');
    assert.match(c!.prompt, /C02: Shipping partner account \(inherited: open for dependency a, which this feature builds on\)/, mode);
  }
  assert.equal(s.feature('b').onMock, true);
});

// ---- review repair (reviewFixes) ----
const REJECT = { pass: false, findings: [{ check: 'a.txt exists', ok: false, evidence: 'GET credit returns 409 for a saved partial claim (credit.ts:297)' }], cheating: [], blocking: [], lesson: 'superseded advice' };

test('reviewFixes: an actionable rejection resumes the builder once; the gate and a fresh evaluator pass the new commit with no attempt spent', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, reviewFixes: 1 }, verdicts: { a: [REJECT] } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['merged', 0]);
  const [fix] = s.calls('fix', 'a');
  assert.ok(fix); assert.match(fix.prompt, /^An independent evaluator rejected/); assert.match(fix.prompt, /GET credit returns 409/);
  assert.equal(fix.args[fix.args.indexOf('--resume') + 1], 'fake');
  const evals = s.calls('eval', 'a');
  assert.equal(evals.length, 2, 'a fresh evaluation');
  assert.match(s.git('log', '--format=%s', '-3', s.feature('a').sha!), /a-review-fix\.txt/, 'the accepted sha is the fixed commit');
  const ev = events(s, 'a').map((e) => e.event);
  assert.equal(ev.filter((e) => e === 'testing').length, 2); assert.equal(ev.filter((e) => e === 'review-fix').length, 1);
  assert.doesNotMatch(s.log(), /"event":"lesson","detail":"superseded advice"/, 'the superseded rejection\'s lesson is not compounded');
  const files = readdirSync(join(s.repo, '.fact-os', 'runs', 'a'));
  assert.ok(files.includes('1-eval.json') && files.some((x) => /^1\.\d-eval\.json$/.test(x)), `both evaluations kept: ${files}`);
});

test('reviewFixes: a second rejection counts once; cheating, an invalid verdict or no builder session never resume', (t) => {
  const s = setup(t, { features: [F('a'), F('b'), F('c')], config: { maxAttempts: 1, reviewFixes: 1, maxParallel: 1 },
    verdicts: { a: [REJECT, REJECT], b: [{ ...REJECT, cheating: ['hard-coded result'] }], c: [{ pass: true, findings: [] } as never] } });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.calls('fix', 'a').length, s.calls('eval', 'a').length], ['stuck', 1, 1, 2]);
  assert.deepEqual([s.feature('b').status, s.calls('fix', 'b').length], ['stuck', 0]);
  assert.deepEqual([s.feature('c').status, s.calls('fix', 'c').length], ['stuck', 0], 'an invalid verdict is not a repair brief');
});

// ---- no-progress guard (progressFixes) ----
const REJECT_NL = { ...REJECT, lesson: null }; // a lesson commit moves base, which is a changed validation input
test('no progress: a build that leaves the rejected content unchanged resumes once; the new commit is gated and evaluated', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 2 }, scenario: { a: 'same-again' }, verdicts: { a: [REJECT_NL] } });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, s.feature('a').rejected], ['merged', 1, undefined]);
  const [fix] = s.calls('fix', 'a');
  assert.ok(fix); assert.match(fix.prompt, /^Your branch still has exactly the content the evaluator rejected/); assert.match(fix.prompt, /GET credit returns 409/);
  assert.ok(events(s, 'a').some((e) => e.event === 'progress-fix'));
  assert.equal(s.calls('eval', 'a').length, 2);
  for (const c of [...s.calls('build', 'a'), fix]) assert.match(c.prompt, /wait for every command needed for acceptance to complete/, 'the finish rule, first and resumed');
});

test('no progress: unchanged after the resume (or only an empty commit) is a counted failure with no gate and no evaluation', (t) => {
  for (const flag of ['fix:noop', 'fix:empty']) {
    const s = setup(t, { features: [F('a')], config: { maxAttempts: 2 }, scenario: { a: `same-again,${flag}` }, verdicts: { a: [REJECT_NL] } });
    assert.equal(s.cli('run').status, 2);
    assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 2], flag);
    assert.match(s.feature('a').lastFeedback!, /^no progress: the branch still has the content of [0-9a-f]{12}, which the evaluator rejected/);
    assert.equal(s.calls('eval', 'a').length, 1, `${flag}: no second evaluation`);
    assert.equal(events(s, 'a').filter((e) => e.event === 'testing').length, 1, `${flag}: no second gate`);
  }
});

test('no progress: changed validation inputs (edited acceptance) justify validating identical code', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 3, progressFixes: 0 }, scenario: { a: 'same-again' }, verdicts: { a: [REJECT_NL] } });
  s.cli('run', '--max-features', '1');
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts, !!s.feature('a').rejected], ['todo', 1, true]);
  const file = join(s.repo, '.fact-os', 'features.json'), d = JSON.parse(readFileSync(file, 'utf8')) as FeaturesFile;
  d.features[0]!.acceptance = ['a.txt exists, with any content']; writeFileSync(file, JSON.stringify(d));
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
  assert.equal(s.calls('eval', 'a').length, 2, 'the unchanged code was validated against the edited acceptance');
});

// ---- regressions from the Codex review of the stuck-feature fixes ----
test('review F1: a gate that passes consumes the held environment build; a later send-back builds again', (t) => {
  const gate = 'n=$(cat ../g-$FACTOS_FEATURE 2>/dev/null || echo 0); echo $((n+1)) > ../g-$FACTOS_FEATURE; [ "$n" -ge 2 ] || { echo "FAIL apps/worker/src/process-webhook.db.test.ts > settles"; echo "Error: timed out waiting for the receipt to settle"; exit 1; }';
  const s = setup(t, { features: [F('a')], config: { test: gate, maxAttempts: 2, diagnoser: DIAG, setupRetryDelaysSec: [1] }, verdicts: { a: [REJECT] } });
  scriptDiagnoses(s, { a: ENV_DIAG(1) });
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
  assert.equal(s.feature('a').envBuild, undefined);
  assert.equal(s.calls('build', 'a').length, 2, 'the held build was revalidated once; after its rejection the next pass built again');
});

test('review F2: --watch waits on a planning hold and launches it when a person releases it', async (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 2 } });
  const config = loadConfig(s.repo), file = join(s.repo, '.fact-os', 'features.json'), d = JSON.parse(readFileSync(file, 'utf8')) as FeaturesFile;
  d.features[0]!.planningHold = { cause: 'spec-error', confidence: 'high', evidence: ['x'], review: 'a/1', passEnd: '', inputs: holdInputs(s.repo, config, d.features[0]!), ts: '' };
  writeFileSync(file, JSON.stringify(d));
  const run = s.start('--watch');
  await sleep(1500);
  assert.equal(run.cp.exitCode, null, `still watching: ${run.out()}`); assert.equal(s.calls('build', 'a').length, 0);
  assert.equal(s.cli('release', 'a').status, 0);
  assert.ok(await until(() => s.feature('a').status === 'merged'), run.out());
  run.cp.kill('SIGINT'); await run.exit;
});

test('review F6: a different error in the same test file, or a bare footer, is not the same environment failure', () => {
  const a = failureId('FAIL src/orders.test.ts > receipt\nError: timed out waiting for the receipt to settle (30054ms)\n ELIFECYCLE Command failed with exit code 1.');
  assert.equal(a, failureId('FAIL src/orders.test.ts > receipt\nError: timed out waiting for the receipt to settle (30881ms)\n ELIFECYCLE Command failed with exit code 1.'), 'only timings differ');
  assert.notEqual(a, failureId('FAIL src/orders.test.ts > tenant isolation\nAssertionError: expected 403 to be 200'));
  assert.equal(failureId(' ELIFECYCLE Command failed with exit code 1.'), '', 'a bare footer identifies nothing');
  assert.equal(failureId('FAIL src/orders.test.ts > receipt\nreceipt did not settle'), '', 'a FAIL header without an error line is ambiguous');
});

test('review F8: a resolved environment diagnosis is not attached to a later code failure', (t) => {
  const gate = 'if [ ! -f ../g1-$FACTOS_FEATURE ]; then touch ../g1-$FACTOS_FEATURE; echo "FAIL x.test.ts"; echo "Error: ECONNREFUSED receipt backlog"; exit 1; fi; test ! -f $FACTOS_FEATURE-review-fix.txt';
  const s = setup(t, { features: [F('a')], config: { test: gate, maxAttempts: 1, diagnoser: DIAG, reviewFixes: 1 }, verdicts: { a: [REJECT] } });
  scriptDiagnoses(s, { a: [{ fault: 'environment', evidence: 'ECONNREFUSED on the relay', fix: 'restart' }] });
  assert.equal(s.cli('run').status, 2);
  const a = s.feature('a');
  assert.deepEqual([a.status, a.attempts], ['stuck', 1]);
  assert.doesNotMatch(a.lastFeedback!, /Diagnosis/, 'the old environment note does not label the new failure');
});

test('review F9: an edited brief is a changed validation input; identical code is validated again', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 3, progressFixes: 0 }, scenario: { a: 'same-again' }, verdicts: { a: [REJECT_NL] } });
  s.cli('run', '--max-features', '1');
  assert.ok(s.feature('a').rejected);
  writeFileSync(join(s.repo, 'BRIEF.md'), 'a.txt may hold any content\n');
  const cfg = join(s.repo, '.fact-os', 'config.json'); writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), briefFiles: ['BRIEF.md'] }));
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls('eval', 'a').length, 2);
});

test('review F10: a builder that abandons the foreman\'s merge fails the keep-lines check (counted), no keep repair', (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0 }), F('a', { branch: 'ship/a' })],
    config: { maxAttempts: 1, maxParallel: 1, conflictBrief: true, keepFixes: 1 }, scenario: { a: 'abandon-merge' } });
  conflict(s, 'b', { branch: 'from b\n' });
  conflict(s, 'a', { branch: 'from a\n' });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.match(s.feature('a').lastFeedback!, /no longer contains the merge of main/);
  assert.equal(s.calls('fix', 'a').length, 0);
  assert.ok(s.feature('a').conflict, 'the conflict record is kept');
});

test('recheck R8: an environment note is not attached to a different failure on the same commit', (t) => {
  const gate = 'if [ ! -f ../g1-$FACTOS_FEATURE ]; then touch ../g1-$FACTOS_FEATURE; echo "FAIL src/x.test.ts > relay"; echo "Error: connect ECONNREFUSED 127.0.0.1:5433"; else echo "FAIL src/x.test.ts > tenant"; echo "AssertionError: expected 403 to be 200"; fi; exit 1';
  const s = setup(t, { features: [F('a')], config: { test: gate, maxAttempts: 1, diagnoser: DIAG } });
  scriptDiagnoses(s, { a: [{ fault: 'environment', evidence: 'ECONNREFUSED: the database refused connections', fix: 'restart' }] });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.doesNotMatch(s.feature('a').lastFeedback!, /Diagnosis/);
});

test('recheck2: two failures with empty identities are not the same failure; no environment note is attached', (t) => {
  const gate = 'if [ ! -f ../g1-$FACTOS_FEATURE ]; then touch ../g1-$FACTOS_FEATURE; echo "FAIL src/x.test.ts > relay"; echo "receipt timed out"; else echo "FAIL src/x.test.ts > tenant"; echo "tenant isolation violated"; fi; exit 1';
  const s = setup(t, { features: [F('a')], config: { test: gate, maxAttempts: 1, diagnoser: DIAG } });
  scriptDiagnoses(s, { a: [{ fault: 'environment', evidence: 'ECONNREFUSED on the relay', fix: 'restart' }] });
  assert.equal(s.cli('run').status, 2);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['stuck', 1]);
  assert.doesNotMatch(s.feature('a').lastFeedback!, /Diagnosis/);
});
