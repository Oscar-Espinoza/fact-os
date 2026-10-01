// State files: JSON, written atomically (temp + rename) under .fact-os/.lock (O_EXCL, stale when its PID is dead).
import { existsSync, readFileSync, writeFileSync, renameSync, linkSync, openSync, closeSync, writeSync, unlinkSync, appendFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Config, Feature, HumanTask, LogEvent, Paths, StateFiles, StateName } from './types.ts';

export const DEFAULT_CONFIG: Config = {
  base: 'main', worktreesDir: '../<repo>-worktrees', branchPrefix: 'ship/', maxParallel: 3, maxAttempts: 2,
  budgetUsdPerRun: null, budgetUsdTotal: null, timeoutMin: null,
  builder: { model: 'opus', effort: 'medium', permissionMode: 'auto' },
  evaluator: { model: 'opus', effort: 'high', permissionMode: 'auto' },
  test: 'pnpm test', merge: 'auto', briefFiles: [], lessonsFile: 'CLAUDE.md', postMerge: null, prepare: null, refreshBeforeTest: false,
  groupBy: null, maxRefreshes: 5, mergeHook: null, restoreFrom: null, evaluatorDiffExclude: [],
};

// The product name, used for the state dir, commit prefixes, headings and UI. Rename here only.
export const NAME = 'fact-os';
// Projects set up before the rename keep their .shipyard/ dir until migrated; new ones get .<NAME>/.
export const STATE_DIRS = [`.${NAME}`, '.shipyard'];
export const stateDirName = (root: string): string => STATE_DIRS.find((d) => existsSync(join(root, d))) ?? STATE_DIRS[0]!;

// FACTOS_<NAME>, falling back to the pre-rename SHIPYARD_<NAME>.
export const envVar = (name: string): string | undefined => process.env[`FACTOS_${name}`] ?? process.env[`SHIPYARD_${name}`];
// Child env for a feature: both spellings, so hooks and scripts written for either keep working.
export const featureEnv = (vars: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(vars).flatMap(([k, v]) => [[`FACTOS_${k}`, v], [`SHIPYARD_${k}`, v]]));

// catch (e) gives unknown; what reaches these is always an Error (node:fs errors carry .code).
export const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
export const errMsg = (e: unknown): string => (e as Error).message;

export function paths(root: string): Paths {
  const name = stateDirName(root), dir = join(root, name);
  return { name, dir, config: join(dir, 'config.json'), features: join(dir, 'features.json'), human: join(dir, 'human.json'),
    log: join(dir, 'log.jsonl'), activity: join(dir, 'activity.jsonl'), lock: join(dir, '.lock'),
    foreman: join(dir, '.foreman'), runs: join(dir, 'runs') };
}

// Untyped on purpose: callers cast (readState, loadConfig) or validate (doctor) what comes back.
export function readJson(file: string, fallback: unknown): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (errCode(e) === 'ENOENT') return fallback;
    throw new Error(`${file}: ${errMsg(e)}`);
  }
}

let seq = 0;
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return errCode(e) === 'EPERM'; }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface LockOptions {
  timeoutMs?: number;
  // Test hook: runs right after a stale lock's pid was read, before the takeover, so a test can race it.
  beforeTakeover?: () => void;
}

export async function withLock<R>(root: string, fn: () => R | Promise<R>, { timeoutMs = 30000, beforeTakeover }: LockOptions = {}): Promise<R> {
  const lock = paths(root).lock;
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
      let pid: number, age: number;
      try { pid = parseInt(readFileSync(lock, 'utf8'), 10); age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      // Stale: holder is dead, or the file stayed empty (writer died between open and write).
      const stale = (p: number, a: number) => (p ? !pidAlive(p) : a > 5000);
      if (stale(pid, age)) {
        beforeTakeover?.();
        // Move it aside under a unique name and re-check what we moved: another process may have
        // replaced the stale lock with its own since we read it. If so, put that one back.
        const aside = `${lock}.${process.pid}.${seq++}.stale`;
        try { renameSync(lock, aside); } catch { continue; }
        try {
          if (!stale(parseInt(readFileSync(aside, 'utf8'), 10), Date.now() - statSync(aside).mtimeMs)) linkSync(aside, lock);
        } catch {}
        try { unlinkSync(aside); } catch {}
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for lock ${lock} (held by pid ${pid})`);
      await sleep(5 + Math.random() * 15);
    }
  }
  try { return await fn(); } finally { try { unlinkSync(lock); } catch {} }
}

const EMPTY: { [N in StateName]: () => StateFiles[N] } = { features: () => ({ features: [] }), human: () => ({ tasks: [] }) };

// The one place state files become typed: shape is trusted here, validated by `fact-os doctor`.
const readState = <N extends StateName>(root: string, name: N): StateFiles[N] => readJson(paths(root)[name], EMPTY[name]()) as StateFiles[N];

// Read-modify-write one state file ('features' | 'human') under the lock; fn mutates the data in place.
export function mutate<N extends StateName, R>(root: string, name: N, fn: (data: StateFiles[N]) => R | Promise<R>): Promise<R> {
  const file = paths(root)[name];
  return withLock(root, async () => {
    const data = readState(root, name);
    const out = await fn(data);
    writeJsonAtomic(file, data);
    return out;
  });
}

export function loadConfig(root: string): Config {
  const c: Config = { ...DEFAULT_CONFIG, ...(readJson(paths(root).config, {}) as Partial<Config>) };
  c.worktreesDir = c.worktreesDir.replace('<repo>', basename(root));
  return c;
}

export function load(root: string): { config: Config; features: Feature[]; tasks: HumanTask[] } {
  return { config: loadConfig(root), features: readState(root, 'features').features, tasks: readState(root, 'human').tasks };
}

export function log(root: string, feature: string | null, event: string, detail = ''): void {
  const e: LogEvent = { ts: new Date().toISOString(), feature, event, detail };
  appendFileSync(paths(root).log, JSON.stringify(e) + '\n');
}

export function tailLines(file: string, n: number): string[] {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}
