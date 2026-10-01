// The merge process's pure parts (hot files, claims, the keep-lines check, hunks) and its git reads on a temp repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkLines, claimBlock, conflictBrief, conflictFiles, conflictHunks, declaredDrops, featureFiles, hotScores, hotTest, keepCheck, keepFeedback, missingLines, DEFAULT_CLAIMS } from '../lib/merge.ts';
import { runTag } from '../lib/foreman.ts';
import { DEFAULT_CONFIG } from '../lib/state.ts';
import type { LogEvent } from '../lib/types.ts';

const ev = (ts: string, feature: string, event: string, detail = ''): LogEvent => ({ ts, feature, event, detail });

test('the merge process is off by default: no claims, no brief, no resolver', () => {
  assert.deepEqual([DEFAULT_CONFIG.claims, DEFAULT_CONFIG.conflictBrief, DEFAULT_CONFIG.resolver], [null, false, null]);
});

test('conflictFiles reads the files of a conflicting refresh, nothing from a clean one', () => {
  assert.deepEqual(conflictFiles('conflicts in: a.ts, b/c.json'), ['a.ts', 'b/c.json']);
  assert.deepEqual(conflictFiles('conflict-free'), []);
  assert.deepEqual(conflictFiles('before test, conflict-free'), []);
});

test('hotScores: 1 per conflicting refresh, 2 for a bounce (right after evaluating, a lesson between allowed), only inside the window', () => {
  const events = [
    ev('2026-09-01T00:00:00Z', 'old', 'refreshed', 'conflicts in: p.ts'),                 // before the window
    ev('2026-09-10T00:00:00Z', 'a', 'launch'), ev('2026-09-10T00:01:00Z', 'a', 'refreshed', 'conflicts in: p.ts, q.ts'),
    ev('2026-09-10T00:02:00Z', 'b', 'evaluating'), ev('2026-09-10T00:03:00Z', 'b', 'lesson', 'x'),
    ev('2026-09-10T00:04:00Z', 'b', 'refreshed', 'conflicts in: p.ts'),                    // bounce
    ev('2026-09-10T00:05:00Z', 'c', 'refreshed', 'conflict-free')];
  const s = hotScores(events, Date.parse('2026-09-05T00:00:00Z'));
  assert.deepEqual(Object.fromEntries(s), { 'p.ts': 3, 'q.ts': 1 });
  const hot = hotTest(s, { ...DEFAULT_CLAIMS, minScore: 3, hot: ['gen/'] });
  assert.deepEqual(['p.ts', 'q.ts', 'gen/x.json', 'other.ts'].map(hot), [true, false, true, false]);
});

test('claimBlock: a shared hot file blocks, a shared cold file does not; dir prefixes on either side match; nothing held, nothing blocks', () => {
  const hot = (f: string) => f === 'p.ts' || f.startsWith('gen/');
  assert.deepEqual(claimBlock(['x.ts', 'p.ts'], [['a', ['y.ts']], ['b', ['p.ts']]], hot), { file: 'p.ts', by: 'b' });
  assert.equal(claimBlock(['x.ts'], [['a', ['x.ts']]], hot), null, 'x.ts is not hot');
  assert.deepEqual(claimBlock(['gen/a.json'], [['a', ['gen/']]], hot), { file: 'gen/a.json', by: 'a' }, 'declared dir prefix held');
  assert.deepEqual(claimBlock(['gen/'], [['a', ['gen/b.json']]], hot), { file: 'gen/', by: 'a' }, 'declared dir prefix wanted');
  assert.equal(claimBlock(['p.ts'], [], hot), null);
});

// A registry both sides append to before the same closing brace: the shape that kept conflicting in provisioning.ts.
const BASE = 'export const grants = {\n  m1: (s) => [\n    `grant ${s}`,\n  ],\n};\n';
const OURS = BASE.replace('};', '  m2: (s) => [\n    `grant two ${s}`,\n  ],\n};');
const THEIRS = BASE.replace('};', '  m3: (s) => [\n    `grant three ${s}`,\n  ],\n};');

test('missingLines: keeping both entries passes, in any order and indentation', () => {
  const both = BASE.replace('};', '  m3: (s) => [\n    `grant three ${s}`,\n  ],\n      m2: (s) => [\n `grant two ${s}`,\n  ],\n};');
  assert.deepEqual(missingLines(BASE, OURS, THEIRS, both), []);
});

test('missingLines: a union merge that shares one closer between two entries is caught (the reverted driver\'s failure)', () => {
  const union = BASE.replace('};', '  m2: (s) => [\n    `grant two ${s}`,\n  m3: (s) => [\n    `grant three ${s}`,\n  ],\n};');
  assert.deepEqual(missingLines(BASE, OURS, THEIRS, union), [{ line: '],', missing: 1, side: 'both' }]);
});

