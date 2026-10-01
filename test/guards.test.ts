// End-to-end scenarios where the builder, the evaluator or the checkout misbehave. Uses fixtures/fake-claude.ts.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { procStart } from '../lib/foreman.ts';
import type { Config, Feature, FeaturesFile, Verdict } from '../lib/types.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id}.txt exists`],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });

interface FakeCall { mode: string; id: string; t0: number; t1: number; prompt: string; args: string[] }
function setup(t: TestContext, { features, config = {}, scenario = {}, verdicts = {} }:
  { features: Feature[]; config?: Partial<Config>; scenario?: Record<string, string>; verdicts?: Record<string, Partial<Verdict>[]> }) {
  const base = mkdtempSync(join(tmpdir(), 'fact-os-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'app');
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
  const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
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

test('acceptance checks are the ones from launch, even if features.json is edited mid-run', (t) => {
  const fail1 = { pass: false, findings: [{ check: 'a.txt exists', ok: false, evidence: 'no' }], cheating: [], lesson: null };
  const s = setup(t, { features: [F('a')], scenario: { a: 'acceptance' }, verdicts: { a: [fail1] } });
  s.cli('run');
  const prompts = [...s.calls('build', 'a'), ...s.calls('eval', 'a')].map((c) => c.prompt);
  assert.equal(prompts.length, 4);
  for (const p of prompts) { assert.match(p, /- a\.txt exists/); assert.doesNotMatch(p, /nothing to check/); }
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

test('a failing prepare fails the attempt before the builder runs', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 } });
  const cfg = JSON.parse(readFileSync(join(s.repo, '.fact-os/config.json'), 'utf8'));
  cfg.prepare = 'echo no database; exit 3';
  writeFileSync(join(s.repo, '.fact-os/config.json'), JSON.stringify(cfg));
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.feature('a').status, 'stuck');
  assert.match(s.feature('a').lastFeedback!, /prepare .* exited 3[\s\S]*no database/);
  assert.equal(s.calls('build', 'a').length, 0);
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
