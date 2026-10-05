import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { atomStale, candidateMap, clipBytes, specIdentifiers, pickAtoms, recap, parsePointer, refPrints, renderContext, refsHold, selectLessons, symbolDefined, type Atom } from '../lib/context.ts';
import { parseAtomCheck } from '../lib/observe.ts';
import { git } from '../lib/foreman.ts';
import type { Feature } from '../lib/types.ts';

const F = (o: Partial<Feature> = {}): Feature => ({ id: 'a', title: 'Exception queue', description: '', acceptance: [], surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });
const atom = (id: string, scope: string[], o: Partial<Atom> = {}): Atom => ({ id, text: `use ${id}`, refs: [{ path: 'src/x.ts' }], scope, role: 'builder', status: 'verified',
  source: { feature: 'f', review: 'r', ts: '' }, verifiedAt: '2026-10-01T00:00:00Z', ...o });

test('specIdentifiers: code the spec names, never plain English', () => {
  assert.deepEqual(specIdentifiers(F({ title: 'Retry supplier orders', description: 'Call `retrySupplierOrder()` when timeout_after_accept; see codedErrorHandler.', acceptance: ['The order is all-or-nothing for the shopper'] })),
    ['retrySupplierOrder', 'timeout_after_accept', 'codedErrorHandler', 'all-or-nothing']);
});

