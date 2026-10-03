import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { withSupervisor } from '../lib/state.ts';
import { run } from '../lib/foreman.ts';
import { observe } from '../lib/observe.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await sleep(5);
  return fn();
};
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-supervisor-'));
  mkdirSync(join(root, '.fact-os'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify({ base: 'main', observer: {
    pollSec: 1, retry: false, improve: false, promptReview: { enabled: false } } }));
  writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [{
    id: 'waiting', title: 'Waiting', description: '', acceptance: [], surface: 'any',
    deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '' }] }));
  writeFileSync(join(root, '.fact-os/human.json'), JSON.stringify({ tasks: [{
    id: 'human', title: 'Wait', steps: [], unblocks: ['waiting'], mockable: false, status: 'open' }] }));
  return root;
};

for (const role of ['foreman', 'observer'] as const) test(`${role}: simultaneous starts allow only one owner`, async (t) => {
  const root = repo();
  const fixture = new URL('./fixtures/supervisor-race.ts', import.meta.url).pathname;
  const kids = ['a', 'b'].map((id) => {
    const child = spawn(process.execPath, [fixture, root, role, id], {
      env: { ...process.env, FACTOS_CLAUDE: '/bin/false', SHIPYARD_CLAUDE: '/bin/false', FACTOS_POLL_MS: '10' },
      stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (d) => { error += d; });
    const done = new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { id, child, done, error: () => error };
  });
  t.after(async () => {
    for (const { child } of kids) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(kids.map((k) => k.done));
    rmSync(root, { recursive: true, force: true });
  });
  assert.ok(await until(() => kids.some((k) => existsSync(join(root, `read-${k.id}`)))));
  // With the new lock, the second reader waits outside ownership acquisition.
  // With the old code both reach this barrier before either publishes its PID.
  await until(() => kids.every((k) => existsSync(join(root, `read-${k.id}`))), 300);
  writeFileSync(join(root, 'release'), 'go');
  assert.ok(await until(() => kids.some((k) => k.child.exitCode !== null) ||
    kids.every((k) => existsSync(join(root, `entered-${k.id}`)))));
  const entered = kids.filter((k) => existsSync(join(root, `entered-${k.id}`)));
  assert.equal(entered.length, 1, kids.map((k) => k.error()).join('\n'));
  const owner = entered[0]!, loser = kids.find((k) => k !== owner)!;
  assert.equal(await loser.done, 1);
  assert.match(loser.error(), new RegExp(`another ${role} is running`));
  const marker = join(root, '.fact-os', `.${role}`);
  assert.equal(parseInt(readFileSync(marker, 'utf8'), 10), owner.child.pid, 'loser leaves the owner marker intact');
  owner.child.kill('SIGTERM'); await owner.done;
  assert.equal(existsSync(marker), false, 'normal shutdown releases ownership');
});

for (const role of ['foreman', 'observer'] as const) {
  test(`${role}: same-process duplicate is rejected without removing the owner`, async (t) => {
    const root = repo(); t.after(() => rmSync(root, { recursive: true, force: true }));
    const marker = join(root, '.fact-os', `.${role}`);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { entered = r; });
    const first = withSupervisor(root, role, async () => { entered(); await gate; return 42; });
    try {
      await started;
      const owner = readFileSync(marker, 'utf8');
      await assert.rejects(withSupervisor(root, role, () => assert.fail('duplicate must not enter')), /another .* is running/);
      assert.equal(readFileSync(marker, 'utf8'), owner);
    } finally { release(); await first; }
    assert.equal(existsSync(marker), false);
    assert.equal(await withSupervisor(root, role, () => 42), 42, 'can start again after release');
  });

  test(`${role}: legacy live PID blocks and dead PID recovers`, async (t) => {
    const root = repo(); t.after(() => rmSync(root, { recursive: true, force: true }));
    const marker = join(root, '.fact-os', `.${role}`);
    writeFileSync(marker, String(process.pid));
    await assert.rejects(withSupervisor(root, role, () => assert.fail('must not enter')), /another .* is running/);
    assert.equal(readFileSync(marker, 'utf8'), String(process.pid));
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
    for (const previous of [dead, '']) {
      writeFileSync(marker, previous);
      assert.equal(await withSupervisor(root, role, () => 42), 42);
      assert.equal(existsSync(marker), false);
    }
  });

  test(`${role}: cleanup preserves a replacement marker with the same PID`, async (t) => {
    const root = repo(); t.after(() => rmSync(root, { recursive: true, force: true }));
    const marker = join(root, '.fact-os', `.${role}`), replacement = `${process.pid}\nreplacement\n`;
    await assert.rejects(withSupervisor(root, role, () => {
      writeFileSync(marker, replacement); throw new Error('callback failed');
    }), /callback failed/);
    assert.equal(readFileSync(marker, 'utf8'), replacement);
  });

  test(`${role}: invalid ownership markers are preserved`, async (t) => {
    const root = repo(); t.after(() => rmSync(root, { recursive: true, force: true }));
    const marker = join(root, '.fact-os', `.${role}`);
    for (const invalid of ['unknown', '123bad', '-1', '9007199254740993']) {
      writeFileSync(marker, invalid);
      await assert.rejects(withSupervisor(root, role, () => assert.fail('must not enter')), /invalid .* ownership marker/);
      assert.equal(readFileSync(marker, 'utf8'), invalid);
    }
  });

  test(`${role}: failed startup releases ownership and signal listeners`, async (t) => {
    const root = repo(); t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, '.fact-os/config.json'), config = readFileSync(file, 'utf8');
    const listeners = ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
    writeFileSync(file, '{broken');
    const start = role === 'foreman' ? run : observe;
    await assert.rejects(start(root, { out: () => {} }), /config.json/);
    assert.equal(existsSync(join(root, '.fact-os', `.${role}`)), false);
    assert.deepEqual(['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s)), listeners);
    writeFileSync(file, config);
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [] }));
    assert.equal(await start(root, { out: () => {} }), 0, 'corrected startup succeeds');
  });
}

test('foreman and observer can own independent markers at the same time', async (t) => {
  const root = repo(); t.after(() => rmSync(root, { recursive: true, force: true }));
  await withSupervisor(root, 'foreman', async () => {
    await withSupervisor(root, 'observer', () => {
      assert.equal(parseInt(readFileSync(join(root, '.fact-os/.foreman'), 'utf8'), 10), process.pid);
      assert.equal(parseInt(readFileSync(join(root, '.fact-os/.observer'), 'utf8'), 10), process.pid);
    });
    assert.equal(existsSync(join(root, '.fact-os/.observer')), false);
    assert.equal(existsSync(join(root, '.fact-os/.foreman')), true);
  });
  assert.equal(existsSync(join(root, '.fact-os/.foreman')), false);
});
