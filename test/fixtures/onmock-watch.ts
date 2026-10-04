// I06 regression fixture: pause a watching foreman after scheduling, before it claims the launch under the state lock.
// Pause after scheduling, before publishing the launch's state lock. The parent
// completes a genuine locked edit before allowing the foreman to acquire it.
import * as realFs from 'node:fs';
import { mock } from 'bun:test';
import { join } from 'node:path';

const fs = { ...realFs }, root = process.argv[2]!, dir = join(root, '.fact-os');
let paused = false;
mock.module('node:fs', () => ({ ...fs, renameSync: (from: string, to: string) => {
  if (!paused && to === join(dir, '.lock') && fs.existsSync(join(dir, '.foreman'))) {
    paused = true;
    fs.writeFileSync(join(dir, 'launch-wait'), 'scheduled');
    const end = Date.now() + 5000;
    while (!fs.existsSync(join(dir, 'launch-release')) && Date.now() < end)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    if (!fs.existsSync(join(dir, 'launch-release'))) throw new Error('launch barrier timed out');
  }
  fs.renameSync(from, to);
} }));
const { run } = await import('../../lib/foreman.ts');
process.exitCode = await run(root, { out: console.log, watch: true });
