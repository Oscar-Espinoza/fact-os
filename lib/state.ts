// State files: JSON, written atomically (temp + rename) under a populated .fact-os/.lock directory.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync, lstatSync, mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import type { ClassifierConfig, EscalationConfig, Config, Control, Feature, HumanTask, LogEvent, Paths, StateFiles, StateName } from './types.ts';
import { OPUS, normalizeProfile, profileNames, profileProblems, validProfile } from './profiles.ts';

// Shadow classifier operating bounds (I07 v2). The model is pinned: the battery and scorer were evaluated on jev-1.13.0.
export const CLASSIFIER_DEFAULTS: ClassifierConfig = { provider: 'typesafe', model: 'jev-1.13.0', mode: 'shadow', timeoutMs: 20000, maxRetries: 1,
  maxRequestsPerDay: 500, glossary: null, scorer: null, escalation: null, auto: true };
// Small pilot limits (agreed with the Codex partner), not learned thresholds.
export const ESCALATION_DEFAULTS: EscalationConfig = { enabled: false, model: 'gpt-6.1-sol', effort: 'high', maxPerDay: 6, maxPerRun: 2, timeoutMin: 5,
  maxQuestions: 6, fallbackMaxBudgetUsd: 2, reviewPlanning: false };

export const DEFAULT_CONFIG: Config = {
  base: 'main', worktreesDir: '../<repo>-worktrees', branchPrefix: 'ship/', maxParallel: 3, maxAttempts: 2,
  budgetUsdPerRun: null, budgetUsdTotal: null, timeoutMin: null,
  builder: { model: 'opus', effort: 'medium', permissionMode: 'auto' },
  evaluator: { model: 'opus', effort: 'high', permissionMode: 'auto' },
  test: 'pnpm test', merge: 'auto', briefFiles: [], lessonsFile: 'CLAUDE.md', postMerge: null, prepare: null, refreshBeforeTest: false,
  groupBy: null, maxRefreshes: 5, mergeHook: null, restoreFrom: null, evaluatorDiffExclude: [], claims: null, conflictBrief: false, resolver: null,
  gateFixes: 0, commitFixes: 0, keepFixes: 1, progressFixes: 1, reviewFixes: 0, setupRetryDelaysSec: [30, 120], diagnoser: null, classifier: null, codex: { fallback: { model: 'opus', effort: 'high' }, cooldownMin: 30 },
};

// The product name, used for the state dir, commit prefixes, headings and UI. Rename here only.
export const NAME = 'fact-os';
// Projects set up before the rename keep their .shipyard/ dir until migrated; new ones get .<NAME>/.
export const STATE_DIRS = [`.${NAME}`, '.shipyard'];
export const stateDirName = (root: string): string => STATE_DIRS.find((d) => existsSync(join(root, d))) ?? STATE_DIRS[0]!;

// FACTOS_<NAME>, falling back to the pre-rename SHIPYARD_<NAME>.
export const envVar = (name: string): string | undefined => process.env[`FACTOS_${name}`] ?? process.env[`SHIPYARD_${name}`];
// Secrets only the factory itself uses: never handed to agents, hooks or scripts, so they cannot read or echo them into
// saved run output.
export const FACTORY_SECRETS = ['TYPESAFE_API_KEY'] as const;
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of FACTORY_SECRETS) delete env[k];
  return env;
}
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
  // Test hook: runs after a dead owner's token was read, before its removal.
  beforeTakeover?: () => void;
}

// Removing an old token cannot remove a successor's different token. rmdir is
// deliberately nonrecursive: a populated successor remains locked, even if it
// was published between this unlink and rmdir. Never move the canonical lock away.
function removeLockOwner(lock: string, owner: string): void {
  try { unlinkSync(join(lock, owner)); } catch (e) {
    if (!['ENOENT', 'ENOTDIR'].includes(errCode(e) ?? '')) throw e;
  }
  try { rmdirSync(lock); } catch (e) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(errCode(e) ?? '')) throw e;
  }
}

export async function withLock<R>(root: string, fn: () => R | Promise<R>, { timeoutMs = 30000, beforeTakeover }: LockOptions = {}): Promise<R> {
  return withDirectoryLock(paths(root).lock, fn, { timeoutMs, beforeTakeover });
}