test('candidateMap: declared, named, multi-identifier and name-matched files rank; common identifiers are dropped; exports are listed', () => {
  const d = mkdtempSync(join(tmpdir(), 'ctx-'));
  try {
    const w = (p: string, s: string) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), s); };
    w('src/queue.ts', 'export function enqueueException() {}\nexport const MAX_EXCEPTIONS = 3;\n// parkOrder');
    w('src/park.ts', 'parkOrder enqueueException');
    for (let i = 0; i < 4; i++) w(`fixtures/exception-queue-${i}.json`, '{}');
    for (let i = 0; i < 30; i++) w(`noise/n${i}.ts`, 'useThing');
    w('src/exception-queue.ts', 'x');
    execFileSync('git', ['init', '-q'], { cwd: d }); execFileSync('git', ['add', '.'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: d });
    const m = candidateMap(F({ description: 'Use `enqueueException` and `parkOrder`; avoid `useThing`.', touches: ['src/new.ts'] }), d, git);
    assert.deepEqual(m.dropped, ['useThing']);
    assert.deepEqual(m.files.map((x) => [x.path, x.count ?? 0]), [['src/new.ts', 0], ['src/park.ts', 0], ['src/queue.ts', 0], ['fixtures/', 4], ['src/exception-queue.ts', 0]]);
    assert.deepEqual(m.files.find((x) => x.path === 'src/queue.ts')!.exports, ['enqueueException', 'MAX_EXCEPTIONS']);
    assert.match(renderContext(m, { included: [], deferred: [], bytes: 0 }), /^\n## Map\n\nLikely places \(a prediction/);
    assert.equal(refsHold([{ path: 'src/queue.ts', symbol: 'MAX_EXCEPTIONS' }], 'HEAD', d, git), null);
    assert.match(refsHold([{ path: 'src/queue.ts', symbol: 'gone' }], 'HEAD', d, git)!, /gone is not defined in src\/queue.ts/);
    assert.equal(renderContext(candidateMap(F({ title: 'Something vague' }), d, git), { included: [], deferred: [], bytes: 0 }), '');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('pickAtoms: only verified atoms whose scope covers a candidate, ranked by coverage, whole atoms within the budget; misses are recorded', () => {
  const atoms = [atom('A1', ['src/api']), atom('A2', ['src/']), atom('A3', ['docs/']), atom('A4', ['src/'], { status: 'proposed' }), atom('A5', ['src/api/'], { text: 'x'.repeat(200) }), atom('A6', ['src/api'])];
  const p = pickAtoms(atoms, ['src/api/a.ts', 'src/api/b.ts', 'src/web/c.ts'], 120, (a) => (a.id === 'A6' ? 'gone' : null));
  assert.deepEqual(p.included.map((a) => a.id), ['A2', 'A1']);
  assert.deepEqual(p.deferred, [{ id: 'A5', why: 'over the context budget' }, { id: 'A6', why: 'gone' }]);
  assert.match(renderContext({ files: [], identifiers: [], dropped: [] }, p), /Verified pointers[^\n]*\n- use A2 \(src\/x\.ts\)\n- use A1/);
});

test('recap: short feedback passes; long feedback stays within its byte and line caps, keeps failures in order and counts the rest', () => {
  assert.equal(recap('FAILED a: short', '/f.md', 100), 'FAILED a: short');
  const long = ['FAILED tenant check: ' + 'e'.repeat(500), 'continuation detail '.repeat(20), 'BLOCKING: idempotence breaks on replay', 'CHEATING: assertion removed'].join('\n');
  const r = recap(long, '/runs/a/1-previous-feedback.md', 400), lines = r.split('\n');
  assert.ok(Buffer.byteLength(r) <= 400);
  assert.match(lines[0]!, /^FAILED tenant check: e+ \[…\]$/); assert.equal(lines[1], 'BLOCKING: idempotence breaks on replay'); assert.equal(lines[2], 'CHEATING: assertion removed');
  assert.match(r, /The full feedback \(\d+ bytes\) is in \/runs\/a\/1-previous-feedback.md/);
  const many = Array.from({ length: 30 }, (_, i) => `BLOCKING: blocker ${i} ` + 'é'.repeat(150)).join('\n'), m = recap(many, '/f.md', 4000);
  assert.ok(Buffer.byteLength(m) <= 4000); assert.ok(m.split('\n').length <= 15);
  assert.match(m, /^BLOCKING: blocker 0 /); assert.match(m, /… and 17 more failure lines, listed in full in the file below\./);
});

test('atoms stay honest: symlinks and comment mentions do not hold; any change to a referenced file or an old verification makes an atom stale, another file\'s change does not', () => {
  const d = mkdtempSync(join(tmpdir(), 'ctx-'));
  try {
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d });
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, 'src/t.ts'), 'export function tenantScoped(x: number) {\n  return true;\n}\n\nexport const other = 1;\n// mentions ghostFn only in a comment\n');
    execFileSync('ln', ['-s', '/etc/hostname', join(d, 'src/outside.ts')]);
    g('init', '-q'); g('add', '.'); g('commit', '-qm', 'x');
    assert.match(refsHold([{ path: 'src/outside.ts' }], 'HEAD', d, git)!, /not a regular file/);
    assert.match(refsHold([{ path: 'src/t.ts', symbol: 'ghostFn' }], 'HEAD', d, git)!, /ghostFn is not defined/);
    const a = atom('A1', ['src/'], { refs: [{ path: 'src/t.ts', symbol: 'tenantScoped' }], verifiedAt: new Date().toISOString(), prints: refPrints([{ path: 'src/t.ts', symbol: 'tenantScoped' }], 'HEAD', d, git) });
    assert.equal(atomStale(a, 'HEAD', d, git), null);
    writeFileSync(join(d, 'src/other.ts'), 'x'); g('add', '.'); g('commit', '-qm', 'another file');
    assert.equal(atomStale(a, 'HEAD', d, git), null);
    writeFileSync(join(d, 'src/t.ts'), 'export function tenantScoped(x: number) {\n  return true;\n}\n\nexport const other = 2;\n'); g('commit', '-qam', 'same file');
    assert.equal(atomStale(a, 'HEAD', d, git), 'its file changed since it was verified');
    assert.equal(atomStale({ ...a, prints: refPrints(a.refs, 'HEAD', d, git), verifiedAt: '2020-01-01T00:00:00Z' }, 'HEAD', d, git), 'its verification is over 30 days old');
    assert.equal(atomStale({ ...a, prints: undefined }, 'HEAD', d, git), 'it has no verified fingerprint');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('selectLessons: under budget unchanged; over budget the relevant whole bullets under their headings, and the rest counted with the file', () => {
  const text = ['## Lessons', '', '### Migrations', '- Number migrations in `migrations/` carefully.', '- Grants go in `packages/platform/src/grants/`.', '', '### Money', '- Refunds use bigint cents everywhere for refund amounts.', '- ' + 'x'.repeat(300)].join('\n');
  assert.equal(selectLessons(text, [], '', 10000, null).text, text);
  const s = selectLessons(text, ['packages/platform/src/grants/a.ts'], 'Partial refund amounts', 260, '/runs/a/1-lessons.md');
  assert.deepEqual([s.included, s.total], [3, 4]);
  assert.equal(s.text, '### Migrations\n- Number migrations in `migrations/` carefully.\n- Grants go in `packages/platform/src/grants/`.\n\n### Money\n- Refunds use bigint cents everywhere for refund amounts.\n(1 more lesson not shown here; all 4 are in /runs/a/1-lessons.md.)');
});

