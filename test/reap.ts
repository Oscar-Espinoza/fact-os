// Test cleanup: SIGKILL any foreman a test started in `repo` and any fake agents it spawned, so a run that hangs or
// ignores SIGTERM cannot outlive the test (two such runs once spun for a day in /tmp/fact-os-guard-*).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

export function reap(repo: string, pidsFile?: string): void {
  const pids = [read(join(repo, '.fact-os', '.foreman')), ...(pidsFile ? read(pidsFile).split('\n') : [])]
    .map((s) => parseInt(s, 10)).filter((p) => p > 0 && p !== process.pid);
  // A recorded pid may have exited and been reused: only kill it if it still runs fact-os or the fake agent.
  const ours = (p: number) => /fact-os|fake-claude/.test(read(`/proc/${p}/cmdline`));
  for (const p of pids) if (ours(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
}
