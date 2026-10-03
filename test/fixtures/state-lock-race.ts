// Separate process: the fs mock must not affect other test files.
import * as realFs from 'node:fs';
import { mock } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const fs = { ...realFs }, root = process.argv[2]!, lock = join(root, '.fact-os/.lock');
const afterUnlink = process.argv[3] === 'after-unlink';
const state = new URL('../../lib/state.ts', import.meta.url).href;
const kids: { child: ChildProcess; done: Promise<void> }[] = [];
const waitFor = (file: string, ms = 3000) => {
  const until = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  return fs.existsSync(file);
};
const holder = (name: string, timeoutMs = 3000) => {
  const marker = join(root, name), release = join(root, `${name}-release`);
  const child = spawn(process.execPath, ['-e', `
    import { withLock, sleep } from ${JSON.stringify(state)};
    import { writeFileSync, existsSync } from 'node:fs';
    try { await withLock(${JSON.stringify(root)}, async () => {
      writeFileSync(${JSON.stringify(marker)}, 'entered');
      while (!existsSync(${JSON.stringify(release)})) await sleep(5);
    }, { timeoutMs: ${timeoutMs} }); } catch (e) { if (!String(e).includes('timed out')) throw e; }
  `], { stdio: ['ignore', 'ignore', 'inherit'] });
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  kids.push({ child, done });
  return { child, done, marker };
};

try {
  // Seed a genuine abandoned lock in whichever format the implementation uses.
  const dead = holder('dead');
  if (!waitFor(dead.marker)) throw new Error('dead holder did not acquire');
  dead.child.kill('SIGKILL'); await dead.done;
  const deadToken = fs.lstatSync(lock).isDirectory() ? fs.readdirSync(lock)[0]! : '';
  let injected = false;
  const installSuccessor = (removeStale: boolean) => {
    if (injected) return;
    injected = true;
    if (removeStale) fs.rmSync(lock, { recursive: true, force: true });
    const live = holder('live');
    if (!waitFor(live.marker)) throw new Error('live successor did not acquire');
    holder('third', 500);
  };
  mock.module('node:fs', () => ({ ...fs, renameSync: (from: string, to: string) => {
    fs.renameSync(from, to);
    // Old recovery moved the live successor away. Hold that exposed gap open
    // until the third participant enters; the safe protocol never does this.
    if (to.endsWith('.stale')) waitFor(join(root, 'third'), 1000);
  }, unlinkSync: (file: string) => {
    fs.unlinkSync(file);
    // A successor can atomically replace the now-empty directory before the
    // recovering process calls rmdir. That rmdir must preserve the successor.
    if (afterUnlink && file === join(lock, deadToken)) installSuccessor(false);
  } }));
  const { withLock } = await import(state);
  let parentEntered = false;
  try {
    await withLock(root, () => { parentEntered = true; }, { timeoutMs: 500,
      beforeTakeover: () => { if (!afterUnlink) installSuccessor(true); } });
  } catch (e) { if (!String(e).includes('timed out')) throw e; }
  // The live successor has never released. Neither contender may have entered.
  await new Promise((resolve) => setTimeout(resolve, 600));
  console.log(JSON.stringify({ injected, parentEntered, thirdEntered: fs.existsSync(join(root, 'third')) }));
} finally {
  for (const { child } of kids) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(kids.map(({ done }) => done));
}