// Checkout operations may call mutate(), so they must not own the state lock.
export function withCheckoutLock<R>(root: string, fn: () => R | Promise<R>, options: LockOptions = {}): Promise<R> {
  return withDirectoryLock(join(paths(root).dir, '.checkout-lock'), fn, options);
}

async function withDirectoryLock<R>(lock: string, fn: () => R | Promise<R>, { timeoutMs = 30000, beforeTakeover }: LockOptions): Promise<R> {
  const start = Date.now(), owner = `owner-${process.pid}-${randomUUID()}`;
  const staging = mkdtempSync(`${lock}.`);
  try {
    // Publish only a complete, nonempty directory. rename cannot replace a
    // nonempty directory, so no other live owner can be displaced at acquisition.
    writeFileSync(join(staging, owner), '');
    for (;;) {
      try { renameSync(staging, lock); break; } catch (e) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(errCode(e) ?? '')) throw e;
      }
      let heldBy = 'unknown owner';
      try {
        if (!lstatSync(lock).isDirectory()) {
          throw new Error(`legacy or invalid lock ${lock}: stop all old factory, observer and dashboard writers before upgrading; remove the old lock only after they have stopped`);
        }
        const entries = readdirSync(lock);
        // A crashed release can leave an empty directory, but a running callback
        // always owns a populated one. Publication may also replace an empty dir.
        if (entries.length === 0) {
          try { rmdirSync(lock); } catch (e) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(errCode(e) ?? '')) throw e;
          }
        } else if (entries.length === 1) {
          const token = entries[0]!, match = /^owner-([1-9]\d*)-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.exec(token);
          const pid = match ? Number(match[1]) : NaN;
          if (Number.isSafeInteger(pid)) {
            heldBy = `pid ${pid}`;
            if (!pidAlive(pid)) { beforeTakeover?.(); removeLockOwner(lock, token); }
          }
        }
      } catch (e) {
        // Another contender may have finished recovery or release while we read.
        if (!['ENOENT', 'ENOTDIR'].includes(errCode(e) ?? '')) throw e;
      }
      // Every contention path is bounded and yields, including malformed locks
      // and repeated recovery races. Same-process holders must be able to finish.
      if (Date.now() - start >= timeoutMs) throw new Error(`timed out waiting for lock ${lock} (held by ${heldBy})`);
      await sleep(5 + Math.random() * 15);
    }
    try { return await fn(); } finally { removeLockOwner(lock, owner); }
  } finally {
    removeLockOwner(staging, owner);
  }
}

// The state lock serializes short ownership claims/releases, not the supervisor's
// lifetime. PID stays first for dashboard/CLI readers; the nonce identifies this
// invocation, so its cleanup cannot remove a replacement with the same PID.
export async function withSupervisor<R>(root: string, role: 'foreman' | 'observer', fn: () => R | Promise<R>): Promise<R> {
  const file = join(paths(root).dir, `.${role}`), owner = `${process.pid}\n${randomUUID()}\n`;
  const readOwner = () => {
    try { return readFileSync(file, 'utf8'); } catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
  };
  let claimed = false;
  try {
    await withLock(root, () => {
      const previous = readOwner(), firstLine = previous?.split('\n')[0]?.trim() ?? '', pid = Number(firstLine);
      if (previous?.trim() && (!/^[1-9]\d*$/.test(firstLine) || !Number.isSafeInteger(pid))) throw new Error(`invalid ${role} ownership marker ${file}`);
      if (pidAlive(pid)) throw new Error(`another ${role} is running (pid ${pid})`);
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, owner, { flag: 'wx' });
        renameSync(tmp, file);
        claimed = true;
      } finally {
        try { unlinkSync(tmp); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
      }
    });
    return await fn();
  } finally {
    if (claimed) await withLock(root, () => { if (readOwner() === owner) unlinkSync(file); });
  }
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

