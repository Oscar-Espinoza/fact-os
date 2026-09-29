import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { withLock, mutate, writeJsonAtomic, paths, DEFAULT_CONFIG, envVar } from '../lib/state.js';

const STATE = new URL('../lib/state.js', import.meta.url).href;
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fact-os-state-')); mkdirSync(join(d, '.fact-os')); return d; };
const exited = (cp) => new Promise((r) => cp.on('exit', (code) => r(code)));

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
  writeFileSync(paths(root).lock, String(holder.pid));
  await assert.rejects(withLock(root, () => 1, { timeoutMs: 300 }), /lock/i);
  holder.kill(); await exited(holder);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  writeFileSync(paths(root).lock, dead);
  assert.equal(await withLock(root, () => 42, { timeoutMs: 2000 }), 42);
  assert.ok(!existsSync(paths(root).lock));
});

test('mutate returns fn result and releases lock when fn throws', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(mutate(root, 'human', () => { throw new Error('boom'); }), /boom/);
  assert.ok(!existsSync(paths(root).lock));
  assert.equal(await mutate(root, 'human', (d) => { d.tasks.push({ id: 'h' }); return d.tasks.length; }), 1);
});

test('stale-lock takeover does not delete a lock another process took in the meantime (bug: unlink after read)', async (t) => {
  const root = tmp(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = paths(root).lock;
  const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
  t.after(() => live.kill());
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  writeFileSync(lock, dead);
  // Right after we read the dead pid, another process removes the stale lock and takes it.
  const real = fs.readFileSync;
  let raced = false;
  fs.readFileSync = function (f, ...a) {
    const r = real.call(this, f, ...a);
    if (f === lock && !raced) { raced = true; fs.unlinkSync(lock); fs.writeFileSync(lock, String(live.pid)); }
    return r;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.readFileSync = real; syncBuiltinESMExports(); });
  await assert.rejects(withLock(root, () => 1, { timeoutMs: 300 }), /lock/i);
  assert.equal(readFileSync(lock, 'utf8'), String(live.pid), 'the live holder keeps its lock');
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