test('missingLines: taking one side loses the other side\'s lines; one side\'s deletion is respected; a line both sides added is kept once', () => {
  // theirs' entry, including its own closer: the result needs three `],` (base, ours, theirs) and has two
  assert.deepEqual(missingLines(BASE, OURS, THEIRS, OURS).map((m) => [m.line, m.side]), [['],', 'both'], ['`grant three ${s}`,', 'theirs'], ['m3: (s) => [', 'theirs']]);
  const base = 'a\nb\nc\n', ours = 'a\nc\nimport x\n', theirs = 'a\nb\nc\nimport x\nd\n';
  assert.deepEqual(missingLines(base, ours, theirs, 'a\nc\nimport x\nd\n'), [], 'b deleted by ours, same import added by both');
  assert.deepEqual(missingLines(base, ours, theirs, 'a\nc\nd\n'), [{ line: 'import x', missing: 1, side: 'both' }]);
});

test('checkLines: a key renumbered because both sides took the number, a moved `;` and a rewrapped comment are changes, not losses', () => {
  const base = "const g = {\n  '0001_init': x,\n};\ntype E =\n  | 'A';\n";
  const ours = base.replace('};', "  '0002_a': ya,\n};").replace("| 'A';", "| 'A'\n  | 'B';") + '// ours explains a\n';
  const theirs = base.replace('};', "  '0002_b': yb,\n};").replace("| 'A';", "| 'A'\n  | 'C';") + '// theirs explains b\n';
  const res = base.replace('};', "  '0002_b': yb,\n  '0003_a': ya,\n};").replace("| 'A';", "| 'A'\n  | 'C'\n  | 'B';") + '// both explained\n';
  const c = checkLines(base, ours, theirs, res);
  assert.deepEqual(c.lost, []);
  assert.deepEqual(c.changed, [{ line: "'0002_a': ya,", now: "'0003_a': ya," }, { line: "| 'C';", now: "| 'C'" }]);
  // one line both sides edited, combined into one: both versions are changes
  const cmd = checkLines('"check": "a"\n', '"check": "a && b"\n', '"check": "a && c"\n', '"check": "a && b && c"\n');
  assert.deepEqual([cmd.lost, cmd.changed.length], [[], 2]);
  // renumbering one entry does not excuse dropping the other
  const dropped = base.replace('};', "  '0003_a': ya,\n};").replace("| 'A';", "| 'A'\n  | 'B';");
  assert.deepEqual(checkLines(base, ours, theirs, dropped).lost.map((m) => m.line), ["'0002_b': yb,", "| 'C';"]);
});

test('declaredDrops reads `dropped: <file>: <line>` lines from commit messages', () => {
  const d = declaredDrops('merge main\n\ndropped: src/a.ts: import { x } from "y";\nbecause main already imports it\ndropped: b.json:   "k": 1,\n');
  assert.deepEqual([...d], ['src/a.ts\nimport { x } from "y";', 'b.json\n"k": 1,']);
});

test('conflictHunks keeps each conflict block with its context, joins gaps with …, and caps the size', () => {
  const text = ['l1', 'l2', 'l3', 'l4', '<<<<<<< HEAD', 'ours', '||||||| base', 'old', '=======', 'theirs', '>>>>>>> main', 'l5', ...Array(20).fill('x'),
    '<<<<<<< HEAD', 'o2', '=======', 't2', '>>>>>>> main', 'end'].join('\n');
  const h = conflictHunks(text, 1);
  assert.match(h, /^l4\n<<<<<<< HEAD\nours\n\|\|\|\|\|\|\| base\nold\n=======\ntheirs\n>>>>>>> main\nl5\n…\nx\n<<<<<<< HEAD/);
  assert.doesNotMatch(h, /l3/);
  assert.match(conflictHunks(text, 1, 30), /more chars: open the file/);
  assert.equal(conflictHunks('no markers\n'), '');
});

// ---- git: a real conflict in a temp repo ----

function repo(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'fact-os-merge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (files: Record<string, string>, msg: string) => { for (const [f, c] of Object.entries(files)) { writeFileSync(join(dir, f), c); git('add', f); } git('commit', '-qm', msg); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@e.x');
  commit({ 'reg.ts': BASE, 'other.ts': 'x\n' }, 'init');
  git('checkout', '-qb', 'ship/a'); commit({ 'reg.ts': OURS }, 'a adds m2'); git('checkout', '-q', 'main');
  // two feature merges on main: one touches reg.ts, one does not; plus a plain commit touching reg.ts's sibling
  for (const [id, files] of [['F1-x', { 'reg.ts': THEIRS }], ['F2-y', { 'other.ts': 'y\n' }]] as const) {
    git('checkout', '-qb', `ship/${id}`); commit(files, `${id} work`); git('checkout', '-q', 'main');
    git('merge', '--no-ff', '-q', '-m', `fact-os: merge ${id}: Title of ${id}`, `ship/${id}`);
  }
  return { dir, git, commit };
}