test('parsePointer and parseAtomCheck: bounded, repository-relative, malformed is absent', () => {
  assert.deepEqual(parsePointer({ text: 'Reuse codedErrorHandler.', refs: [{ path: 'apps/api/coded.ts', symbol: 'codedErrorHandler' }, { path: '/etc/passwd' }, { path: '../x' }], scope: ['apps/api/', 'a'] }),
    { text: 'Reuse codedErrorHandler.', refs: [{ path: 'apps/api/coded.ts', symbol: 'codedErrorHandler' }], scope: ['apps/api/'] });
  assert.equal(parsePointer({ text: 'x', refs: [], scope: ['apps/'] }), null); assert.equal(parsePointer('nope'), null);
  assert.deepEqual(parseAtomCheck('{"accurate": true, "applies": false, "reason": "one-off"}'), { ok: false, reason: 'one-off' });
  assert.equal(parseAtomCheck('{"accurate": "yes"}'), null);
});

test('symbolDefined: code only — never a comment or a string; a regex after return is a regex', () => {
  assert.equal(symbolDefined('/*\nexport function ghost() {}\n*/\n', 'ghost'), false);
  assert.equal(symbolDefined('// export const ghost2 = 1\n', 'ghost2'), false);
  assert.equal(symbolDefined('const s = `\nexport function ghost3() {}\n`;\n', 'ghost3'), false);
  assert.equal(symbolDefined('export const OPEN = "/*";\nexport function tenantScoped() {\n  return true;\n}\nexport const CLOSE = "*/";\n', 'tenantScoped'), true);
  assert.equal(symbolDefined('export function a(i: string) {\n  return /}/.test(i) ? 1 // x\n    : 2;\n}\nexport function b() {}\n', 'b'), true);
  assert.equal(symbolDefined('class A {\n  run(a: number) {}\n}\n', 'run'), true);
});