// Validate only supplied known fields. Missing fields keep existing shallow defaults;
// observer/claims partial defaults are still applied by their own consumers.
function configProblems(raw: unknown): string[] {
  const problems: string[] = [];
  const obj = (x: unknown, path: string): Record<string, unknown> | null => {
    if (x !== null && typeof x === 'object' && !Array.isArray(x)) return x as Record<string, unknown>;
    problems.push(`${path} must be a JSON object`); return null;
  };
  const field = (o: Record<string, unknown>, path: string, key: string, valid: (x: unknown) => boolean, expected: string) => {
    if (Object.hasOwn(o, key) && !valid(o[key])) problems.push(`${path}.${key} must be ${expected}`);
  };
  const str = (x: unknown): boolean => typeof x === 'string' && x.trim().length > 0;
  const strings = (x: unknown): boolean => Array.isArray(x) && x.every(str);
  const uint = (x: unknown): boolean => Number.isSafeInteger(x) && (x as number) >= 0;
  const nonnegative = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const role = (x: unknown, path: string, codexOk = false) => {
    const r = obj(x, path); if (!r) return;
    for (const key of ['model', 'effort', 'permissionMode']) field(r, path, key, str, 'a non-empty string');
    field(r, path, 'provider', (p) => p === 'claude' || (codexOk && p === 'codex'), codexOk ? '"claude" or "codex"' : '"claude" (only the evaluator and the diagnoser can use "codex")');
  };
  const c = obj(raw, 'config'); if (!c) return problems;
  for (const key of ['base', 'worktreesDir', 'test', 'lessonsFile']) field(c, 'config', key, str, 'a non-empty string');
  field(c, 'config', 'branchPrefix', (x) => typeof x === 'string', 'a string');
  for (const key of ['postMerge', 'prepare', 'mergeHook', 'groupBy', 'restoreFrom'])
    field(c, 'config', key, (x) => x === null || typeof x === 'string', 'a string or null');
  for (const key of ['briefFiles', 'evaluatorDiffExclude']) field(c, 'config', key, strings, 'an array of non-empty strings');
  field(c, 'config', 'setupRetryDelaysSec', (x) => Array.isArray(x) && x.length <= 10 && x.every((d) => nonnegative(d) && (d as number) > 0 && (d as number) <= 86400),
    'an array of at most 10 positive delays in seconds (each <= 86400)');
  for (const key of ['refreshBeforeTest', 'conflictBrief']) field(c, 'config', key, (x) => typeof x === 'boolean', 'a boolean');
  field(c, 'config', 'merge', (x) => x === 'auto' || x === 'manual', '"auto" or "manual"');
  for (const key of ['maxParallel', 'maxRefreshes', 'gateFixes', 'commitFixes', 'keepFixes', 'progressFixes', 'reviewFixes']) field(c, 'config', key, uint, 'a safe integer >= 0');
  field(c, 'config', 'maxAttempts', (x) => uint(x) && (x as number) >= 1, 'a safe integer >= 1');
  for (const key of ['budgetUsdPerRun', 'budgetUsdTotal'])
    field(c, 'config', key, (x) => x === null || nonnegative(x), 'a finite number >= 0 or null');
  // exec() passes milliseconds directly to setTimeout: larger delays overflow its native range.
  field(c, 'config', 'timeoutMin', (x) => x === null || (nonnegative(x) && (x as number) > 0 && (x as number) * 60000 <= 2 ** 31 - 1),
    'positive finite minutes within the timer range (<= (2^31 - 1) / 60000), or null');
  for (const key of ['builder', 'evaluator', 'resolver'])
    if (Object.hasOwn(c, key) && !(key === 'resolver' && c[key] === null)) role(c[key], `config.${key}`, key === 'evaluator');
  if (Object.hasOwn(c, 'diagnoser') && c.diagnoser !== null) role(c.diagnoser, 'config.diagnoser', true);
  if (Object.hasOwn(c, 'classifier') && c.classifier !== null) {
    const k = obj(c.classifier, 'config.classifier');
    if (k) {
      field(k, 'config.classifier', 'provider', (x) => x === 'typesafe', '"typesafe"');
      field(k, 'config.classifier', 'model', (x) => typeof x === 'string' && /^jev-\d+\.\d+\.\d+$/.test(x), 'a pinned Jev version such as "jev-1.13.0" (the scorer is calibrated on one version)');
      field(k, 'config.classifier', 'mode', (x) => x === 'shadow', '"shadow" (apply mode comes after the benchmark)');
      for (const key of ['minConfidence', 'minRiskConfidence'])
        if (Object.hasOwn(k, key)) problems.push(`config.classifier.${key} is a v1 setting (one six-way choice); v2 thresholds live in the projection policy: remove it`);
      field(k, 'config.classifier', 'timeoutMs', (x) => uint(x) && (x as number) >= 100 && (x as number) <= 120000, 'milliseconds from 100 to 120000');
      field(k, 'config.classifier', 'maxRetries', (x) => uint(x) && (x as number) <= 2, 'a safe integer from 0 to 2');
      field(k, 'config.classifier', 'maxRequestsPerDay', uint, 'a safe integer >= 0');
      for (const key of ['glossary', 'scorer']) field(k, 'config.classifier', key, (x) => x === null || str(x), 'a path relative to the project root, or null');
      field(k, 'config.classifier', 'auto', (x) => typeof x === 'boolean', 'a boolean');
      if (Object.hasOwn(k, 'escalation') && k.escalation !== null) {
        const e = obj(k.escalation, 'config.classifier.escalation');
        if (e) {
          for (const key of ['model', 'effort']) field(e, 'config.classifier.escalation', key, str, 'a non-empty string');
          for (const key of ['enabled', 'reviewPlanning']) field(e, 'config.classifier.escalation', key, (x) => typeof x === 'boolean', 'a boolean');
          for (const key of ['maxPerDay', 'maxPerRun']) field(e, 'config.classifier.escalation', key, uint, 'a safe integer >= 0');
          field(e, 'config.classifier.escalation', 'maxQuestions', (x) => uint(x) && (x as number) >= 1 && (x as number) <= 11, 'an integer from 1 to 11');
          field(e, 'config.classifier.escalation', 'timeoutMin', (x) => nonnegative(x) && (x as number) > 0 && (x as number) <= 60, 'minutes above 0, at most 60');
          field(e, 'config.classifier.escalation', 'fallbackMaxBudgetUsd', (x) => nonnegative(x) && (x as number) > 0, 'a positive number of dollars');
        }
      }
    }
  }
  if (Object.hasOwn(c, 'codex')) {
    const cx = obj(c.codex, 'config.codex');
    if (cx) {
      if (Object.hasOwn(cx, 'fallback')) role(cx.fallback, 'config.codex.fallback');
      field(cx, 'config.codex', 'cooldownMin', (x) => nonnegative(x) && Number.isFinite((x as number) * 60e3), 'finite minutes >= 0');
    }
  }
  if (Object.hasOwn(c, 'claims') && c.claims !== null) {
    const cl = obj(c.claims, 'config.claims');
    if (cl) {
      field(cl, 'config.claims', 'hot', strings, 'an array of non-empty strings');
      field(cl, 'config.claims', 'minScore', nonnegative, 'a finite number >= 0');
      field(cl, 'config.claims', 'days', (x) => nonnegative(x) && Number.isFinite((x as number) * 86400e3), 'finite days >= 0');
    }
  }
  if (Object.hasOwn(c, 'observer')) {
    const o = obj(c.observer, 'config.observer');
    if (o) {
      for (const key of ['retry', 'improve']) field(o, 'config.observer', key, (x) => typeof x === 'boolean', 'a boolean');
      for (const key of ['maxRetries', 'maxOpenImprovements']) field(o, 'config.observer', key, uint, 'a safe integer >= 0');
      for (const key of ['recurring', 'lessonsMaxBytes']) field(o, 'config.observer', key, (x) => uint(x) && (x as number) > 0, 'a safe integer >= 1');
      field(o, 'config.observer', 'pollSec', (x) => nonnegative(x) && (x as number) > 0 && Number.isFinite((x as number) * 1000), 'positive finite seconds');
      for (const key of ['improveEveryHours', 'curateEveryHours'])
        field(o, 'config.observer', key, (x) => nonnegative(x) && Number.isFinite((x as number) * 3600e3), 'finite hours >= 0');
      field(o, 'config.observer', 'infraPatterns', strings, 'an array of non-empty strings');
      if (Object.hasOwn(o, 'agent') && o.agent !== null) role(o.agent, 'config.observer.agent');
      if (Object.hasOwn(o, 'promptReview')) {
        const pr = obj(o.promptReview, 'config.observer.promptReview');
        if (pr) {
          field(pr, 'config.observer.promptReview', 'enabled', (x) => typeof x === 'boolean', 'a boolean');
          for (const key of ['maxPerPass', 'maxPerDay']) field(pr, 'config.observer.promptReview', key, uint, 'a safe integer >= 0');
          field(pr, 'config.observer.promptReview', 'notesMaxBytes', (x) => uint(x) && (x as number) > 0, 'a safe integer >= 1');
          field(pr, 'config.observer.promptReview', 'everyMinutes', (x) => nonnegative(x) && Number.isFinite((x as number) * 60e3), 'finite minutes >= 0');
        }
      }
    }
  }
  problems.push(...profileProblems(c.profiles));
  return problems;
}

