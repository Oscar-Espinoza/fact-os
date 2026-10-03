// Pause each first ownership read, including ENOENT, so old check-then-write
// starters both observe the same absent marker. Isolate the fs mock in this process.
import * as realFs from 'node:fs';
import { mock } from 'bun:test';
import { join } from 'node:path';

const fs = { ...realFs }, [root, role, id] = process.argv.slice(2) as [string, 'foreman' | 'observer', string];
const marker = join(root, '.fact-os', `.${role}`), gate = join(root, 'release');
let paused = false;
mock.module('node:fs', () => ({ ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
  let result: ReturnType<typeof fs.readFileSync> | undefined, failure: unknown;
  try { result = fs.readFileSync(...args); } catch (e) { failure = e; }
  if (String(args[0]) === marker && !paused) {
    paused = true;
    fs.writeFileSync(join(root, `read-${id}`), 'ready');
    const end = Date.now() + 5000;
    while (!fs.existsSync(gate) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    if (!fs.existsSync(gate)) throw new Error('ownership read gate timed out');
  }
  if (failure) throw failure;
  return result;
} }));
const out = () => fs.writeFileSync(join(root, `entered-${id}`), 'entered');
try {
  if (role === 'foreman') {
    const { run } = await import('../../lib/foreman.ts');
    await run(root, { watch: true, out });
  } else {
    const { observe } = await import('../../lib/observe.ts');
    await observe(root, { watch: true, out });
  }
} catch (e) { console.error(String(e)); process.exitCode = 1; }
