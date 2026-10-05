import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { candidateMap, specIdentifiers, pickAtoms, recap, parsePointer, renderContext, refsHold, type Atom } from '../lib/context.ts';
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
    assert.match(refsHold([{ path: 'src/queue.ts', symbol: 'gone' }], 'HEAD', d, git)!, /gone is not in src\/queue.ts/);
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

test('recap: short feedback passes; long feedback keeps every failure line, bounded, and points to the full file', () => {
  assert.equal(recap('FAILED a: short', '/f.md', 100), 'FAILED a: short');
  const long = ['FAILED tenant check: ' + 'e'.repeat(500), 'continuation detail '.repeat(20), 'BLOCKING: idempotence breaks on replay', 'CHEATING: assertion removed'].join('\n');
  const r = recap(long, '/runs/a/1-previous-feedback.md', 300, 100);
  const lines = r.split('\n');
  assert.match(lines[0]!, /^FAILED tenant check: e+… \[421 more characters\]$/);
  assert.equal(lines[1], 'BLOCKING: idempotence breaks on replay'); assert.equal(lines[2], 'CHEATING: assertion removed');
  assert.match(r, /The full feedback \(\d+ more characters of detail\) is in \/runs\/a\/1-previous-feedback.md/);
});

test('parsePointer and parseAtomCheck: bounded, repository-relative, malformed is absent', () => {
  assert.deepEqual(parsePointer({ text: 'Reuse codedErrorHandler.', refs: [{ path: 'apps/api/coded.ts', symbol: 'codedErrorHandler' }, { path: '/etc/passwd' }, { path: '../x' }], scope: ['apps/api/', 'a'] }),
    { text: 'Reuse codedErrorHandler.', refs: [{ path: 'apps/api/coded.ts', symbol: 'codedErrorHandler' }], scope: ['apps/api/'] });
  assert.equal(parsePointer({ text: 'x', refs: [], scope: ['apps/'] }), null); assert.equal(parsePointer('nope'), null);
  assert.deepEqual(parseAtomCheck('{"accurate": true, "applies": false, "reason": "one-off"}'), { ok: false, reason: 'one-off' });
  assert.equal(parseAtomCheck('{"accurate": "yes"}'), null);
});