export function loadConfig(root: string): Config {
  const file = paths(root).config, raw: unknown = readJson(file, {}), problems = configProblems(raw);
  if (problems.length) throw new Error(`${file}: invalid configuration:\n${problems.join('\n')}`);
  const c: Config = { ...DEFAULT_CONFIG, ...(raw as Partial<Config>) };
  c.worktreesDir = c.worktreesDir.replace('<repo>', basename(root));
  c.codex = { ...DEFAULT_CONFIG.codex, ...c.codex }; // a partial codex block keeps the default fallback or cooldown
  if (c.classifier) {
    const k = { ...CLASSIFIER_DEFAULTS, ...(c.classifier as Partial<ClassifierConfig>) };
    c.classifier = { ...k, escalation: k.escalation ? { ...ESCALATION_DEFAULTS, ...k.escalation } : null };
  }
  return c;
}

// ---- setup failures (prepare): the foreman's launch hold ----
// failures: recent failed setups across features, cleared by a good setup while no hold is open. hold: open after
// SETUP_HOLD_AFTER consecutive failures across at least two features within SETUP_HOLD_WINDOW_MS; sticky until
// `fact-os setup-resume` (or the dashboard) releases it. Written under the state lock.
export interface SetupState { failures: { feature: string; ts: string }[]; hold: { since: string; reason: string; features: string[] } | null }
export const SETUP_HOLD_AFTER = 3, SETUP_HOLD_WINDOW_MS = 10 * 60e3;
export const setupStateFile = (root: string): string => join(paths(root).dir, 'setup-hold.json');
// Unlocked read: callers either hold the state lock already (the launch claim) or only display it.
export function readSetupState(root: string): SetupState {
  let s: Partial<SetupState> | null = null;
  try { s = readJson(setupStateFile(root), null) as Partial<SetupState> | null; } catch { s = null; }
  return { failures: Array.isArray(s?.failures) ? s.failures : [], hold: s?.hold && typeof s.hold === 'object' ? s.hold : null };
}
export function updateSetupState<R>(root: string, fn: (s: SetupState) => R): Promise<R> {
  return withLock(root, () => { const s = readSetupState(root), r = fn(s); writeJsonAtomic(setupStateFile(root), s); return r; });
}

