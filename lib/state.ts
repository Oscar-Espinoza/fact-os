// State files: JSON, written atomically (temp + rename) under .fact-os/.lock (O_EXCL, stale when its PID is dead).
import { existsSync, readFileSync, writeFileSync, renameSync, linkSync, openSync, closeSync, writeSync, unlinkSync, appendFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Config, Control, Feature, HumanTask, LogEvent, Paths, StateFiles, StateName } from './types.ts';
import { OPUS, normalizeProfile, profileNames, validProfile } from './profiles.ts';

export const DEFAULT_CONFIG: Config = {
  base: 'main', worktreesDir: '../<repo>-worktrees', branchPrefix: 'ship/', maxParallel: 3, maxAttempts: 2,
  budgetUsdPerRun: null, budgetUsdTotal: null, timeoutMin: null,
  builder: { model: 'opus', effort: 'medium', permissionMode: 'auto' },
  evaluator: { model: 'opus', effort: 'high', permissionMode: 'auto' },
  test: 'pnpm test', merge: 'auto', briefFiles: [], lessonsFile: 'CLAUDE.md', postMerge: null, prepare: null, refreshBeforeTest: false,
  groupBy: null, maxRefreshes: 5, mergeHook: null, restoreFrom: null, evaluatorDiffExclude: [], claims: null, conflictBrief: false, resolver: null,
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
    foreman: join(dir, '.foreman'), runs: join(dir, 'runs'), control: join(dir, 'control.json') };
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

// ---- control.json: pause new work / lanes ----

export const MAX_LANES = 32;
export const validLanes = (x: unknown): x is number | null => x === null || (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= MAX_LANES);

export const DEFAULT_CONTROL: Control = { paused: false, maxParallel: null };

// The control file as found: a missing file means the defaults ("not paused, config's lanes, opus"); a file that exists but is
// not JSON, not an object, or has a wrong `paused`/`maxParallel`/`profile` is invalid, and callers must not read it as the
// defaults (the foreman keeps its last good control, or holds all new work when it has none). With `config`, a profile name it
// does not know is invalid too. `profile` is in `control` only when the file has one ("opus" read as null). `text` is the raw
// content, to report it once.
export type ControlRead = { ok: true; control: Control; missing: boolean } | { ok: false; error: string; text: string };
export function readControlFile(root: string, config?: Pick<Config, 'profiles'>): ControlRead {
  const P = paths(root), name = `${P.name}/control.json`; // short name in messages: they are shown in the dashboard
  let text: string;
  try { text = readFileSync(P.control, 'utf8'); } catch (e) {
    return errCode(e) === 'ENOENT' ? { ok: true, control: { ...DEFAULT_CONTROL }, missing: true } : { ok: false, error: `${name}: ${errCode(e) || errMsg(e)}`, text: '' };
  }
  const bad = (why: string): ControlRead => ({ ok: false, error: `${name}: ${why}`, text });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return bad(`not JSON (${errMsg(e)})`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('not a JSON object');
  const r = raw as Record<string, unknown>;
  if (r.paused !== undefined && typeof r.paused !== 'boolean') return bad(`"paused" must be true or false (is ${JSON.stringify(r.paused)})`);
  if (r.maxParallel !== undefined && !validLanes(r.maxParallel)) return bad(`"maxParallel" must be an integer from 0 to ${MAX_LANES} or null (is ${JSON.stringify(r.maxParallel)})`);
  if (r.profile !== undefined && r.profile !== null && typeof r.profile !== 'string') return bad(`"profile" must be a profile name or null (is ${JSON.stringify(r.profile)})`);
  if (typeof r.profile === 'string' && config && !validProfile(config, r.profile)) return bad(`unknown profile "${r.profile}" (known: ${profileNames(config).join(', ')})`);
  return { ok: true, missing: false, control: { paused: r.paused === true, maxParallel: (r.maxParallel ?? null) as number | null,
    ...(r.profile !== undefined ? { profile: r.profile === OPUS ? null : r.profile as string | null } : {}),
    ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {}), ...(r.by === 'dashboard' || r.by === 'cli' ? { by: r.by } : {}) } };
}

// Changes control.json under the state lock (atomic write); throws on an invalid maxParallel or an unknown profile ("opus" and
// "default" are written as null). Profiles are checked against `config`, else the project's config.json. Returns what was written.
export async function writeControl(root: string, patch: Partial<Pick<Control, 'paused' | 'maxParallel' | 'profile'>>, by: NonNullable<Control['by']>, config?: Pick<Config, 'profiles'>): Promise<Control> {
  if ('maxParallel' in patch && !validLanes(patch.maxParallel)) throw new Error(`lanes must be an integer from 0 to ${MAX_LANES}, or null for the config default`);
  if ('paused' in patch && typeof patch.paused !== 'boolean') throw new Error('paused must be a boolean');
  // The config is read only when needed: a lanes or pause write still works with an unreadable config.json.
  let cfg = config;
  if (!cfg) try { cfg = loadConfig(root); } catch (e) { if ('profile' in patch) throw e; }
  const profile = 'profile' in patch ? (typeof patch.profile === 'string' ? normalizeProfile(patch.profile) : patch.profile) : undefined;
  if ('profile' in patch && !validProfile(cfg!, profile)) throw new Error(`unknown profile ${JSON.stringify(patch.profile)} (known: ${profileNames(cfg!).join(', ')}, or default)`);
  return withLock(root, () => {
    const r = readControlFile(root, cfg), cur = r.ok ? r.control : DEFAULT_CONTROL; // writing repairs an invalid file
    const next: Control = { paused: patch.paused ?? cur.paused, maxParallel: 'maxParallel' in patch ? patch.maxParallel! : cur.maxParallel,
      profile: 'profile' in patch ? profile! : cur.profile ?? null, updatedAt: new Date().toISOString(), by };
    writeJsonAtomic(paths(root).control, next);
    return next;
  });
}

// How many features may be in flight: 0 while paused, else the control's lanes, else config.maxParallel (at least 1, as before).
export const effectiveLimit = (c: Pick<Control, 'paused' | 'maxParallel'>, config: Pick<Config, 'maxParallel'>): number =>
  c.paused ? 0 : c.maxParallel ?? Math.max(1, config.maxParallel);

export function log(root: string, feature: string | null, event: string, detail = ''): void {
  const e: LogEvent = { ts: new Date().toISOString(), feature, event, detail };
  appendFileSync(paths(root).log, JSON.stringify(e) + '\n');
}

export function tailLines(file: string, n: number): string[] {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}