test('conflictBrief: this feature, the feature merges on base that touched the conflicting file (with their checks), and diff3 hunks', (t) => {
  const { dir, git } = repo(t);
  git('checkout', '-q', 'ship/a');
  const ours = git('rev-parse', 'HEAD'), theirs = git('rev-parse', 'main');
  assert.notEqual(spawnSync('git', ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-edit', theirs], { cwd: dir }).status, 0);
  const features = [{ id: 'F1-x', title: 'Title of F1-x', description: 'Adds grant m3 for the X tables', acceptance: ['m3 grants select'] },
    { id: 'F2-y', title: 'Title of F2-y', description: 'Unrelated', acceptance: ['y'] }];
  const b = conflictBrief({ wt: dir, base: 'main', branch: 'ship/a', ours, theirs, files: ['reg.ts'],
    feature: { id: 'a', title: 'Feature a', description: 'Adds grant m2', acceptance: ['m2 grants select'] }, features });
  assert.match(b.text, /This branch: a: Feature a\nAdds grant m2\nAcceptance:\n- m2 grants select/);
  assert.match(b.text, /- F1-x: Title of F1-x \([0-9a-f]{12}; files: reg\.ts\)\n {2}Adds grant m3 for the X tables\n {2}Acceptance:\n {2}- m3 grants select/);
  assert.doesNotMatch(b.text, /F2-y/, 'F2-y did not touch the conflicting file');
  assert.match(b.text, /#### reg\.ts \(UU\)\n```\n[\s\S]*<<<<<<< HEAD[\s\S]*grant two[\s\S]*\|\|\|\|\|\|\|[\s\S]*grant three[\s\S]*>>>>>>> /);
  assert.match(b.others, /^- F1-x: Title of F1-x \(reg\.ts\)\n {2}- m3 grants select$/);
  // featureFiles: declared, committed diff base...branch, and the worktree's edits; during the merge, not base's staged files
  writeFileSync(join(dir, 'new.ts'), 'x\n');
  assert.deepEqual(featureFiles(dir, { touches: ['docs/'] }, 'main', 'ship/a', dir).sort(), ['docs/', 'new.ts', 'reg.ts']);
  git('merge', '--abort');
  writeFileSync(join(dir, 'other.ts'), 'edited\n');
  assert.deepEqual(featureFiles(dir, {}, 'main', 'ship/a', dir).sort(), ['new.ts', 'other.ts', 'reg.ts'], 'outside a merge every edit counts');
});

test('keepCheck: a resolution that drops the other side fails until the drop is declared; keeping both passes', (t) => {
  const { dir, git, commit } = repo(t);
  git('checkout', '-q', 'ship/a');
  const ours = git('rev-parse', 'HEAD'), theirs = git('rev-parse', 'main');
  spawnSync('git', ['merge', '--no-edit', theirs], { cwd: dir });
  commit({ 'reg.ts': OURS }, 'merge main, taking ours');
  const tip = () => git('rev-parse', 'HEAD');
  let k = keepCheck(dir, ours, theirs, tip(), ['reg.ts']);
  assert.equal(k.ok, false);
  assert.deepEqual(k.missing.map((m) => [m.file, m.line, m.side]), [['reg.ts', '],', 'both'], ['reg.ts', '`grant three ${s}`,', 'theirs'], ['reg.ts', 'm3: (s) => [', 'theirs']]);
  assert.deepEqual(k.changed, []);
  assert.match(keepFeedback('main', k.missing), /- reg\.ts: `m3: \(s\) => \[` \(added by main\)/);
  git('commit', '-q', '--allow-empty', '-m', 'm3 moved to another file\n\ndropped: reg.ts: m3: (s) => [\ndropped: reg.ts: `grant three ${s}`,\ndropped: reg.ts: ],');
  assert.equal(keepCheck(dir, ours, theirs, tip(), ['reg.ts']).ok, true, 'declared drops are accepted');
  commit({ 'reg.ts': readFileSync(join(dir, 'reg.ts'), 'utf8').replace('};', '  m3: (s) => [\n    `grant three ${s}`,\n  ],\n};') }, 'put m3 back');
  assert.equal(keepCheck(dir, ours, tip(), tip(), ['reg.ts']).ok, true);
});

test('runTag counts resolver run files, so a resolution pass never overwrites an earlier pass', () => {
  assert.equal(runTag(['1-build.json', '1-eval.json', '1.2-resolve.json'], 1), '1.3');
  assert.equal(runTag(['1-build.json', '1-eval.json'], 1), '1.2');
});
