import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { withLock, withCheckoutLock, mutate, writeJsonAtomic, paths, DEFAULT_CONFIG, envVar } from '../lib/state.ts';
import type { HumanTask } from '../lib/types.ts';

const STATE = new URL('../lib/state.ts', import.meta.url).href;
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fact-os-state-')); mkdirSync(join(d, '.fact-os')); return d; };
const exited = (cp: ChildProcess) => new Promise<number | null>((r) => cp.on('exit', (code) => r(code)));
const seedOwner = (lock: string, pid: number) => {
  mkdirSync(lock);
  const token = `owner-${pid}-${randomUUID()}`;
  writeFileSync(join(lock, token), '');
  return token;
};
const assertNoStaging = (root: string) => assert.deepEqual(readdirSync(paths(root).dir).filter((f) => f.startsWith('.lock.')), []);

test('checkout ownership excludes other checkout writers while allowing state mutations', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  await withCheckoutLock(root, async () => {
    await mutate(root, 'human', (d) => { d.tasks.push({ id: 'h', title: 'x', steps: [], unblocks: [], mockable: false, status: 'open' }); });
    await assert.rejects(withCheckoutLock(root, () => assert.fail('overlapping checkout callback'), { timeoutMs: 10 }), /timed out/);
  });
  await withCheckoutLock(root, () => {});
  assert.equal(existsSync(join(paths(root).dir, '.checkout-lock')), false);
  assert.deepEqual(readdirSync(paths(root).dir).filter((f) => f.startsWith('.checkout-lock.')), []);
});

test('three participants cannot enter while the live successor holds the stale lock', (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = new URL('./fixtures/state-lock-race.ts', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [fixture, root], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.deepEqual(JSON.parse(result.stdout), { injected: true, parentEntered: false, thirdEntered: false });
});

test('successor publication between stale token unlink and rmdir preserves exclusion', (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = new URL('./fixtures/state-lock-race.ts', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [fixture, root, 'after-unlink'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.deepEqual(JSON.parse(result.stdout), { injected: true, parentEntered: false, thirdEntered: false });
});

test('two concurrent writer processes lose no update (bug: read-modify-write without lock)', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJsonAtomic(paths(root).features, { features: [], n: 0 });
  const script = `import { mutate } from ${JSON.stringify(STATE)};
    for (let i = 0; i < 60; i++) await mutate(${JSON.stringify(root)}, 'features', (d) => { d.n++; });`;
  const kids = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' }));
  assert.deepEqual(await Promise.all(kids.map(exited)), [0, 0]);
  assert.equal(JSON.parse(readFileSync(paths(root).features, 'utf8')).n, 120);
  assert.ok(!existsSync(paths(root).lock), 'lock released');
});

test('readers never observe a partially written file (bug: writeFileSync in place)', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = paths(root).features;
  writeJsonAtomic(file, { features: [] });
  const script = `import { writeJsonAtomic } from ${JSON.stringify(STATE)};
    const big = { features: Array.from({ length: 3000 }, (_, i) => ({ id: 'f' + i, title: 'x'.repeat(40) })) };
    for (let i = 0; i < 150; i++) writeJsonAtomic(${JSON.stringify(file)}, big);`;
  const cp = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  let done = false, reads = 0; cp.on('exit', () => { done = true; });
  while (!done) { JSON.parse(readFileSync(file, 'utf8')); reads++; await new Promise(setImmediate); }
  assert.ok(reads > 10);
  assert.deepEqual(readdirSync(join(root, '.fact-os')).filter((f) => f.includes('.tmp')), [], 'no temp files left');
});

test('a lock held by a live pid blocks; a lock left by a dead pid is taken over', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
  t.after(() => holder.kill());
  seedOwner(paths(root).lock, holder.pid!);
  await assert.rejects(withLock(root, () => 1, { timeoutMs: 300 }), /lock/i);
  holder.kill(); await exited(holder);
  assert.equal(await withLock(root, () => 42, { timeoutMs: 2000 }), 42);
  assert.ok(!existsSync(paths(root).lock));
  assertNoStaging(root);
});