test('recheck: the recap never shortens its file reference; clipping counts its marker; prose lessons are budgeted by paragraph', () => {
  const path = '/home/oscar/Projects/ecommerce-builder/.shipyard/runs/F99-44-collect-direct-full-gate-timings/1-previous-feedback.md';
  const many = Array.from({ length: 30 }, (_, i) => `BLOCKING: blocker ${i} ` + 'x'.repeat(300)).join('\n'), r = recap(many, path, 1000);
  assert.ok(r.includes(path)); assert.ok(Buffer.byteLength(r) <= 1000); assert.match(r, /^BLOCKING: blocker 0 /);
  assert.match(recap(many, path, 200), new RegExp(`^30 failure lines did not fit here\\. The full feedback \\(\\d+ bytes\\) is in ${path.replace(/[./-]/g, '\\$&')};`));
  assert.equal(Buffer.byteLength(clipBytes('ééééééééé', 10)), 10); assert.equal(clipBytes('abcdef', 1), '');
  const prose = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} about migrations and grants.\n${'y'.repeat(600)}`).join('\n\n');
  const s = selectLessons(prose, [], 'migrations', 6000, '/runs/a/1-lessons.md');
  assert.ok(Buffer.byteLength(s.text) <= 6000); assert.equal(s.total, 30); assert.ok(s.included > 0 && s.included < 30);
  assert.match(s.text, /more lessons not shown here; all 30 are in \/runs\/a\/1-lessons\.md/);
});

test('selectLessons: indented sub-items stay with their parent lesson', () => {
  const text = '### Reuse\n- Reuse these helpers:\n  - `a` in `x/`\n  - `b` in `y/`\n- ' + 'z'.repeat(2000);
  const s = selectLessons(text, ['x/f.ts'], '', 1000, '/l.md');
  assert.equal(s.total, 2); assert.match(s.text, /- Reuse these helpers:\n  - `a` in `x\/`\n  - `b` in `y\/`/);
});

test('selectLessons: an unindented paragraph after a blank line is its own entry, not part of the lesson above it', () => {
  const text = '### Reuse\n- Reuse `src/tenant.ts` for tenant isolation:\n  - `scoped()`\n\n' + 'Historical note. '.repeat(500);
  const s = selectLessons(text, ['src/tenant.ts'], 'tenant isolation', 6000, '/l.md');
  assert.equal(s.total, 2); assert.equal(s.included, 1); assert.match(s.text, /^### Reuse\n- Reuse `src\/tenant.ts` for tenant isolation:\n  - `scoped\(\)`\n\(1 more lesson/);
});

test('fourth recheck: fingerprints are exact blob ids; an unsure scan is unknown, not evidence; destructured and $ names are found', () => {
  const d = mkdtempSync(join(tmpdir(), 'ctx-'));
  try {
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d });
    writeFileSync(join(d, 'f.bin'), Buffer.from([0x80])); writeFileSync(join(d, 'e.txt'), 'fixture\n'); g('init', '-q'); g('add', '.'); g('commit', '-qm', 'x');
    const refs = [{ path: 'f.bin' }, { path: 'e.txt' }], a = atom('A1', ['f'], { refs, verifiedAt: new Date().toISOString(), prints: refPrints(refs, 'HEAD', d, git) });
    assert.ok(a.prints!.every((p) => /^[0-9a-f]{40}$/.test(p)));
    writeFileSync(join(d, 'f.bin'), Buffer.from([0x81])); g('commit', '-qam', 'byte');
    assert.equal(atomStale(a, 'HEAD', d, git), 'its file changed since it was verified');
    const b = { ...a, prints: refPrints(refs, 'HEAD', d, git) };
    writeFileSync(join(d, 'e.txt'), 'fixture'); g('commit', '-qam', 'no newline');
    assert.equal(atomStale(b, 'HEAD', d, git), 'its file changed since it was verified');
  } finally { rmSync(d, { recursive: true, force: true }); }
  assert.equal(symbolDefined('let value = 4;\nconst ratio = value++ / 2;\nexport const example = `\nexport function ghost() {}\n`;\n', 'ghost'), false);
  assert.equal(symbolDefined('const r = /unclosed\nexport function ghost() {}\n', 'ghost'), null);
  // Destructuring: key, alias or binding is not decided by pattern matching — unknown.
  assert.equal(symbolDefined('export const { tenantScoped } = { tenantScoped: () => true };\n', 'tenantScoped'), null);
  assert.equal(symbolDefined('import { helpers } from "./h.ts";\nexport const { tenantScoped: localHelper } = helpers;\n', 'tenantScoped'), null);
  assert.equal(symbolDefined('export const {\n  a = 1,\n  tenantScoped,\n} = x;\n', 'tenantScoped'), null);
  assert.equal(symbolDefined('export const { a } = x;\n', 'tenantScoped'), false);
  assert.equal(symbolDefined('import { helpers } from "./h.ts";\nexport const {\n  tenantScoped: localHelper,\n} = helpers;\n', 'tenantScoped'), null);
  assert.equal(symbolDefined('export const {\n  tenantScoped = () => true,\n} = x;\n', 'tenantScoped'), null);
  assert.equal(symbolDefined('export const {\n  a,\n} = x;\nexport function tenantScoped() {}\n', 'tenantScoped'), true);
  assert.equal(symbolDefined('export function tenantScoped$() { return true; }\n', 'tenantScoped$'), true);
  assert.equal(symbolDefined('export function tenantScoped$() {}\n', 'tenantScoped'), false);
});