// A person says the environment is fixed: release the hold, forget the streak, and clear the pending setup delays and
// counts of features still waiting to retry (stuck ones keep theirs until a person retries them). Returns the released hold.
export async function releaseSetupHold(root: string, by: string): Promise<SetupState['hold']> {
  const was = await updateSetupState(root, (s) => { const h = s.hold; s.hold = null; s.failures = []; return h; });
  await mutate(root, 'features', (d) => { for (const f of d.features) if (f.status === 'todo' && (f.setupFailures || f.setupRetryAt)) { delete f.setupFailures; delete f.setupRetryAt; } });
  log(root, null, 'setup-resumed', was ? `by ${by}; the hold since ${was.since} (${was.reason}) is released` : `by ${by}; no hold was open`);
  return was;
}

// Read mutable feature/human state independently of the configuration snapshot a supervisor owns.
export function loadState(root: string): { features: Feature[]; tasks: HumanTask[] } {
  return { features: readState(root, 'features').features, tasks: readState(root, 'human').tasks };
}

export function load(root: string): { config: Config; features: Feature[]; tasks: HumanTask[] } {
  return { config: loadConfig(root), ...loadState(root) };
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

export function log(root: string, feature: string | null, event: string, detail = '', lessonAppend?: LogEvent['lessonAppend'], metadata?: Pick<LogEvent, 'stop' | 'attemptsReset' | 'cause' | 'sha'>): void {
  const e: LogEvent = { ts: new Date().toISOString(), feature, event, detail, ...(lessonAppend ? { lessonAppend } : {}), ...metadata };
  appendFileSync(paths(root).log, JSON.stringify(e) + '\n');
}

export function tailLines(file: string, n: number): string[] {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}