test('mutate returns fn result and releases lock when fn throws', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(mutate(root, 'human', () => { throw new Error('boom'); }), /boom/);
  assert.ok(!existsSync(paths(root).lock));
  assert.equal(await mutate(root, 'human', (d) => { d.tasks.push({ id: 'h' } as HumanTask); return d.tasks.length; }), 1);
});

test('stale-lock takeover does not delete a lock another process took in the meantime (bug: unlink after read)', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = paths(root).lock;
  const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
  t.after(() => live.kill());
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
  seedOwner(lock, dead);
  // Right after we read the dead pid, another process removes the stale lock and takes it.
  let raced = false, successor = '';
  const beforeTakeover = () => { if (!raced) { raced = true; rmSync(lock, { recursive: true }); successor = seedOwner(lock, live.pid!); } };
  await assert.rejects(withLock(root, () => 1, { timeoutMs: 300, beforeTakeover }), /lock/i);
  assert.ok(raced, 'the race was injected');
  assert.deepEqual(readdirSync(lock), [successor], 'the live holder keeps its lock');
  assertNoStaging(root);
});

test('same-process asynchronous callbacks remain exclusive and yield to the holder', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 12 }, () => withLock(root, async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
  }, { timeoutMs: 2000 })));
  assert.equal(peak, 1);
  assertNoStaging(root);
});

test('an empty directory left during release is recoverable', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(paths(root).lock);
  assert.equal(await withLock(root, () => 42), 42);
  assert.ok(!existsSync(paths(root).lock));
  assertNoStaging(root);
});

test('malformed lock contents are preserved and time out without entering', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = paths(root).lock;
  mkdirSync(lock); writeFileSync(join(lock, 'unknown'), 'keep');
  await assert.rejects(withLock(root, () => assert.fail('must not enter'), { timeoutMs: 50 }), /timed out.*unknown owner/);
  assert.equal(readFileSync(join(lock, 'unknown'), 'utf8'), 'keep');
  assertNoStaging(root);
});

test('legacy PID-file and empty-file locks fail closed with upgrade guidance', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const content of [String(process.pid), '99999999', '']) {
    writeFileSync(paths(root).lock, content);
    await assert.rejects(withLock(root, () => assert.fail('must not enter')), /legacy or invalid lock.*stop all old.*after they have stopped/);
    assert.equal(readFileSync(paths(root).lock, 'utf8'), content);
    assertNoStaging(root);
  }
});

test('late release does not remove a successor owner', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = paths(root).lock;
  let successor = '';
  await withLock(root, () => {
    // Simulate an external replacement to exercise ownership on release.
    rmSync(lock, { recursive: true }); successor = seedOwner(lock, process.pid);
  });
  assert.deepEqual(readdirSync(lock), [successor]);
  assertNoStaging(root);
});

test('builder and evaluator default to permissionMode "auto"', () => {
  assert.equal(DEFAULT_CONFIG.builder.permissionMode, 'auto');
  assert.equal(DEFAULT_CONFIG.evaluator.permissionMode, 'auto');
});

test('a project set up before the rename keeps using .shipyard/; .fact-os/ wins once it exists (bug: renamed state lost)', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'fact-os-legacy-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  assert.equal(paths(d).name, '.fact-os', 'new projects get .fact-os/');
  mkdirSync(join(d, '.shipyard'));
  assert.equal(paths(d).name, '.shipyard');
  assert.equal(paths(d).features, join(d, '.shipyard', 'features.json'));
  mkdirSync(join(d, '.fact-os'));
  assert.equal(paths(d).name, '.fact-os');
});

test('env reads FACTOS_* first and falls back to SHIPYARD_* (bug: old launch scripts silently ignored)', (t) => {
  t.after(() => { delete process.env.FACTOS_X; delete process.env.SHIPYARD_X; });
  process.env.SHIPYARD_X = 'old';
  assert.equal(envVar('X'), 'old');
  process.env.FACTOS_X = 'new';
  assert.equal(envVar('X'), 'new');
});
