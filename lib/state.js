// State files: JSON, written atomically (temp + rename) under .shipyard/.lock (O_EXCL, stale when its PID is dead).
import { readFileSync, writeFileSync, renameSync, linkSync, openSync, closeSync, writeSync, unlinkSync, appendFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export const DEFAULT_CONFIG = {
  base: 'main', worktreesDir: '../<repo>-worktrees', branchPrefix: 'ship/', maxParallel: 3, maxAttempts: 2,
  budgetUsdPerRun: null, budgetUsdTotal: null, timeoutMin: null,
  builder: { model: 'opus', effort: 'medium', permissionMode: 'auto' },
  evaluator: { model: 'opus', effort: 'high', permissionMode: 'auto' },
  test: 'npm test', merge: 'auto', briefFiles: [], lessonsFile: 'CLAUDE.md', postMerge: null, prepare: null,
};

export function paths(root) {
  const dir = join(root, '.shipyard');
  return { dir, config: join(dir, 'config.json'), features: join(dir, 'features.json'), human: join(dir, 'human.json'),
    log: join(dir, 'log.jsonl'), activity: join(dir, 'activity.jsonl'), lock: join(dir, '.lock'),
    foreman: join(dir, '.foreman'), runs: join(dir, 'runs') };
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${file}: ${e.message}`);
  }
}

let seq = 0;
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withLock(root, fn, { timeoutMs = 30000 } = {}) {
  const lock = paths(root).lock;
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid, age;
      try { pid = parseInt(readFileSync(lock, 'utf8'), 10); age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      // Stale: holder is dead, or the file stayed empty (writer died between open and write).
      const stale = (p, a) => (p ? !pidAlive(p) : a > 5000);
      if (stale(pid, age)) {
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

const EMPTY = { features: () => ({ features: [] }), human: () => ({ tasks: [] }) };

// Read-modify-write one state file ('features' | 'human') under the lock; fn mutates the data in place.
export function mutate(root, name, fn) {
  const file = paths(root)[name];
  return withLock(root, async () => {
    const data = readJson(file, EMPTY[name]());
    const out = await fn(data);
    writeJsonAtomic(file, data);
    return out;
  });
}

export function loadConfig(root) {
  const c = { ...DEFAULT_CONFIG, ...readJson(paths(root).config, {}) };
  c.worktreesDir = c.worktreesDir.replace('<repo>', basename(root));
  return c;
}

export function load(root) {
  const p = paths(root);
  return { config: loadConfig(root), features: readJson(p.features, EMPTY.features()).features,
    tasks: readJson(p.human, EMPTY.human()).tasks };
}

export function log(root, feature, event, detail = '') {
  appendFileSync(paths(root).log, JSON.stringify({ ts: new Date().toISOString(), feature, event, detail }) + '\n');
}

export function tailLines(file, n) {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}
