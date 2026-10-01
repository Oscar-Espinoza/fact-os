// Factory controls (control.json): pause new work and lanes, from the CLI, honoured by the foreman without interrupting
// anything in flight. The foreman scenarios use fixtures/fake-claude.ts like the other end-to-end tests.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readControlFile, writeControl, effectiveLimit, paths } from '../lib/state.ts';
import { stamp, waitForChange, procStart } from '../lib/foreman.ts';
import type { Feature, FeaturesFile, LogEvent, Verdict } from '../lib/types.ts';
import { reap } from './reap.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => unknown, ms = 15000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await sleep(25); return cond(); };
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id}.txt exists`],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });

function setup(t: TestContext, features: Feature[], { delayMs = 50, scenario = {}, verdicts = {} }:
  { delayMs?: number; scenario?: Record<string, string>; verdicts?: Record<string, Partial<Verdict>[]> } = {}) {
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
    FAKE_LOG: join(base, 'fake.jsonl'), FAKE_VERDICTS: join(base, 'verdicts.json'), FAKE_PIDS: join(base, 'pids'), FAKE_SCENARIO: JSON.stringify(scenario) };
  const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(cli('init', '--test', 'true').status, 0);
  writeFileSync(join(repo, '.fact-os/features.json'), JSON.stringify({ features }));
  writeFileSync(env.FAKE_VERDICTS, JSON.stringify(verdicts));
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const events = () => read(join(repo, '.fact-os/log.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEvent);
  return {
    repo, cli, events, git, control: join(repo, '.fact-os/control.json'),
    // index of the n-th (0-based) event `event` of feature `id` in the log, -1 if none
    at: (id: string | null, event: string, n = 0) => { let k = -1; return events().findIndex((e) => e.feature === id && e.event === event && ++k === n); },
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

test('readControlFile: missing means the defaults; unparseable or invalid fields are reported, never read as the defaults', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-ctl-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.fact-os'));
  const file = paths(root).control, set = (s: string) => writeFileSync(file, s);
  assert.deepEqual(readControlFile(root), { ok: true, missing: true, control: { paused: false, maxParallel: null } });
  set('{}'); assert.deepEqual(readControlFile(root), { ok: true, missing: false, control: { paused: false, maxParallel: null } });
  set('{"paused":true,"maxParallel":0,"by":"evil"}'); assert.deepEqual(readControlFile(root), { ok: true, missing: false, control: { paused: true, maxParallel: 0 } });
  for (const [text, why] of [['{not json', /not JSON/], ['[1]', /not a JSON object/], ['null', /not a JSON object/], ['{"paused":"true"}', /"paused" must be true or false/],
    ...[33, -1, 1.5, '"3"', true].map((v) => [`{"paused":true,"maxParallel":${v}}`, /"maxParallel" must be an integer from 0 to 32 or null/] as const)] as const) {
    set(text);
    const r = readControlFile(root);
    assert.equal(r.ok, false, text);
    if (!r.ok) { assert.match(r.error, why, text); assert.equal(r.text, text); }
  }
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
  assert.deepEqual(readControlFile(root), { ok: true, missing: false, control: c });
  await writeControl(root, { maxParallel: null }, 'cli');
  const r = readControlFile(root);
  assert.deepEqual(r.ok && [r.control.paused, r.control.maxParallel], [true, null]);
  writeFileSync(paths(root).control, '{"paused":"yes"');
  await writeControl(root, { maxParallel: 4 }, 'cli');
  const fixed = readControlFile(root);
  assert.deepEqual(fixed.ok && [fixed.control.paused, fixed.control.maxParallel], [false, 4], 'a write repairs an invalid file');
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
  assert.match(r.stdout, /^paused: no new features start; lanes 3 \(default\); 2 still running will finish \(no foreman running; applies when one starts\)$/m);
  assert.deepEqual([ctl().paused, ctl().maxParallel, ctl().by], [true, null, 'cli']);
  r = s.cli('lanes', '1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([ctl().paused, ctl().maxParallel], [true, 1], 'lanes keeps the pause');
  r = s.cli('resume-all');
  assert.match(r.stdout, /^up to 1 in flight; lanes 1 \(default 3\); 2 running will finish; no new ones start until fewer than 1 are running \(no foreman/m);
  assert.equal(ctl().paused, false);
  r = s.cli('lanes', '0');
  assert.match(r.stdout, /^lanes 0: no new features start/m);
  r = s.cli('lanes', 'default');
  assert.match(r.stdout, /^up to 3 in flight; lanes 3 \(default\); 2 running \(no foreman/m);
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
  // a running foreman: no "no foreman" note
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' }); t.after(() => sleeper.kill());
  writeFileSync(join(s.repo, '.fact-os/.foreman'), String(sleeper.pid));
  assert.doesNotMatch(s.cli('pause-all').stdout, /no foreman/);
  writeFileSync(join(s.repo, '.fact-os/.foreman'), '');
  // doctor reports an invalid control.json; any control command rewrites it and says so
  writeFileSync(file, '{"paused":"true"}');
  r = s.cli('doctor');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /control\.json: "paused" must be true or false/);
  r = s.cli('lanes', '2');
  assert.match(r.stdout, /^note: .*control\.json: "paused" must be true or false.*; rewritten/m);
  assert.deepEqual([ctl().paused, ctl().maxParallel], [false, 2]);
  assert.doesNotMatch(s.cli('doctor').stdout, /control\.json/);
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
  assert.deepEqual(ev.filter((e) => e.event === 'control').map((e) => e.detail), ['at start: running, lanes 1; launch limit 1'], 'the first read is logged as the start state');
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
  const s = setup(t, [F('a'), F('b', { priority: 2 })], { delayMs: 600 });
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
  const s = setup(t, [F('a'), F('b', { priority: 2 }), F('c', { priority: 3 })], { delayMs: 600 });
  assert.equal(s.cli('lanes', '1').status, 0);
  const run = s.start('--watch');
  assert.ok(await until(() => s.status().a === 'building'), run.out());
  assert.equal(s.cli('lanes', '3').status, 0);
  assert.equal(await run.exit, 0, run.out());
  // b and c launched while a was still in flight (a control.json change wakes the loop with every lane busy)
  assert.ok(s.at('b', 'launch') >= 0 && s.at('c', 'launch') >= 0);
  assert.ok(s.at('b', 'launch') < s.at('a', 'merged') && s.at('c', 'launch') < s.at('a', 'merged'), JSON.stringify(s.events()));
  assert.deepEqual(s.status(), { a: 'merged', b: 'merged', c: 'merged' });
  assert.equal(peak(s.events()), 3);
  assert.ok(!s.events().some((e) => e.event === 'alert'));
});

test('a feature that falls back to todo mid-pipeline is not relaunched over a lowered limit', async (t) => {
  const fail = { pass: false, findings: [{ check: 'a.txt exists', ok: false, evidence: 'no' }], cheating: [], lesson: null };
  const s = setup(t, [F('a'), F('b')], { delayMs: 300, scenario: { b: 'slow' }, verdicts: { a: [fail] } });
  const run = s.start();
  assert.ok(await until(() => s.status().a === 'building' && s.status().b === 'building'), run.out());
  await writeControl(s.repo, { maxParallel: 1 }, 'cli');
  assert.equal(await run.exit, 0, run.out());
  assert.deepEqual(s.status(), { a: 'merged', b: 'merged' });
  assert.ok(s.at('a', 'failed') >= 0 && s.at('a', 'failed') < s.at('b', 'merged'), 'a went back to todo while b was still in flight');
  assert.ok(s.at('a', 'launch', 1) > s.at('b', 'merged'), 'a relaunched only once b finished: ' + JSON.stringify(s.events().map((e) => `${e.feature}:${e.event}`)));
});

test('lowering lanes from 3 to 1 with 3 in flight interrupts nothing; d launches only once none is running', async (t) => {
  const s = setup(t, [F('a'), F('b'), F('c'), F('d', { priority: 2 })], { delayMs: 300 });
  const run = s.start();
  assert.ok(await until(() => ['a', 'b', 'c'].every((id) => s.status()[id] === 'building')), run.out());
  await writeControl(s.repo, { maxParallel: 1 }, 'cli');
  assert.equal(await run.exit, 0, run.out());
  assert.deepEqual(s.status(), { a: 'merged', b: 'merged', c: 'merged', d: 'merged' });
  const ev = s.events();
  assert.ok(!ev.some((e) => ['interrupted', 'failed', 'error'].includes(e.event)), 'nothing in flight was stopped');
  for (const id of ['a', 'b', 'c']) assert.equal(s.at(id, 'launch', 1), -1, `${id} launched once`);
  assert.ok(['a', 'b', 'c'].every((id) => s.at(id, 'merged') < s.at('d', 'launch')), 'd waited for the count to drop below 1');
  assert.ok(ev.some((e) => e.event === 'paused-launch' && /^lanes 1; [1-3] running; waiting: d$/.test(e.detail)));
});

test('a corrupt control.json during a run keeps the last good control (the pause holds), logged once per content; no crash, no alert', async (t) => {
  const s = setup(t, [F('a'), F('b', { priority: 2 })]);
  await writeControl(s.repo, { paused: true }, 'cli');
  const run = s.start('--watch');
  assert.ok(await until(() => s.events().some((e) => e.event === 'paused-launch')), run.out());
  const invalid = () => s.events().filter((e) => e.event === 'control-invalid');
  writeFileSync(s.control, '{"paused":"true"');
  assert.ok(await until(() => invalid().length === 1), run.out());
  await sleep(400);
  assert.equal(invalid().length, 1, 'once per bad content, not every tick');
  assert.match(invalid()[0]!.detail, /not JSON.*keeping the last good control \(paused, lanes default\)/);
  writeFileSync(s.control, '{"paused":false,"maxParallel":40}');
  assert.ok(await until(() => invalid().length === 2), run.out());
  assert.match(invalid()[1]!.detail, /"maxParallel" must be an integer/);
  await sleep(300);
  assert.equal(s.builds('a') + s.builds('b'), 0, 'still paused');
  assert.equal(run.cp.exitCode, null);
  await writeControl(s.repo, { paused: false }, 'cli');
  assert.equal(await run.exit, 0, run.out());
  assert.deepEqual(s.status(), { a: 'merged', b: 'merged' });
  assert.ok(!s.events().some((e) => e.event === 'alert'));
});

test('an invalid control.json at startup holds all new work (treated as paused)', (t) => {
  const s = setup(t, [F('a')]);
  writeFileSync(s.control, '{"maxParallel":"lots"}');
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(s.builds('a'), 0);
  assert.match(r.stdout, /warning: .*no good control read yet: treated as paused/);
  const ev = s.events();
  assert.ok(ev.some((e) => e.event === 'control-invalid' && /treated as paused/.test(e.detail)));
  assert.ok(ev.some((e) => e.event === 'control' && e.detail === 'at start: paused, lanes default; launch limit 0'));
});

test('parked merges still merge while paused; the dependent they unblock waits for resume', async (t) => {
  const s = setup(t, [F('a'), F('b', { deps: ['a'] })]);
  writeFileSync(join(s.repo, 'README.md'), 'local edit\n'); // a is evaluated, then parked: the checkout is dirty
  const run = s.start('--watch');
  assert.ok(await until(() => s.status().a === 'ready' && s.events().some((e) => e.event === 'merge-skipped')), run.out());
  await writeControl(s.repo, { paused: true }, 'cli');
  assert.ok(await until(() => s.events().some((e) => e.event === 'control')), run.out());
  s.git('checkout', '-q', 'README.md');
  assert.ok(await until(() => s.status().a === 'merged'), run.out());
  assert.ok(await until(() => s.events().some((e) => e.event === 'paused-launch' && /waiting: b$/.test(e.detail))), run.out());
  assert.equal(s.builds('b'), 0);
  await writeControl(s.repo, { paused: false }, 'cli');
  assert.equal(await run.exit, 0, run.out());
  assert.deepEqual(s.status(), { a: 'merged', b: 'merged' });
});

test('a live child of a previous foreman counts toward the lanes: nothing new launches until it is gone', async (t) => {
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => sleeper.kill());
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout);
  const s = setup(t, [F('l', { status: 'testing', pid: sleeper.pid, pidStart: procStart(sleeper.pid!)!, foremanPid: dead }), F('a', { priority: 2 })]);
  await writeControl(s.repo, { maxParallel: 1 }, 'cli');
  const run = s.start();
  assert.ok(await until(() => s.events().some((e) => e.event === 'paused-launch')), run.out());
  assert.match(s.events().find((e) => e.event === 'paused-launch')!.detail, /^lanes 1; 1 running; waiting: a$/);
  await sleep(300);
  assert.equal(s.builds('a'), 0, 'the orphan holds the only lane');
  sleeper.kill();
  assert.equal(await run.exit, 0, run.out());
  assert.deepEqual(s.status(), { l: 'merged', a: 'merged' });
  assert.equal(peak(s.events()), 1);
});
