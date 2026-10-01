// Factory controls (control.json): pause new work and lanes, from the CLI, honoured by the foreman without interrupting
// anything in flight. The foreman scenarios use fixtures/fake-claude.ts like the other end-to-end tests.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readControl, writeControl, effectiveLimit, paths } from '../lib/state.ts';
import { stamp, waitForChange } from '../lib/foreman.ts';
import type { Feature, FeaturesFile, LogEvent } from '../lib/types.ts';
import { reap } from './reap.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => unknown, ms = 15000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await sleep(25); return cond(); };
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id}.txt exists`],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });

function setup(t: TestContext, features: Feature[], delayMs = 50) {
  const base = mkdtempSync(join(tmpdir(), 'fact-os-control-'));
  const repo = join(base, 'app');
  t.after(() => { reap(repo, join(base, 'pids')); rmSync(base, { recursive: true, force: true }); });
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.'); git('commit', '-qm', 'init');
  chmodSync(FAKE, 0o755);
  const env = { ...process.env, FACTOS_CLAUDE: FAKE, FACTOS_POLL_MS: '50', FAKE_DELAY_MS: String(delayMs),
    FAKE_LOG: join(base, 'fake.jsonl'), FAKE_VERDICTS: join(base, 'verdicts.json'), FAKE_PIDS: join(base, 'pids') };
  const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(cli('init', '--test', 'true').status, 0);
  writeFileSync(join(repo, '.fact-os/features.json'), JSON.stringify({ features }));
  writeFileSync(env.FAKE_VERDICTS, '{}');
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const events = () => read(join(repo, '.fact-os/log.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEvent);
  return {
    repo, cli, events,
    status: () => Object.fromEntries((JSON.parse(read(join(repo, '.fact-os/features.json'))) as FeaturesFile).features.map((f) => [f.id, f.status])),
    builds: (id: string) => read(env.FAKE_LOG).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { mode: string; id: string }).filter((c) => c.mode === 'build' && c.id === id).length,
    start: (...a: string[]) => {
      const cp = spawn(process.execPath, [BIN, 'run', ...a], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; cp.stdout.on('data', (d) => { out += d; }); cp.stderr.on('data', (d) => { out += d; });
      t.after(() => cp.exitCode === null && cp.kill('SIGKILL'));
      return { cp, exit: new Promise<number | null>((r) => cp.on('exit', (code) => r(code))), out: () => out };
    },
  };
}
// Most features in flight at once, from the log's launch → merged/failed/stuck/todo pairs.
function peak(events: LogEvent[]): number {
  const live = new Set<string>(); let max = 0;
  for (const e of events) {
    if (e.event === 'launch') { live.add(e.feature!); max = Math.max(max, live.size); }
    else if (['merged', 'failed', 'stuck', 'interrupted', 'error', 'ready'].includes(e.event)) live.delete(e.feature!);
  }
  return max;
}

// ---- state helpers ----

test('readControl: a missing, corrupt or invalid control.json means "not paused, config lanes"', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-ctl-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os'));
  const file = paths(root).control, set = (s: string) => writeFileSync(file, s);
  assert.deepEqual(readControl(root), { paused: false, maxParallel: null });
  set('{not json'); assert.deepEqual(readControl(root), { paused: false, maxParallel: null });
  set('[1]'); assert.deepEqual(readControl(root), { paused: false, maxParallel: null });
  for (const bad of [33, -1, 1.5, '3', true]) { set(JSON.stringify({ paused: true, maxParallel: bad })); assert.deepEqual(readControl(root), { paused: true, maxParallel: null }, String(bad)); }
  set(JSON.stringify({ paused: 'yes', maxParallel: 0, by: 'evil' })); assert.deepEqual(readControl(root), { paused: false, maxParallel: 0 });
});

test('writeControl validates lanes, keeps the other field, records who and when', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-ctl-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os'));
  for (const bad of [33, -1, 1.5, '3', undefined, NaN]) await assert.rejects(writeControl(root, { maxParallel: bad as number }, 'cli'), /lanes must be an integer from 0 to 32/, String(bad));
  assert.equal(existsSync(paths(root).control), false, 'nothing written on invalid input');
  await writeControl(root, { maxParallel: 2 }, 'cli');
  const c = await writeControl(root, { paused: true }, 'dashboard');
  assert.deepEqual([c.paused, c.maxParallel, c.by], [true, 2, 'dashboard']);
  assert.ok(Date.parse(c.updatedAt!) > 0);
  assert.deepEqual(readControl(root), c);
  await writeControl(root, { maxParallel: null }, 'cli');
  assert.deepEqual([readControl(root).paused, readControl(root).maxParallel], [true, null]);
  assert.equal(existsSync(paths(root).lock), false, 'lock released');
});

test('effectiveLimit: paused is 0, lanes 0 stays 0, otherwise lanes or config (config at least 1, as before)', () => {
  assert.equal(effectiveLimit({ paused: true, maxParallel: 5 }, { maxParallel: 3 }), 0);
  assert.equal(effectiveLimit({ paused: false, maxParallel: 0 }, { maxParallel: 3 }), 0);
  assert.equal(effectiveLimit({ paused: false, maxParallel: 5 }, { maxParallel: 3 }), 5);
  assert.equal(effectiveLimit({ paused: false, maxParallel: null }, { maxParallel: 3 }), 3);
  assert.equal(effectiveLimit({ paused: false, maxParallel: null }, { maxParallel: 0 }), 1);
});

test('waitForChange wakes on a control.json change (raising lanes must not wait for a feature to finish)', async (t) => {
  const d = mkdtempSync(join(tmpdir(), 'fact-os-wait-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const P = { control: join(d, 'control.json') };
  const before = stamp(P);
  writeFileSync(P.control, '{"maxParallel":3}');
  const r = await Promise.race([waitForChange(P, before, () => false).then(() => 'woke'), sleep(1000).then(() => 'slept')]);
  assert.equal(r, 'woke');
});

// ---- CLI ----

test('CLI: pause-all, resume-all and lanes write control.json and print the effective state; bad input exits 1', (t) => {
  const s = setup(t, [F('a', { status: 'building' }), F('b', { status: 'testing' }), F('c')]);
  const file = join(s.repo, '.fact-os/control.json'), ctl = () => JSON.parse(readFileSync(file, 'utf8'));
  let r = s.cli('pause-all');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^paused: no new features start; lanes 3 \(default\); 2 still running will finish$/m);
  assert.deepEqual([ctl().paused, ctl().maxParallel, ctl().by], [true, null, 'cli']);
  r = s.cli('lanes', '1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([ctl().paused, ctl().maxParallel], [true, 1], 'lanes keeps the pause');
  r = s.cli('resume-all');
  assert.match(r.stdout, /^up to 1 in flight; lanes 1 \(default 3\); 2 running will finish; no new ones start until fewer than 1 are running$/m);
  assert.equal(ctl().paused, false);
  r = s.cli('lanes', '0');
  assert.match(r.stdout, /^lanes 0: no new features start/m);
  r = s.cli('lanes', 'default');
  assert.match(r.stdout, /^up to 3 in flight; lanes 3 \(default\); 2 running$/m);
  assert.equal(ctl().maxParallel, null);
  const before = readFileSync(file, 'utf8');
  for (const args of [['lanes'], ['lanes', '33'], ['lanes', '-1'], ['lanes', 'abc'], ['lanes', '1.5'], ['lanes', '1', '2'], ['pause-all', 'x']]) {
    r = s.cli(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /fact-os: (usage|lanes)/, args.join(' '));
  }
  assert.equal(readFileSync(file, 'utf8'), before, 'refused input changes nothing');
  assert.match(s.cli('help').stdout, /pause-all \| resume-all[\s\S]*lanes <n\|default>/);
  assert.match(readFileSync(join(s.repo, '.git/info/exclude'), 'utf8'), /\.fact-os\/control\.json/);
});

// ---- foreman ----

test('lanes 1 with 3 ready features: one in flight at a time, held work logged as paused-launch', (t) => {
  const s = setup(t, [F('a'), F('b'), F('c')]);
  assert.equal(s.cli('lanes', '1').status, 0);
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(s.status(), { a: 'merged', b: 'merged', c: 'merged' });
  const ev = s.events();
  assert.equal(peak(ev), 1, 'config allows 3, control.json allows 1');
  assert.match(JSON.stringify(ev.find((e) => e.event === 'control')), /running, lanes default → running, lanes 1; launch limit 3 → 1 \(by cli\)/);
  assert.ok(ev.some((e) => e.event === 'paused-launch' && /^lanes 1; 1 running; waiting: b, c$/.test(e.detail)), JSON.stringify(ev));
  assert.ok(!ev.some((e) => e.event === 'alert'), 'writing control.json never trips the tamper check');
});

test('paused before the run: nothing launches; without --watch it exits 2, with --watch it waits and resume launches', async (t) => {
  const s = setup(t, [F('a'), F('b')]);
  assert.equal(s.cli('pause-all').status, 0);
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(s.builds('a') + s.builds('b'), 0);
  const run = s.start('--watch');
  assert.ok(await until(() => s.events().filter((e) => e.event === 'paused-launch').length >= 2), run.out());
  await sleep(400);
  assert.equal(run.cp.exitCode, null, 'run --watch keeps waiting while paused');
  assert.equal(s.builds('a') + s.builds('b'), 0);
  assert.equal(s.events().filter((e) => e.event === 'paused-launch').length, 2, 'logged once per run, not every tick');
  assert.equal(s.cli('resume-all').status, 0);
  assert.equal(await run.exit, 0, run.out());
  assert.deepEqual(s.status(), { a: 'merged', b: 'merged' });
  assert.ok(!s.events().some((e) => e.event === 'alert'));
});

test('pausing while one is in flight lets it finish and launches nothing more; resuming launches the rest', async (t) => {
  const s = setup(t, [F('a'), F('b', { priority: 2 })], 600);
  assert.equal(s.cli('lanes', '1').status, 0);
  const run = s.start('--watch');
  assert.ok(await until(() => s.status().a === 'building'), run.out());
  assert.equal(s.cli('pause-all').status, 0);
  assert.ok(await until(() => s.status().a === 'merged'), run.out());
  await sleep(500);
  assert.equal(s.status().b, 'todo', run.out());
  assert.equal(s.builds('b'), 0);
  assert.equal(run.cp.exitCode, null, 'run --watch keeps waiting while paused');
  assert.ok(s.events().some((e) => e.event === 'paused-launch' && /^paused; /.test(e.detail)));
  assert.equal(s.cli('resume-all').status, 0);
  assert.equal(await run.exit, 0, run.out());
  assert.deepEqual(s.status(), { a: 'merged', b: 'merged' });
  assert.ok(!s.events().some((e) => e.event === 'alert'), 'writing control.json never trips the tamper check');
});

test('raising lanes mid-run launches more at once, without waiting for the running feature or a restart', async (t) => {
  const s = setup(t, [F('a'), F('b', { priority: 2 }), F('c', { priority: 3 })], 600);
  assert.equal(s.cli('lanes', '1').status, 0);
  const run = s.start('--watch');
  assert.ok(await until(() => s.status().a === 'building'), run.out());
  assert.equal(s.cli('lanes', '3').status, 0);
  // a's build and evaluation take 600 ms each: b and c must start while a is still in flight
  assert.ok(await until(() => s.builds('b') && s.builds('c'), 5000), run.out());
  assert.notEqual(s.status().a, 'merged', 'launched while a was still running');
  assert.equal(await run.exit, 0, run.out());
  assert.deepEqual(s.status(), { a: 'merged', b: 'merged', c: 'merged' });
  assert.equal(peak(s.events()), 3);
  assert.ok(!s.events().some((e) => e.event === 'alert'));
});
